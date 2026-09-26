import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { NetworkingKeyring, NetworkingKeyringError, NETWORKING_LEGACY_KID } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";
import { networkingSecondFactors } from "../schema/networking-mfa";

/**
 * What still references each networking key (plan 4.5). Stored MACs and seals
 * start with `v1:<kid>:`; anything else belongs to the `legacy` key.
 *
 * - `session`: live (unrevoked, unexpired) session token hashes; they move to
 *   the current key when used, and expire within 30 days otherwise.
 * - `seal`: authenticator secrets (active and pending); `reseal` moves them.
 * - `otp`: unsent OTP deliveries (sealed codes, minutes-long).
 * - `recovery`: unused recovery codes. Only hashes are stored, so they cannot
 *   be resealed: the key must stay (at least as recovery-only) until the
 *   participant uses them or regenerates them.
 */
export type NetworkingKeyUse = "session" | "seal" | "otp" | "recovery";
export interface NetworkingKeyUsage {
  use: NetworkingKeyUse;
  kid: string;
  count: number;
}

const kidOf = (column: ReturnType<typeof sql>) =>
  sql`CASE WHEN ${column} LIKE 'v1:%' THEN split_part(${column}, ':', 2) ELSE ${NETWORKING_LEGACY_KID} END`;

export async function networkingKeyUsage(db: Pick<DbExecutor, "execute"> = getDb()): Promise<NetworkingKeyUsage[]> {
  const rows = rowsOf<{ use: NetworkingKeyUse; kid: string; count: number | string }>(
    await db.execute(sql`
    SELECT 'session' AS use, ${kidOf(sql`token_hash`)} AS kid, count(*) AS count
      FROM networking_sessions WHERE revoked_at IS NULL AND expires_at > now() GROUP BY 2
    UNION ALL
    SELECT 'seal', ${kidOf(sql`sealed`)}, count(*) FROM (
      SELECT encrypted_secret AS sealed FROM networking_second_factors WHERE encrypted_secret IS NOT NULL
      UNION ALL
      SELECT pending_encrypted_secret FROM networking_second_factors WHERE pending_encrypted_secret IS NOT NULL
    ) secrets GROUP BY 2
    UNION ALL
    SELECT 'otp', ${kidOf(sql`(payload->>'encryptedCode')`)}, count(*) FROM networking_deliveries
      WHERE type = 'OTP' AND status IN ('PENDING', 'PROCESSING', 'FAILED') AND payload ? 'encryptedCode' GROUP BY 2
    UNION ALL
    SELECT 'recovery', ${kidOf(sql`code`)}, count(*) FROM (
      SELECT jsonb_array_elements_text(recovery_hashes) AS code FROM networking_second_factors
    ) codes GROUP BY 2
  `),
  );
  return rows
    .map((row) => ({ use: row.use, kid: row.kid, count: Number(row.count) }))
    .sort((a, b) => a.use.localeCompare(b.use) || a.kid.localeCompare(b.kid));
}

/**
 * Why `kid` cannot be removed from the keyring yet (empty: it can). With
 * `keepRecovery`, the key stays as `kid:key:recovery`, so only its recovery
 * codes may remain.
 */
export function networkingKeyRetirementBlockers(
  usage: readonly NetworkingKeyUsage[],
  kid: string,
  options: { currentKid?: string; keepRecovery?: boolean } = {},
): string[] {
  const blockers: string[] = [];
  if (kid === options.currentKid) blockers.push(`${kid} is the current key; put a new key first in NETWORKING_KEYS`);
  for (const row of usage) {
    if (row.kid !== kid || row.count === 0) continue;
    if (row.use === "recovery" && options.keepRecovery) continue;
    blockers.push({
      session: `${row.count} live sessions still use ${kid}; they move on use or expire within 30 days`,
      seal: `${row.count} authenticator secrets are sealed with ${kid}; run reseal --apply`,
      otp: `${row.count} unsent OTP codes are sealed with ${kid}; wait until they expire (minutes)`,
      recovery: `${row.count} unused recovery codes reference ${kid}; keep it as ${kid}:<key>:recovery until they are used or regenerated`,
    }[row.use]);
  }
  return blockers;
}

export interface NetworkingResealResult {
  checked: number;
  /** Resealed with the current key (or would be, on a dry run). */
  resealed: number;
  /** Sealed with a key that is not in the keyring or not openable: left unchanged. */
  unreadable: number;
}

/**
 * Re-seals authenticator secrets that are not in the current write format.
 * Dry run unless `apply`. Each row is updated only if it still holds the
 * value that was read, so a concurrent enrollment or verification wins.
 */
export async function resealNetworkingSecrets(
  keyring: NetworkingKeyring,
  db: DbExecutor,
  options: { apply?: boolean; batchSize?: number } = {},
): Promise<NetworkingResealResult> {
  const f = networkingSecondFactors;
  const batchSize = options.batchSize ?? 200;
  const result: NetworkingResealResult = { checked: 0, resealed: 0, unreadable: 0 };
  let after = "";
  for (;;) {
    const rows = await db
      .select({ profileId: f.profileId, encryptedSecret: f.encryptedSecret, pendingEncryptedSecret: f.pendingEncryptedSecret })
      .from(f)
      .where(and(gt(f.profileId, after), or(sql`${f.encryptedSecret} IS NOT NULL`, sql`${f.pendingEncryptedSecret} IS NOT NULL`)))
      .orderBy(asc(f.profileId))
      .limit(batchSize);
    if (!rows.length) return result;
    for (const row of rows) {
      for (const column of ["encryptedSecret", "pendingEncryptedSecret"] as const) {
        const sealed = row[column];
        if (sealed === null) continue;
        result.checked++;
        if (keyring.isCurrent(sealed)) continue;
        let plaintext: string;
        try {
          plaintext = keyring.open(sealed);
        } catch (error) {
          if (!(error instanceof NetworkingKeyringError)) throw error;
          result.unreadable++;
          continue;
        }
        result.resealed++;
        if (options.apply)
          await db.update(f).set({ [column]: keyring.seal(plaintext) })
            .where(and(eq(f.profileId, row.profileId), eq(f[column], sealed)));
      }
    }
    after = rows.at(-1)!.profileId;
  }
}
