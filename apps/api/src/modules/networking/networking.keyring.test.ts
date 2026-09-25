import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  factor: null as Record<string, unknown> | null,
  updates: [] as Array<{ kind: string; values: Record<string, unknown> }>,
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  networkingTransaction: async (_event: string, run: (store: unknown) => unknown) =>
    run({
      one: async (kind: string) => (kind === "secondFactors" ? state.factor : null),
      all: async () => [],
      update: async (kind: string, _where: unknown, values: Record<string, unknown>) => {
        state.updates.push({ kind, values });
        if (kind === "secondFactors") state.factor = { ...state.factor, ...values };
        return [state.factor];
      },
      insert: async () => ({}),
      remove: async () => undefined,
    }),
}));

import { NetworkingKeyring } from "@app/shared";
import { NetworkingMfaService } from "./networking.mfa.service";
import type { NetworkingContext } from "./networking.service";
import {
  issueNetworkingBadge,
  matchNetworkingRecoveryCode,
  networkingHash,
  networkingRecoveryCodesOutdated,
  networkingRecoveryHash,
  networkingSessionHashes,
  networkingTotp,
  newNetworkingTotpSecret,
  readNetworkingBadge,
  sealNetworkingCode,
} from "./networking.security";

const legacy = "legacy-networking-secret-at-least-32-chars";
const k1 = "k1-networking-secret-at-least-32-characters";
const saved = { ...process.env };
function keys(env: { TOKEN?: string; KEYS?: string; WRITE?: boolean }) {
  for (const key of ["NETWORKING_TOKEN_SECRET", "NETWORKING_KEYS", "NETWORKING_KEYRING_WRITE_V1"]) delete process.env[key];
  if (env.TOKEN) process.env.NETWORKING_TOKEN_SECRET = env.TOKEN;
  if (env.KEYS) process.env.NETWORKING_KEYS = env.KEYS;
  if (env.WRITE) process.env.NETWORKING_KEYRING_WRITE_V1 = "true";
}
const legacyOnly = () => keys({ TOKEN: legacy });
const rotated = () => keys({ TOKEN: legacy, KEYS: `k1:${k1}`, WRITE: true });
// Rollout step 4: legacy kept only for recovery codes, NETWORKING_TOKEN_SECRET unset.
const legacyRecoveryOnly = () => keys({ KEYS: `k1:${k1},legacy:${legacy}:recovery` });
afterEach(() => {
  process.env = { ...saved };
});

describe("keyring rotation (4.5)", () => {
  it("an unused legacy recovery code still verifies after rotation and after legacy is kept for recovery only", () => {
    legacyOnly();
    const hashes = ["AAAA-BBBB-CCCC-DDDD", "1111-2222-3333-4444"].map((code) => networkingRecoveryHash("p", code));
    expect(hashes[0]).not.toMatch(/^v1:/);
    expect(networkingRecoveryCodesOutdated(hashes)).toBe(false);
    rotated();
    expect(matchNetworkingRecoveryCode("p", "aaaa-bbbb-cccc-dddd", hashes)).toBe(0);
    expect(networkingRecoveryCodesOutdated(hashes)).toBe(true);
    expect(networkingRecoveryHash("p", "X")).toMatch(/^v1:k1:/);
    legacyRecoveryOnly();
    expect(matchNetworkingRecoveryCode("p", "1111222233334444", hashes)).toBe(1);
    expect(matchNetworkingRecoveryCode("p", "9999-9999-9999-9999", hashes)).toBe(-1);
  });

  it("finds a legacy session hash among the candidates, current format first", () => {
    legacyOnly();
    const stored = networkingHash("token");
    rotated();
    const [current, ...older] = networkingSessionHashes("token");
    expect(current).toMatch(/^v1:k1:/);
    expect(older).toContain(stored);
    legacyRecoveryOnly();
    expect(networkingSessionHashes("token")).not.toContain(stored);
  });

  it("verifies badges signed before rotation and rejects them once legacy is recovery-only", () => {
    legacyOnly();
    const { token } = issueNetworkingBadge("p", "e");
    rotated();
    expect(readNetworkingBadge(token, "e")).toBe("p");
    expect(issueNetworkingBadge("p", "e").token).toMatch(/\.v1:k1:[0-9a-f]{64}$/);
    expect(readNetworkingBadge(issueNetworkingBadge("p", "e").token, "e")).toBe("p");
    legacyRecoveryOnly();
    expect(() => readNetworkingBadge(token, "e")).toThrow("Invalid or expired badge");
  });

  it("answers 503 NETWORKING_AUTH_UNAVAILABLE without any key", () => {
    keys({});
    expect(() => networkingHash("token")).toThrow(expect.objectContaining({ status: 503, response: expect.objectContaining({ code: "NETWORKING_AUTH_UNAVAILABLE" }) }));
  });
});

