import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getDb,
  networkingKeyRetirementBlockers,
  networkingKeyUsage,
  networkingStore,
  resealNetworkingSecrets,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { createNetworkingWriteFixture } from "../../../../../packages/db/tests/helpers/networking-write-fixture";
import { NetworkingService, type NetworkingContext } from "./networking.service";
import { NetworkingMfaService } from "./networking.mfa.service";
import { networkingHash, networkingKeys, networkingTotp, openNetworkingSecret } from "./networking.security";

// Plan 4.5 rollout on a real database: legacy only → k1 + write flag → reseal
// → legacy kept for recovery only → regenerate → legacy retired.
const legacySecret = "legacy-networking-secret-at-least-32-chars";
const k1 = "k1-networking-secret-at-least-32-characters";
const saved = { ...process.env };
function env(values: { TOKEN?: string; KEYS?: string; WRITE?: boolean }) {
  for (const key of ["NETWORKING_TOKEN_SECRET", "NETWORKING_KEYS", "NETWORKING_KEYRING_WRITE_V1"]) delete process.env[key];
  if (values.TOKEN) process.env.NETWORKING_TOKEN_SECRET = values.TOKEN;
  if (values.KEYS) process.env.NETWORKING_KEYS = values.KEYS;
  if (values.WRITE) process.env.NETWORKING_KEYRING_WRITE_V1 = "true";
}
const service = new NetworkingService();
const mfa = new NetworkingMfaService();
let fixture: Awaited<ReturnType<typeof createNetworkingWriteFixture>>;
let ctx: NetworkingContext;
const retirement = async (keepRecovery = false) =>
  networkingKeyRetirementBlockers(await networkingKeyUsage(), "legacy", { currentKid: networkingKeys().currentKid, keepRecovery });

describe.runIf(dbTestsEnabled())("networking keyring rotation", () => {
  beforeAll(async () => {
    env({ TOKEN: legacySecret });
    fixture = await createNetworkingWriteFixture({
      size: 1, slots: [new Date("2031-07-01T09:00:00.000Z")], tables: 0, hash: networkingHash,
    });
    const [participant] = fixture.participants;
    ctx = { event: fixture.event, config: fixture.config, profile: participant!.profile, session: participant!.session };
  }, 240_000);
  afterAll(() => {
    process.env = { ...saved };
  });

  it("keeps every legacy value working through the rotation and retires legacy only when nothing needs it", async () => {
    const bearer = `Bearer ${fixture.participants[0]!.token}`;
    // Step 1, legacy only: enroll an authenticator; its recovery codes are legacy hashes.
    const { secret } = await mfa.enroll(ctx);
    const confirmed = await mfa.verify(ctx, networkingTotp(secret), "CONFIRM");
    expect(confirmed).toMatchObject({ verified: true, recoveryCodesOutdated: false });
    const codes = confirmed.recoveryCodes!;
    expect((await retirement())[0]).toContain("legacy is the current key");

    // Step 2, k1 + write flag: the legacy session still signs in and moves to k1 on use.
    env({ TOKEN: legacySecret, KEYS: `k1:${k1}`, WRITE: true });
    const signedIn = await service.participant(fixture.event.slug, bearer, { allowPendingSecondFactor: true });
    expect(signedIn.session.tokenHash).toMatch(/^v1:k1:/);
    expect((await networkingStore(getDb()).one("sessions", { id: ctx.session.id }))?.tokenHash).toMatch(/^v1:k1:/);
    const blocked = (await retirement()).join("\n");
    expect(blocked).toMatch(/authenticator secrets are sealed with legacy/);
    expect(blocked).toMatch(/10 unused recovery codes reference legacy/);
    expect(blocked).not.toMatch(/live sessions/);

    // New sign-in codes use k1 end to end.
    const { challengeId } = await service.requestCode(fixture.event.slug, ctx.profile.email);
    const challenge = await networkingStore(getDb()).one("challenges", { id: challengeId });
    const delivery = await networkingStore(getDb()).one("deliveries", { dedupeKey: `otp:${challengeId}` });
    expect(challenge?.codeHash).toMatch(/^v1:k1:/);
    expect(String(delivery?.payload.encryptedCode)).toMatch(/^v1:k1:/);
    expect((await service.verifyCode(fixture.event.slug, challengeId, openNetworkingSecret(String(delivery!.payload.encryptedCode)))).token).toHaveLength(64);
    await networkingStore(getDb()).update("deliveries", { id: delivery!.id }, { status: "SENT" });

    // Step 3, reseal: only recovery codes still need legacy.
    expect(await resealNetworkingSecrets(networkingKeys(), getDb(), { apply: true })).toMatchObject({ resealed: 1, unreadable: 0 });
    expect(await retirement(true)).toEqual([]);
    expect(await retirement()).toEqual([expect.stringContaining("10 unused recovery codes reference legacy")]);

    // Step 4, legacy kept for recovery only (NETWORKING_TOKEN_SECRET unset): an unused legacy code still verifies.
    env({ KEYS: `k1:${k1},legacy:${legacySecret}:recovery` });
    const recovered = await mfa.verify(ctx, codes[4]!);
    expect(recovered).toEqual({ verified: true, recoveryCodesOutdated: true });
    await expect(mfa.verify(ctx, codes[4]!)).rejects.toMatchObject({ status: 400 });
    expect(await retirement()).toEqual([expect.stringContaining("9 unused recovery codes reference legacy")]);

    // Regenerating replaces them with k1 hashes; legacy can then be removed entirely.
    const regenerated = await mfa.verify(ctx, codes[5]!, "REGENERATE_RECOVERY");
    expect(regenerated).toMatchObject({ verified: true, recoveryCodesOutdated: false });
    expect(regenerated.recoveryCodes).toHaveLength(10);
    expect(await retirement()).toEqual([]);
    env({ KEYS: `k1:${k1}` });
    expect(await mfa.verify(ctx, regenerated.recoveryCodes![0]!)).toMatchObject({ verified: true, recoveryCodesOutdated: false });
    expect((await service.participant(fixture.event.slug, bearer)).profile.id).toBe(ctx.profile.id);
  });
});
