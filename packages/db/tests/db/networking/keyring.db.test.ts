import { beforeAll, describe, expect, it } from "vitest";
import { NetworkingKeyring } from "@app/shared";
import { getDb } from "../../../src/client";
import {
  networkingKeyRetirementBlockers,
  networkingKeyUsage,
  resealNetworkingSecrets,
} from "../../../src/queries/networking-keyring";
import { networkingStore } from "../../../src/queries/networking-store";
import { networkingSecondFactors } from "../../../src/schema/networking-mfa";
import { createNetworkingWriteFixture } from "../../helpers/networking-write-fixture";
import { dbTestsEnabled } from "../../helpers/test-env";

// Plan 4.5 key-usage report, retirement refusal and reseal on a migrated database (both engines in CI).
const legacySecret = "legacy-networking-secret-at-least-32-chars";
const k1 = "k1-networking-secret-at-least-32-characters";
const legacy = new NetworkingKeyring({ legacySecret });
const rotated = new NetworkingKeyring({ legacySecret, keys: [{ kid: "k1", secret: k1 }], writeV1: true });
let fixture: Awaited<ReturnType<typeof createNetworkingWriteFixture>>;

describe.runIf(dbTestsEnabled())("networking keyring usage and reseal", () => {
  beforeAll(async () => {
    fixture = await createNetworkingWriteFixture({
      size: 3, slots: [new Date("2031-07-01T09:00:00.000Z")], tables: 0, hash: (token) => legacy.mac("session", token),
    });
    const [a, b] = fixture.participants;
    await getDb().insert(networkingSecondFactors).values([
      {
        profileId: a!.profile.id, enabledAt: new Date(), encryptedSecret: legacy.seal("SECRETA"),
        recoveryHashes: ["A1", "A2"].map((code) => legacy.mac("recovery", `recovery:${a!.profile.id}:${code}`)),
      },
      {
        profileId: b!.profile.id, encryptedSecret: rotated.seal("SECRETB"), pendingEncryptedSecret: legacy.seal("PENDINGB"),
        recoveryHashes: [rotated.mac("recovery", `recovery:${b!.profile.id}:B1`)],
      },
    ]);
    // One session already moved to k1, one revoked legacy session that no longer counts.
    await networkingStore(getDb()).update("sessions", { id: fixture.participants[2]!.session.id }, { tokenHash: rotated.mac("session", "moved") });
    await networkingStore(getDb()).insert("sessions", {
      eventId: fixture.event.id, profileId: a!.profile.id, tokenHash: legacy.mac("session", "revoked"),
      expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date(),
    });
    await networkingStore(getDb()).insert("deliveries", {
      eventId: fixture.event.id, profileId: a!.profile.id, type: "OTP", dedupeKey: `otp:${fixture.event.id}`,
      payload: { encryptedCode: legacy.seal("123456"), challengeId: "c" },
    });
  }, 240_000);

  it("counts what still uses each key and refuses to retire a key in use", async () => {
    const usage = await networkingKeyUsage();
    const count = (use: string, kid: string) => usage.find((row) => row.use === use && row.kid === kid)?.count ?? 0;
    expect([count("session", "legacy"), count("session", "k1")]).toEqual([2, 1]);
    expect([count("seal", "legacy"), count("seal", "k1")]).toEqual([2, 1]);
    expect([count("recovery", "legacy"), count("recovery", "k1")]).toEqual([2, 1]);
    expect(count("otp", "legacy")).toBe(1);
    const blockers = networkingKeyRetirementBlockers(usage, "legacy", { currentKid: "k1" });
    expect(blockers).toHaveLength(4);
    expect(blockers.join("\n")).toMatch(/2 unused recovery codes reference legacy/);
    expect(networkingKeyRetirementBlockers(usage, "legacy", { currentKid: "k1", keepRecovery: true })).toHaveLength(3);
    expect(networkingKeyRetirementBlockers(usage, "k1", { currentKid: "k1" })[0]).toMatch(/current key/);
  });

  it("reseals authenticator secrets with the current key only when applied", async () => {
    expect(await resealNetworkingSecrets(rotated, getDb())).toEqual({ checked: 3, resealed: 2, unreadable: 0 });
    const before = await getDb().select().from(networkingSecondFactors);
    expect(before.filter((row) => row.encryptedSecret?.startsWith("v1:k1:"))).toHaveLength(1);
    expect(await resealNetworkingSecrets(rotated, getDb(), { apply: true, batchSize: 1 })).toEqual({ checked: 3, resealed: 2, unreadable: 0 });
    const after = await getDb().select().from(networkingSecondFactors);
    for (const row of after) {
      for (const sealed of [row.encryptedSecret, row.pendingEncryptedSecret].filter((value): value is string => !!value)) {
        expect(sealed).toMatch(/^v1:k1:/);
        expect(["SECRETA", "SECRETB", "PENDINGB"]).toContain(rotated.open(sealed));
      }
    }
    expect(await resealNetworkingSecrets(rotated, getDb(), { apply: true })).toEqual({ checked: 3, resealed: 0, unreadable: 0 });
    // A key that is gone leaves its secrets unreadable and untouched.
    expect(await resealNetworkingSecrets(new NetworkingKeyring({ keys: [{ kid: "k2", secret: `${k1}-k2` }] }), getDb())).toEqual({ checked: 3, resealed: 0, unreadable: 3 });
    const usage = await networkingKeyUsage();
    expect(usage.filter((row) => row.use === "seal")).toEqual([{ use: "seal", kid: "k1", count: 3 }]);
    // Recovery codes cannot be resealed: they keep blocking a full retirement.
    expect(networkingKeyRetirementBlockers(usage, "legacy", { currentKid: "k1" }).join("\n")).toMatch(/recovery codes/);
  });
});