describe("MFA with rotated keys (4.5)", () => {
  const ctx = {
    event: { id: "e" }, profile: { id: "p" }, session: { id: "s" }, config: { requireSecondFactor: false },
  } as unknown as NetworkingContext;
  let secret: string;
  beforeEach(() => {
    state.updates = [];
    legacyOnly();
    secret = newNetworkingTotpSecret();
    state.factor = {
      profileId: "p", enabledAt: new Date(), encryptedSecret: sealNetworkingCode(secret), pendingEncryptedSecret: null,
      recoveryHashes: ["AAAA-BBBB-CCCC-DDDD", "1111-2222-3333-4444"].map((code) => networkingRecoveryHash("p", code)),
      lastCounter: -1, failedAttempts: 0, lastAttemptAt: null,
    };
  });

  it("checks recovery codes before opening the authenticator secret, which a retired key can no longer open", async () => {
    legacyRecoveryOnly();
    const result = await new NetworkingMfaService().verify(ctx, "aaaa-bbbb-cccc-dddd");
    expect(result).toEqual({ verified: true, recoveryCodesOutdated: true });
    // The used code is gone; the unreadable secret is left for re-enrollment, not rewritten.
    expect(state.factor!.recoveryHashes).toHaveLength(1);
    expect(state.factor!.encryptedSecret).not.toMatch(/^v1:/);
    // A TOTP code cannot be checked without the secret's key: an ordinary wrong code, not a 500.
    await expect(new NetworkingMfaService().verify(ctx, networkingTotp(secret))).rejects.toMatchObject({ status: 400 });
  });

  it("reseals the authenticator secret on use and flags the outdated recovery codes", async () => {
    rotated();
    const result = await new NetworkingMfaService().verify(ctx, networkingTotp(secret));
    expect(result).toEqual({ verified: true, recoveryCodesOutdated: true });
    expect(state.factor!.encryptedSecret).toMatch(/^v1:k1:/);
    expect(new NetworkingKeyring({ keys: [{ kid: "k1", secret: k1 }] }).open(state.factor!.encryptedSecret as string)).toBe(secret);
  });

  it("REGENERATE_RECOVERY replaces every code with current-key hashes after a valid check", async () => {
    rotated();
    const result = await new NetworkingMfaService().verify(ctx, networkingTotp(secret), "REGENERATE_RECOVERY");
    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.recoveryCodesOutdated).toBe(false);
    const hashes = state.factor!.recoveryHashes as string[];
    expect(hashes).toHaveLength(10);
    expect(hashes.every((hash) => hash.startsWith("v1:k1:"))).toBe(true);
    expect(matchNetworkingRecoveryCode("p", result.recoveryCodes![3]!, hashes)).toBe(3);
    expect(matchNetworkingRecoveryCode("p", "AAAA-BBBB-CCCC-DDDD", hashes)).toBe(-1);
    // An invalid code regenerates nothing.
    await expect(new NetworkingMfaService().verify(ctx, "000000", "REGENERATE_RECOVERY")).rejects.toMatchObject({ status: 400 });
    expect(state.factor!.recoveryHashes).toEqual(hashes);
  });

  it("never reports outdated codes while writes keep the legacy format", async () => {
    const result = await new NetworkingMfaService().verify(ctx, networkingTotp(secret));
    expect(result).toEqual({ verified: true, recoveryCodesOutdated: false });
    expect(state.factor!.encryptedSecret).not.toMatch(/^v1:/);
  });
});
