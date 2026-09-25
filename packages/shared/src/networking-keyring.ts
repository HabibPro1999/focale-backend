import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Networking keyring (plan 4.5). Every networking MAC and seal names the key
 * that produced it, so keys can rotate without logging everyone out:
 *
 * - v1 values are `v1:<kid>:<payload>`, keyed by an HKDF subkey per purpose;
 * - unversioned values are the legacy format, keyed directly by the `legacy`
 *   secret (NETWORKING_TOKEN_SECRET), and stay readable.
 *
 * Writes use v1 with the current (first) key once NETWORKING_KEYRING_WRITE_V1
 * is on, or when there is no legacy secret; otherwise they keep the legacy
 * format, so a rollback to a build without the keyring can still read them.
 * A recovery-only key verifies recovery codes and nothing else.
 */
export const NETWORKING_KEY_PURPOSES = ["session", "otp", "badge", "seal", "recovery"] as const;
export type NetworkingKeyPurpose = (typeof NETWORKING_KEY_PURPOSES)[number];
export const NETWORKING_LEGACY_KID = "legacy";

export interface NetworkingKeyringKey {
  kid: string;
  secret: string;
  recoveryOnly?: boolean;
}
export interface NetworkingKeyringOptions {
  /** NETWORKING_KEYS, first entry current. */
  keys?: readonly NetworkingKeyringKey[];
  /** NETWORKING_TOKEN_SECRET: the `legacy` key. */
  legacySecret?: string;
  /** NETWORKING_KEYRING_WRITE_V1. */
  writeV1?: boolean;
}

export class NetworkingKeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkingKeyringError";
  }
}

