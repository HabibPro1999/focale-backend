/**
 * NETWORKING_KEYS: comma-separated `kid:key` entries, the first one current
 * (it signs and seals new values once NETWORKING_KEYRING_WRITE_V1=true).
 * `kid:key:recovery` keeps a retired key only to verify recovery codes that
 * still reference it. The kid `legacy` names the key for unversioned values
 * (normally NETWORKING_TOKEN_SECRET; use it here only with that variable unset).
 */
export interface NetworkingKeyEntry {
  kid: string;
  secret: string;
  /** Retired except for verifying existing recovery codes. */
  recoveryOnly: boolean;
}

export const NETWORKING_LEGACY_KID = "legacy";
export const NETWORKING_KEY_MIN_LENGTH = 32;
const KID = /^[a-z0-9][a-z0-9_-]{0,15}$/;

export function parseNetworkingKeys(value: string): NetworkingKeyEntry[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error("NETWORKING_KEYS must list at least one kid:key entry");
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const [kid = "", secret = "", flag, ...extra] = entry.split(":");
    if (!KID.test(kid))
      throw new Error(`NETWORKING_KEYS entry ${index + 1}: kid must be 1-16 lowercase letters, digits, _ or -`);
    if (seen.has(kid)) throw new Error(`NETWORKING_KEYS: kid ${kid} is listed twice`);
    seen.add(kid);
    if (secret.length < NETWORKING_KEY_MIN_LENGTH)
      throw new Error(`NETWORKING_KEYS entry ${kid}: key must be at least ${NETWORKING_KEY_MIN_LENGTH} characters`);
    if (extra.length || (flag !== undefined && flag !== "recovery"))
      throw new Error(`NETWORKING_KEYS entry ${kid}: use kid:key or kid:key:recovery`);
    const recoveryOnly = flag === "recovery";
    if (index === 0 && recoveryOnly)
      throw new Error("NETWORKING_KEYS: the first (current) key cannot be recovery-only");
    return { kid, secret, recoveryOnly };
  });
}
