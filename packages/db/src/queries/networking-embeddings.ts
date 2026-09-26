import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../client";
import { rowsOf } from "../helpers";
import { withTxn } from "../txn";
import { networkingProfiles } from "../schema/networking";
import { registrations } from "../schema/registrations";
import { discoverableCounterpart, notInteracted } from "../policy/networking-eligibility";
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
  await getDb()
    .execute(sql`UPDATE networking_embedding_jobs SET status='FAILED',locked_until=NULL,lock_token=NULL,last_error='Embedding retry limit reached',updated_at=now()
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
    if (input.embeddings?.length) {
      await db
        .insert(networkingEmbeddings)
        .values(
          input.embeddings.map((vector) => ({
            profileId: input.profileId,
            eventId: input.eventId,
            kind: vector.kind,
            model: input.model,
            sourceHash: input.sourceHash,
            embedding: vector.embedding,
          })),
        )
        .onConflictDoUpdate({
          target: [
            networkingEmbeddings.profileId,
            networkingEmbeddings.kind,
            networkingEmbeddings.model,
          ],
          set: {
            sourceHash: sql`excluded.source_hash`,
            embedding: sql`excluded.embedding`,
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

export {
  clearNetworkingVectorIndexCache,
  findNetworkingVectorCandidates,
  getNetworkingVectorIndexHealth,
  NETWORKING_VECTOR_INDEX,
  networkingVectorIndexPresent,
  networkingVectorIndexStatus,
  rankNetworkingVectorCandidates,
  type NetworkingVectorCandidate,
  type NetworkingVectorIndexHealth,
  type NetworkingVectorIndexStatus,
} from "./networking-vector-search";

/** Withdrawn profiles are left out: their embeddings and job are deleted at withdrawal. */
export async function getNetworkingEmbeddingHealth(eventId: string) {
  return rowsOf<{ status: string; count: number }>(
    await getDb().execute(
      sql`SELECT coalesce(j.status,'PENDING') AS status,count(*)::int AS count FROM networking_profiles p LEFT JOIN networking_embedding_jobs j ON j.profile_id=p.id WHERE p.event_id=${eventId} AND p.withdrawn_at IS NULL GROUP BY coalesce(j.status,'PENDING')`,
    ),
  );
}

/** The recommended profiles the caller may still discover (4.6: counterpart `discover` mode, not yet swiped or connected). */
export async function getNetworkingRecommendationProfiles(
  eventId: string,
  ids: string[],
  callerProfileId: string,
  paymentStatuses: readonly string[],
) {
  if (!ids.length || !paymentStatuses.length) return [];
  return getDb()
    .select(getTableColumns(networkingProfiles))
    .from(networkingProfiles)
    .innerJoin(registrations, eq(registrations.id, networkingProfiles.registrationId))
    .where(
      and(
        eq(networkingProfiles.eventId, eventId),
        inArray(networkingProfiles.id, ids),
        discoverableCounterpart(networkingProfiles, registrations, paymentStatuses, { eventId, profileId: callerProfileId }),
        notInteracted(eventId, callerProfileId, networkingProfiles.id),
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
