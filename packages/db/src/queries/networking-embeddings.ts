import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../client";
import { rowsOf } from "../helpers";
import { withTxn } from "../txn";
import { networkingProfiles } from "../schema/networking";
import {
  networkingEmbeddings,
  networkingEmbeddingJobs,
} from "../schema/networking-embeddings";

/** Reconcile a bounded batch. Profile activity changes advance the watermark without re-embedding unchanged text. */
export async function enqueueChangedNetworkingEmbeddings(
  model: string,
  limit = 100,
): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO networking_embedding_jobs (profile_id,status,available_at,created_at,updated_at)
    SELECT p.id,'PENDING',now(),now(),now()
    FROM networking_profiles p
    JOIN networking_configs c ON c.event_id=p.event_id
    JOIN registrations r ON r.id=p.registration_id AND r.event_id=p.event_id
    JOIN events ev ON ev.id=p.event_id
    JOIN clients cl ON cl.id=ev.client_id
    LEFT JOIN networking_embedding_jobs j ON j.profile_id=p.id
    WHERE p.status='ACTIVE' AND p.visible AND p.consent AND p.withdrawn_at IS NULL
      AND c.config->>'enabled'='true' AND cl.active AND ev.status<>'ARCHIVED'
      AND 'networking'=ANY(cl.enabled_modules) AND 'registrations'=ANY(cl.enabled_modules) AND 'emails'=ANY(cl.enabled_modules)
      AND r.networking_opt_in IS DISTINCT FROM false
      AND r.payment_status::text IN (SELECT jsonb_array_elements_text(c.config->'eligiblePaymentStatuses'))
      AND (j.profile_id IS NULL OR (j.status='READY' AND (j.indexed_profile_at < p.updated_at OR j.model <> ${model})))
    ORDER BY p.updated_at ASC LIMIT ${limit}
    ON CONFLICT (profile_id) DO UPDATE SET status='PENDING',available_at=now(),attempts=0,updated_at=now()
    WHERE networking_embedding_jobs.status='READY'
  `);
}

export async function claimNetworkingEmbeddingJobs(limit = 10) {
  await getDb().execute(sql`UPDATE networking_embedding_jobs SET status='FAILED',locked_until=NULL,lock_token=NULL,last_error='Embedding retry limit reached',updated_at=now()
    WHERE status='PROCESSING' AND locked_until<now() AND attempts>=5`);
  const lockToken = randomUUID();
  const claimed = rowsOf<{
    profile_id: string;
    source_hash: string | null;
    model: string | null;
  }>(
    await getDb().execute(sql`
    WITH candidates AS (
      SELECT j.profile_id FROM networking_embedding_jobs j
      JOIN networking_profiles p ON p.id=j.profile_id
      JOIN networking_configs c ON c.event_id=p.event_id
      JOIN registrations r ON r.id=p.registration_id AND r.event_id=p.event_id
      JOIN events ev ON ev.id=p.event_id
      JOIN clients cl ON cl.id=ev.client_id
      WHERE (j.status='PENDING' OR (j.status='PROCESSING' AND j.locked_until < now()) OR (j.status='FAILED' AND j.attempts < 5))
        AND j.attempts < 5 AND j.available_at <= now() AND p.status='ACTIVE' AND p.visible AND p.consent AND p.withdrawn_at IS NULL
        AND c.config->>'enabled'='true' AND cl.active AND ev.status<>'ARCHIVED'
        AND 'networking'=ANY(cl.enabled_modules) AND 'registrations'=ANY(cl.enabled_modules) AND 'emails'=ANY(cl.enabled_modules) AND r.networking_opt_in IS DISTINCT FROM false
        AND r.payment_status::text IN (SELECT jsonb_array_elements_text(c.config->'eligiblePaymentStatuses'))
      ORDER BY j.available_at LIMIT ${limit} FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE networking_embedding_jobs j
    SET status='PROCESSING',locked_until=now()+interval '2 minutes',lock_token=${lockToken},attempts=attempts+1,updated_at=now()
    FROM candidates WHERE j.profile_id=candidates.profile_id RETURNING j.profile_id,j.source_hash,j.model
  `),
  );
  if (!claimed.length) return [];
  const profiles = await getDb()
    .select()
    .from(networkingProfiles)
    .where(
      inArray(
        networkingProfiles.id,
        claimed.map((row) => row.profile_id),
      ),
    );
  return profiles.map((profile) => ({
    profile,
    lockToken,
    previous: claimed.find((row) => row.profile_id === profile.id)!,
  }));
}

export async function saveNetworkingEmbeddings(input: {
  profileId: string;
  eventId: string;
  lockToken: string;
  model: string;
  sourceHash: string;
  indexedProfileAt: Date;
  embeddings?: Array<{
    kind: "PROFILE" | "OFFER" | "NEED";
    embedding: number[];
  }>;
}): Promise<boolean> {
  return withTxn(async (db) => {
    const lease = rowsOf(
      await db.execute(
        sql`SELECT profile_id FROM networking_embedding_jobs WHERE profile_id=${input.profileId} AND lock_token=${input.lockToken} AND status='PROCESSING' FOR UPDATE`,
      ),
    );
    if (!lease.length) return false;
    for (const vector of input.embeddings ?? []) {
      await db
        .insert(networkingEmbeddings)
        .values({
          profileId: input.profileId,
          eventId: input.eventId,
          kind: vector.kind,
          model: input.model,
          sourceHash: input.sourceHash,
          embedding: vector.embedding,
        })
        .onConflictDoUpdate({
          target: [
            networkingEmbeddings.profileId,
            networkingEmbeddings.kind,
            networkingEmbeddings.model,
          ],
          set: {
            sourceHash: input.sourceHash,
            embedding: vector.embedding,
            updatedAt: new Date(),
          },
        });
    }
    await db
      .update(networkingEmbeddingJobs)
      .set({
        status: "READY",
        model: input.model,
        sourceHash: input.sourceHash,
        indexedProfileAt: input.indexedProfileAt,
        lockedUntil: null,
        lockToken: null,
        lastError: null,
        attempts: 0,
      })
      .where(
        and(
          eq(networkingEmbeddingJobs.profileId, input.profileId),
          eq(networkingEmbeddingJobs.lockToken, input.lockToken),
        ),
      );
    return true;
  });
}

export async function failNetworkingEmbeddingJob(
  profileId: string,
  lockToken: string,
): Promise<void> {
  // Error text is deliberately fixed: provider response bodies can contain profile data.
  await getDb().execute(
    sql`UPDATE networking_embedding_jobs SET status='FAILED',locked_until=NULL,lock_token=NULL,last_error='Embedding generation failed',available_at=now()+interval '1 minute'*least(15,power(2,attempts)),updated_at=now() WHERE profile_id=${profileId} AND lock_token=${lockToken}`,
  );
}

export interface NetworkingVectorCandidate {
  profileId: string;
  score: number;
  needsScore: number;
  offersScore: number;
  profileScore: number;
}

/** Exact vector distance within an event; hard SQL filters apply before ranking and never rely on the model. */
export async function findNetworkingVectorCandidates(
  eventId: string,
  profileId: string,
  model: string,
  paymentStatuses: readonly string[],
  limit = 60,
): Promise<NetworkingVectorCandidate[] | null> {
  if (!paymentStatuses.length) return [];
  const db = getDb();
  const [ready] = await db
    .select()
    .from(networkingEmbeddingJobs)
    .where(
      and(
        eq(networkingEmbeddingJobs.profileId, profileId),
        eq(networkingEmbeddingJobs.model, model),
        eq(networkingEmbeddingJobs.status, "READY"),
      ),
    );
  if (!ready) return null;
  const rows = rowsOf<{
    profile_id: string;
    score: number;
    needs_score: number;
    offers_score: number;
    profile_score: number;
  }>(
    await db.execute(sql`
    WITH source AS (
      SELECT p.id,p.email,p.offers,p.seeks,pe.embedding AS profile,oe.embedding AS offer,ne.embedding AS need
      FROM networking_profiles p
      JOIN networking_embeddings pe ON pe.profile_id=p.id AND pe.kind='PROFILE' AND pe.model=${model}
      JOIN networking_embeddings oe ON oe.profile_id=p.id AND oe.kind='OFFER' AND oe.model=pe.model AND oe.source_hash=pe.source_hash
      JOIN networking_embeddings ne ON ne.profile_id=p.id AND ne.kind='NEED' AND ne.model=pe.model AND ne.source_hash=pe.source_hash
      WHERE p.id=${profileId} AND p.event_id=${eventId}
    ), scores AS (
      SELECT p.id AS profile_id,
        CASE WHEN length(trim(source.seeks))>0 AND length(trim(p.offers))>0 THEN greatest(0,1-(source.need <=> oe.embedding)) ELSE 0 END AS needs_score,
        CASE WHEN length(trim(source.offers))>0 AND length(trim(p.seeks))>0 THEN greatest(0,1-(source.offer <=> ne.embedding)) ELSE 0 END AS offers_score,
        greatest(0,1-(source.profile <=> pe.embedding)) AS profile_score
      FROM networking_profiles p
      JOIN registrations r ON r.id=p.registration_id AND r.event_id=p.event_id
      JOIN networking_embeddings pe ON pe.profile_id=p.id AND pe.kind='PROFILE' AND pe.event_id=${eventId} AND pe.model=${model}
      JOIN networking_embeddings oe ON oe.profile_id=p.id AND oe.kind='OFFER' AND oe.model=pe.model AND oe.source_hash=pe.source_hash
      JOIN networking_embeddings ne ON ne.profile_id=p.id AND ne.kind='NEED' AND ne.model=pe.model AND ne.source_hash=pe.source_hash
      CROSS JOIN source
      WHERE p.event_id=${eventId} AND p.id<>${profileId} AND lower(p.email)<>lower(source.email) AND p.status='ACTIVE' AND p.visible AND p.consent AND p.withdrawn_at IS NULL
        AND r.networking_opt_in IS DISTINCT FROM false AND r.payment_status::text IN (${sql.join(
          paymentStatuses.map((status) => sql`${status}`),
          sql`,`,
        )})
        AND NOT EXISTS (SELECT 1 FROM networking_blocks b WHERE b.event_id=p.event_id AND ((b.profile_id=${profileId} AND b.target_id=p.id) OR (b.profile_id=p.id AND b.target_id=${profileId})))
        AND NOT EXISTS (SELECT 1 FROM networking_interests i WHERE i.event_id=p.event_id AND i.profile_id=${profileId} AND i.target_id=p.id)
        AND NOT EXISTS (SELECT 1 FROM networking_connections c WHERE c.event_id=p.event_id AND ((c.profile_a_id=${profileId} AND c.profile_b_id=p.id) OR (c.profile_b_id=${profileId} AND c.profile_a_id=p.id)))
    )
    SELECT *, (0.4*needs_score + 0.4*offers_score + 0.2*profile_score) AS score FROM scores
    ORDER BY score DESC,profile_id LIMIT ${Math.min(100, Math.max(1, limit))}
  `),
  );
  return rows.map((row) => ({
    profileId: row.profile_id,
    score: Number(row.score),
    needsScore: Number(row.needs_score),
    offersScore: Number(row.offers_score),
    profileScore: Number(row.profile_score),
  }));
}

export async function getNetworkingEmbeddingHealth(eventId: string) {
  return rowsOf<{ status: string; count: number }>(
    await getDb().execute(
      sql`SELECT coalesce(j.status,'PENDING') AS status,count(*)::int AS count FROM networking_profiles p LEFT JOIN networking_embedding_jobs j ON j.profile_id=p.id WHERE p.event_id=${eventId} GROUP BY coalesce(j.status,'PENDING')`,
    ),
  );
}

export async function getNetworkingRecommendationProfiles(
  eventId: string,
  ids: string[],
  callerProfileId: string,
  paymentStatuses: readonly string[],
) {
  if (!ids.length || !paymentStatuses.length) return [];
  return getDb()
    .select()
    .from(networkingProfiles)
    .where(
      and(
        eq(networkingProfiles.eventId, eventId),
        eq(networkingProfiles.status, "ACTIVE"),
        eq(networkingProfiles.visible, true),
        eq(networkingProfiles.consent, true),
        sql`${networkingProfiles.withdrawnAt} IS NULL`,
        sql`${networkingProfiles.id}<>${callerProfileId}`,
        sql`lower(${networkingProfiles.email})<>(SELECT lower(email) FROM networking_profiles WHERE id=${callerProfileId} AND event_id=${eventId})`,
        sql`EXISTS (SELECT 1 FROM registrations r WHERE r.id=${networkingProfiles.registrationId} AND r.event_id=${eventId}
          AND r.networking_opt_in IS DISTINCT FROM false AND r.payment_status::text IN (${sql.join(paymentStatuses.map(status => sql`${status}`),sql`,`)}))`,
        sql`NOT EXISTS (SELECT 1 FROM networking_blocks b WHERE b.event_id=${eventId}
          AND ((b.profile_id=${callerProfileId} AND b.target_id=${networkingProfiles.id}) OR (b.target_id=${callerProfileId} AND b.profile_id=${networkingProfiles.id})))`,
        inArray(networkingProfiles.id, ids),
      ),
    );
}

/** Explicit administrator retry/reindex; keep live leases owned by their existing worker. */
export async function reindexNetworkingEvent(eventId: string): Promise<number> {
  const rows = rowsOf(
    await getDb().execute(sql`
    INSERT INTO networking_embedding_jobs (profile_id,status,available_at,created_at,updated_at)
    SELECT p.id,'PENDING',now(),now(),now() FROM networking_profiles p
    JOIN registrations r ON r.id=p.registration_id AND r.event_id=p.event_id
    JOIN networking_configs c ON c.event_id=p.event_id
    WHERE p.event_id=${eventId} AND p.status='ACTIVE' AND p.consent AND p.visible AND p.withdrawn_at IS NULL
      AND r.networking_opt_in IS DISTINCT FROM false
      AND r.payment_status::text IN (SELECT jsonb_array_elements_text(c.config->'eligiblePaymentStatuses'))
    ON CONFLICT (profile_id) DO UPDATE SET status='PENDING',source_hash=NULL,attempts=0,last_error=NULL,available_at=now(),locked_until=NULL,lock_token=NULL,updated_at=now()
    WHERE networking_embedding_jobs.status<>'PROCESSING' OR networking_embedding_jobs.locked_until<now()
    RETURNING profile_id
  `),
  );
  return rows.length;
}
