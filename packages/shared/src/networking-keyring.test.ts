import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NetworkingKeyring, NetworkingKeyringError, networkingKeyring } from "./networking-keyring";

const legacy = "legacy-networking-secret-at-least-32-chars";
const k1 = "k1-networking-secret-at-least-32-characters";
const k2 = "k2-networking-secret-at-least-32-characters";
const legacyHmac = (value: string) => createHmac("sha256", legacy).update(value).digest("hex");
function legacySeal(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(legacy).digest(), iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

describe("NetworkingKeyring", () => {
  it("keeps the exact legacy formats while only the legacy key exists or the write flag is off", () => {
    for (const keyring of [
      new NetworkingKeyring({ legacySecret: legacy }),
      new NetworkingKeyring({ legacySecret: legacy, keys: [{ kid: "k1", secret: k1 }], writeV1: false }),
    ]) {
      expect(keyring.writesV1).toBe(false);
      expect(keyring.mac("session", "token")).toBe(legacyHmac("token"));
      expect(keyring.open(keyring.seal("123456"))).toBe("123456");
      expect(keyring.seal("123456")).not.toMatch(/^v1:/);
      expect(keyring.isCurrent(legacyHmac("x"))).toBe(true);
    }
    // A legacy value from before the keyring opens with the same derivation.
    expect(new NetworkingKeyring({ legacySecret: legacy }).open(legacySeal("654321"))).toBe("654321");
  });

  it("writes v1:<kid> with per-purpose subkeys once the flag is on, and still reads legacy values", () => {
    const keyring = new NetworkingKeyring({ legacySecret: legacy, keys: [{ kid: "k1", secret: k1 }], writeV1: true });
    const session = keyring.mac("session", "token");
    expect(session).toMatch(/^v1:k1:[0-9a-f]{64}$/);
    expect(keyring.mac("badge", "token")).not.toBe(session);
    expect(keyring.verifyMac("session", "token", session)).toBe(true);
    expect(keyring.verifyMac("badge", "token", session)).toBe(false);
    expect(keyring.verifyMac("session", "token", legacyHmac("token"))).toBe(true);
    expect(keyring.verifyMac("session", "other", legacyHmac("token"))).toBe(false);
    expect(keyring.isCurrent(session)).toBe(true);
    expect(keyring.isCurrent(legacyHmac("token"))).toBe(false);
    const sealed = keyring.seal("123456");
    expect(sealed).toMatch(/^v1:k1:[^.]+\.[^.]+\.[^.]+$/);
    expect(keyring.open(sealed)).toBe("123456");
    expect(keyring.open(legacySeal("654321"))).toBe("654321");
    // Session lookup: the current hash first, then every older form.
    const candidates = keyring.macCandidates("session", "token");
    expect(candidates[0]).toBe(session);
    expect(candidates).toContain(legacyHmac("token"));
    expect(candidates.some((value) => value.startsWith("v1:legacy:"))).toBe(true);
  });

  it("writes v1 with the legacy key when it is the only key but the flag is on", () => {
    const keyring = new NetworkingKeyring({ legacySecret: legacy, writeV1: true });
    expect(keyring.mac("otp", "x")).toMatch(/^v1:legacy:/);
    expect(keyring.open(keyring.seal("1"))).toBe("1");
  });

  it("rejects values from a key that is not in the keyring, or tampered values", () => {
    const old = new NetworkingKeyring({ keys: [{ kid: "k1", secret: k1 }] });
    const next = new NetworkingKeyring({ keys: [{ kid: "k2", secret: k2 }] });
    expect(next.verifyMac("session", "token", old.mac("session", "token"))).toBe(false);
    expect(() => next.open(old.seal("1"))).toThrow(NetworkingKeyringError);
    const sealed = old.seal("123456");
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");
    expect(() => old.open(tampered)).toThrow(NetworkingKeyringError);
    expect(() => old.open("not-a-seal")).toThrow(NetworkingKeyringError);
    expect(old.verifyMac("session", "token", "v1:k1:short")).toBe(false);
  });

  it("rejects a seal whose GCM tag is truncated, even to a valid prefix", () => {
    const truncate = (sealed: string, prefix = "") => {
      const [iv, tag, body] = sealed.slice(prefix.length).split(".");
      const short = Buffer.from(tag!, "base64url").subarray(0, 4).toString("base64url");
      return `${prefix}${iv}.${short}.${body}`;
    };
    const v1 = new NetworkingKeyring({ keys: [{ kid: "k1", secret: k1 }] });
    const sealed = v1.seal("123456");
    expect(v1.open(sealed)).toBe("123456");
    expect(() => v1.open(truncate(sealed, "v1:k1:"))).toThrow(NetworkingKeyringError);
    const old = new NetworkingKeyring({ legacySecret: legacy });
    const legacySealed = legacySeal("654321");
    expect(old.open(legacySealed)).toBe("654321");
    expect(() => old.open(truncate(legacySealed))).toThrow(NetworkingKeyringError);
  });

  it("uses a recovery-only key for recovery codes and nothing else", () => {
    const before = new NetworkingKeyring({ legacySecret: legacy });
    const code = before.mac("recovery", "recovery:p:ABCD");
    const badge = before.mac("badge", "badge:payload");
    const sealed = before.seal("secret");
    const after = new NetworkingKeyring({
      keys: [{ kid: "k1", secret: k1 }, { kid: "legacy", secret: legacy, recoveryOnly: true }],
    });
    expect(after.writesV1).toBe(true);
    expect(after.verifyMac("recovery", "recovery:p:ABCD", code)).toBe(true);
    expect(after.verifyMac("badge", "badge:payload", badge)).toBe(false);
    expect(() => after.open(sealed)).toThrow(NetworkingKeyringError);
    expect(after.macCandidates("session", "t")).toEqual([after.mac("session", "t")]);
    expect(after.kids()).toEqual([{ kid: "k1", recoveryOnly: false }, { kid: "legacy", recoveryOnly: true }]);
  });

  it("refuses ambiguous or unusable key sets and reports an unconfigured keyring", () => {
    expect(() => new NetworkingKeyring({ legacySecret: legacy, keys: [{ kid: "legacy", secret: legacy }] })).toThrow("not both");
    expect(() => new NetworkingKeyring({ keys: [{ kid: "k1", secret: k1 }, { kid: "k1", secret: k2 }] })).toThrow("twice");
    expect(() => new NetworkingKeyring({ keys: [{ kid: "k1", secret: k1, recoveryOnly: true }] })).toThrow("recovery-only");
    const empty = new NetworkingKeyring({});
    expect(empty.configured).toBe(false);
    expect(() => empty.mac("session", "t")).toThrow("not configured");
    expect(NetworkingKeyring.kidOf("v1:k9:abc")).toBe("k9");
    expect(NetworkingKeyring.kidOf("abc")).toBe("legacy");
  });

  it("reuses one keyring per configuration", () => {
    const options = { legacySecret: legacy, keys: [{ kid: "k1", secret: k1 }], writeV1: true };
    expect(networkingKeyring(options)).toBe(networkingKeyring({ ...options, keys: [...options.keys] }));
    expect(networkingKeyring({ ...options, writeV1: false })).not.toBe(networkingKeyring(options));
  });
});