const V1 = /^v1:([a-z0-9][a-z0-9_-]{0,15}):(.+)$/s;
const SUBKEY_SALT = "focale-networking-keyring";

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class NetworkingKeyring {
  private readonly keys = new Map<string, { secret: string; recoveryOnly: boolean }>();
  private readonly subkeys = new Map<string, Buffer>();
  /** The key new v1 values use: the first NETWORKING_KEYS entry, else `legacy`. */
  readonly currentKid: string | undefined;
  /** False while writes keep the legacy format (flag off and a legacy secret exists). */
  readonly writesV1: boolean;

  constructor(options: NetworkingKeyringOptions) {
    for (const key of options.keys ?? []) {
      if (this.keys.has(key.kid)) throw new NetworkingKeyringError(`Networking key ${key.kid} is listed twice`);
      this.keys.set(key.kid, { secret: key.secret, recoveryOnly: !!key.recoveryOnly });
    }
    if (options.legacySecret) {
      if (this.keys.has(NETWORKING_LEGACY_KID))
        throw new NetworkingKeyringError("Set the legacy key either as NETWORKING_TOKEN_SECRET or in NETWORKING_KEYS, not both");
      this.keys.set(NETWORKING_LEGACY_KID, { secret: options.legacySecret, recoveryOnly: false });
    }
    this.currentKid = options.keys?.[0]?.kid ?? (options.legacySecret ? NETWORKING_LEGACY_KID : undefined);
    if (this.currentKid && this.keys.get(this.currentKid)?.recoveryOnly)
      throw new NetworkingKeyringError("The current networking key cannot be recovery-only");
    const legacy = this.keys.get(NETWORKING_LEGACY_KID);
    this.writesV1 = !!options.writeV1 || !legacy || legacy.recoveryOnly;
  }

  get configured(): boolean {
    return this.currentKid !== undefined;
  }

  /** Key ids and whether each is kept for recovery codes only. */
  kids(): { kid: string; recoveryOnly: boolean }[] {
    return [...this.keys].map(([kid, key]) => ({ kid, recoveryOnly: key.recoveryOnly }));
  }

  /** Key id of a stored MAC or seal: `legacy` for unversioned values. */
  static kidOf(stored: string): string {
    return V1.exec(stored)?.[1] ?? NETWORKING_LEGACY_KID;
  }

  /** True when `stored` is in the format new writes use (nothing to rehash/reseal). */
  isCurrent(stored: string): boolean {
    const match = V1.exec(stored);
    return this.writesV1 ? match?.[1] === this.currentKid : !match;
  }

  private key(kid: string, purpose: NetworkingKeyPurpose) {
    const key = this.keys.get(kid);
    if (!key || (key.recoveryOnly && purpose !== "recovery")) return undefined;
    return key.secret;
  }

  private subkey(kid: string, purpose: NetworkingKeyPurpose): Buffer {
    const cacheKey = `${kid}\u0000${purpose}`;
    let subkey = this.subkeys.get(cacheKey);
    if (!subkey) {
      const secret = this.key(kid, purpose);
      if (secret === undefined) throw new NetworkingKeyringError(`Networking key ${kid} is not available for ${purpose}`);
      subkey = Buffer.from(hkdfSync("sha256", secret, SUBKEY_SALT, `networking:${purpose}`, 32));
      this.subkeys.set(cacheKey, subkey);
    }
    return subkey;
  }

  private requireConfigured(): string {
    if (!this.currentKid) throw new NetworkingKeyringError("Networking keys are not configured");
    return this.currentKid;
  }

  /** MAC for a new value, in the current write format. */
  mac(purpose: NetworkingKeyPurpose, value: string): string {
    const kid = this.requireConfigured();
    if (!this.writesV1) return hmacHex(this.keys.get(NETWORKING_LEGACY_KID)!.secret, value);
    return `v1:${kid}:${hmacHex(this.subkey(kid, purpose), value)}`;
  }

  /**
   * Every MAC a stored value could have under the keys usable for `purpose`,
   * current format first: session lookup matches any of them, then rehashes.
   */
  macCandidates(purpose: NetworkingKeyPurpose, value: string): string[] {
    const current = this.mac(purpose, value);
    const candidates = new Set([current]);
    for (const [kid] of this.keys) {
      if (this.key(kid, purpose) === undefined) continue;
      candidates.add(`v1:${kid}:${hmacHex(this.subkey(kid, purpose), value)}`);
      if (kid === NETWORKING_LEGACY_KID) candidates.add(hmacHex(this.key(kid, purpose)!, value));
    }
    return [...candidates];
  }

  /** Timing-safe check of a stored MAC with the key it names. */
  verifyMac(purpose: NetworkingKeyPurpose, value: string, stored: string): boolean {
    const match = V1.exec(stored);
    const kid = match?.[1] ?? NETWORKING_LEGACY_KID;
    const secret = this.key(kid, purpose);
    if (secret === undefined) return false;
    const expected = match ? `v1:${kid}:${hmacHex(this.subkey(kid, purpose), value)}` : hmacHex(secret, value);
    return sameText(expected, stored);
  }

  /** AES-256-GCM seal of a secret (OTP codes, authenticator secrets). */
  seal(plaintext: string): string {
    const kid = this.requireConfigured();
    const key = this.writesV1
      ? this.subkey(kid, "seal")
      : createHash("sha256").update(this.keys.get(NETWORKING_LEGACY_KID)!.secret).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const body = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
    return this.writesV1 ? `v1:${kid}:${body}` : body;
  }

  /** Opens a v1 or legacy seal; throws NetworkingKeyringError when its key is missing or the seal is invalid. */
  open(sealed: string): string {
    const match = V1.exec(sealed);
    const kid = match?.[1] ?? NETWORKING_LEGACY_KID;
    const secret = this.key(kid, "seal");
    if (secret === undefined) throw new NetworkingKeyringError(`Networking key ${kid} is not available for seal`);
    const parts = (match?.[2] ?? sealed).split(".");
    if (parts.length !== 3) throw new NetworkingKeyringError("Invalid sealed value");
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
    const key = match ? this.subkey(kid, "seal") : createHash("sha256").update(secret).digest();
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv!);
      decipher.setAuthTag(tag!);
      return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf8");
    } catch {
      throw new NetworkingKeyringError("Invalid sealed value");
    }
  }
}

let cached: { signature: string; keyring: NetworkingKeyring } | undefined;
/** One keyring per distinct configuration (subkeys are derived once). */
export function networkingKeyring(options: NetworkingKeyringOptions): NetworkingKeyring {
  const signature = createHash("sha256")
    .update(JSON.stringify([options.legacySecret ?? null, options.keys ?? [], !!options.writeV1]))
    .digest("hex");
  if (cached?.signature !== signature) cached = { signature, keyring: new NetworkingKeyring(options) };
  return cached.keyring;
}
