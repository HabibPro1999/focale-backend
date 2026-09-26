import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
const db = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  update: vi.fn(), insert: vi.fn(), enqueue: vi.fn(), modules: vi.fn(), sync: vi.fn(), delete: vi.fn(),
  failedOtpAttempts: vi.fn(),
  reads: [] as string[],
  transactions: 0,
  tx: { transaction: true },
}));
vi.mock("@app/db", async (original) => {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => value === undefined || (value === null ? row[key] == null : row[key] === value));
  const store = {
    executor: db.tx,
    one: async (kind: string, where: Record<string, unknown>) => {
      db.reads.push(kind);
      return (db.rows[kind] ?? []).find((row) => matches(row, where)) ?? null;
    },
    all: async (kind: string, where: Record<string, unknown>) => (db.rows[kind] ?? []).filter((row) => matches(row, where)),
    update: async (kind: string, where: Record<string, unknown>, values: Record<string, unknown>) => {
      db.update(kind, where, values);
      return (db.rows[kind] ?? []).filter((row) => matches(row, where)).map((row) => Object.assign(row, values));
    },
    insert: async (kind: string, values: Record<string, unknown>) => { db.insert(kind, values); return values; },
    failedOtpAttempts: db.failedOtpAttempts,
    sessionByTokenHashes: async (eventId: string, hashes: string[]) => {
      db.reads.push("sessions");
      return (db.rows.sessions ?? []).find((row) => row.eventId === eventId && row.revokedAt == null && hashes.includes(row.tokenHash as string)) ?? null;
    },
    rehashSession: async (eventId: string, id: string, from: string, to: string) => {
      db.update("sessions", { eventId, id, tokenHash: from }, { tokenHash: to });
      for (const row of db.rows.sessions ?? []) if (row.id === id && row.tokenHash === from) row.tokenHash = to;
    },
    revokeSessionByTokenHashes: async (eventId: string, hashes: string[]) => {
      db.update("sessions", { eventId, tokenHash: hashes, revokedAt: null }, { revokedAt: new Date() });
    },
  };
  const real = await original<typeof import("@app/db")>();
  const { networkingSnapshotMocks } = await import("./__testing__/snapshot-mocks.js");
  Object.assign(store, networkingSnapshotMocks(store, {
    clientState: (clientId: string) => db.modules(clientId, db.tx),
    consentPending: real.networkingConsentPending,
  }));
  return {
    ...real,
    networkingStore: () => store,
    networkingTransaction: async (_event: string, run: (s: typeof store, tx: object) => unknown) => {
      db.transactions++;
      return run(store, db.tx);
    },
    enqueueNetworkingDelivery: db.enqueue,
    findClientModuleState: db.modules,
    touchNetworkingProfileActivity: vi.fn(),
    revokeNetworkingSessions: vi.fn(),
    cancelNetworkingParticipantMeetings: vi.fn(),
    syncNetworkingRegistration: db.sync,
  };
});
vi.mock("@app/integrations", async (original) => ({
  ...(await original<typeof import("@app/integrations")>()),
  getStorageProvider: () => ({ delete: db.delete }),
}));
import { NetworkingService } from "./networking.service";
import { networkingHash, networkingOtpHash } from "./networking.security";
import { networkingBearerLockout, networkingIdentityCache, networkingVenueKey } from "../../core/networking-identity-cache";

const token = "t".repeat(48);
const consentForm = {
  fields: [{ id: "consent", type: "radio", options: [{ id: "o-yes", label: "J’accepte de participer au networking" }, { id: "o-no", label: "Je ne souhaite pas participer" }] }],
};
function seed(overrides: { profile?: object; registration?: object; config?: object; event?: object; session?: object } = {}) {
  db.rows = {
    events: [{ id: "event", slug: "demo", clientId: "client", name: "Demo", status: "OPEN", endDate: new Date(Date.now() + 86_400_000), ...overrides.event }],
    configs: [{ eventId: "event", config: { enabled: true, fieldMapping: { consent: "consent" }, ...overrides.config } }],
    sessions: [{ id: "session", eventId: "event", profileId: "p", tokenHash: networkingHash(token), revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000), secondFactorVerifiedAt: null, ...overrides.session }],
    profiles: [{ id: "p", eventId: "event", registrationId: "r", email: "ann@example.test", status: "ACTIVE", consent: false, withdrawnAt: null, overrides: {}, lastActiveAt: new Date(), createdAt: new Date(0), ...overrides.profile }],
    registrations: [{ id: "r", eventId: "event", formId: "form", paymentStatus: "PAID", networkingOptIn: null, formData: {}, ...overrides.registration }],
    forms: [{ id: "form", eventId: "event", schema: consentForm }],
    challenges: [],
    secondFactors: [],
  };
}
const service = new NetworkingService();
const bearer = `Bearer ${token}`;
beforeEach(() => {
  vi.clearAllMocks();
  db.reads = [];
  db.transactions = 0;
  process.env.NETWORKING_TOKEN_SECRET = "test-networking-secret-at-least-32-characters";
  db.modules.mockResolvedValue({ active: true, enabledModules: ["networking", "registrations", "emails"] });
  db.failedOtpAttempts.mockResolvedValue({ recent: 0, daily: 0 });
  networkingIdentityCache.clear();
  networkingBearerLockout.clear();
  seed();
});
afterEach(() => { delete process.env.PUBLIC_NETWORKING_URL; });

describe("K1b consent-pending sessions", () => {
  it("lets an undecided registrant sign in only for the consent allow-list", async () => {
    await expect(service.participant("demo", bearer)).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_CONSENT_REQUIRED", message: "Networking consent is required" } });
    const ctx = await service.participant("demo", bearer, { allowConsentPending: true });
    expect(ctx.consentPending).toBe(true);
    expect(ctx.profile.consent).toBe(false);
  });
  it.each([
    ["mapped answer is no", { registration: { formData: { consent: "o-no" } } }],
    ["the registration opted out", { registration: { networkingOptIn: false } }],
    ["the participant explicitly declined", { profile: { overrides: { consent: false } } }],
    ["the participant withdrew", { profile: { withdrawnAt: new Date() } }],
    ["payment is not eligible", { registration: { paymentStatus: "PENDING" } }],
  ])("refuses sign-in when %s", async (_label, overrides) => {
    seed(overrides);
    await expect(service.participant("demo", bearer, { allowConsentPending: true })).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_NOT_ELIGIBLE" } });
  });
  it("passes consented participants through every endpoint", async () => {
    seed({ profile: { consent: true } });
    expect((await service.participant("demo", bearer)).consentPending).toBe(false);
  });
  it("sends an OTP to an undecided registrant but not to one whose mapped answer is no", async () => {
    await service.requestCode("demo", "Ann@Example.test");
    expect(db.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: "OTP", profileId: "p", email: "ann@example.test" }), db.tx);
    db.enqueue.mockClear();
    seed({ registration: { formData: { consent: "o-no" } } });
    expect(await service.requestCode("demo", "ann@example.test")).toHaveProperty("challengeId");
    expect(db.enqueue).not.toHaveBeenCalled();
  });
  it("PATCH me {consent:true} records the explicit choice and makes the profile visible, ignoring other fields", async () => {
    const ctx = await service.participant("demo", bearer, { allowConsentPending: true });
    const row = await service.updateMe(ctx, { consent: true, company: "Ignored Co", visible: false });
    expect(db.update).toHaveBeenCalledWith("profiles", { id: "p", eventId: "event" }, {
      consent: true, consentAt: expect.any(Date), visible: true, overrides: { consent: true },
    });
    expect(row).toMatchObject({ consent: true, visible: true });
    expect((await service.participant("demo", bearer)).consentPending).toBe(false);
  });
});

describe("participant session and event errors", () => {
  it.each([
    ["no bearer", undefined, {}],
    ["an expired session", bearer, { session: { expiresAt: new Date(Date.now() - 1) } }],
    ["a revoked session", bearer, { session: { revokedAt: new Date() } }],
  ])("401 NETWORKING_SESSION_EXPIRED for %s", async (_label, authorization, overrides) => {
    seed(overrides);
    await expect(service.participant("demo", authorization)).rejects.toMatchObject({ status: 401, response: { code: "NETWORKING_SESSION_EXPIRED" } });
  });
  it("404 NETWORKING_NOT_FOUND for an unknown slug and 403 FEATURE_DISABLED when a module is gated", async () => {
    await expect(service.participant("missing", bearer)).rejects.toMatchObject({ status: 404, response: { code: "NETWORKING_NOT_FOUND" } });
    db.modules.mockResolvedValue({ active: true, enabledModules: ["registrations", "emails"] });
    await expect(service.participant("demo", bearer)).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_FEATURE_DISABLED" } });
  });
  it("keeps a wrong OTP at 401 without the 400-only validation code", async () => {
    const error = await service.verifyCode("demo", "00000000-0000-4000-8000-000000000001", "000000").catch((e) => e);
    expect(error.status).toBe(401);
    expect(error.response.code).not.toBe("NETWORKING_VALIDATION");
  });
  it("logs out by token alone, even for an ineligible participant after networking closed", async () => {
    seed({ profile: { status: "SUSPENDED" }, config: { enabled: false } });
    expect(await service.logout("demo", bearer)).toEqual({ loggedOut: true });
    expect(db.update).toHaveBeenCalledWith("sessions", { eventId: "event", tokenHash: expect.arrayContaining([networkingHash(token)]), revokedAt: null }, { revokedAt: expect.any(Date) });
    await expect(service.logout("demo", undefined)).rejects.toMatchObject({ status: 401, response: { code: "NETWORKING_SESSION_EXPIRED" } });
  });
});

describe("GET registration (K2)", () => {
  it("describes enabled networking before it opens, with the PWA URL and mapped fields", async () => {
    process.env.PUBLIC_NETWORKING_URL = "https://networking.example.com/";
    seed({ config: { opensAt: "2099-04-20T07:00:00.000Z", approvalMode: "AUTOMATIC", fieldMapping: { company: "field_company", jobTitle: "field_role" } } });
    await expect(service.participant("demo", bearer)).rejects.toMatchObject({ response: { code: "NETWORKING_CLOSED" } });
    expect(await service.registrationInfo("demo")).toEqual({
      enabled: true, opensAt: "2099-04-20T07:00:00.000Z", closesAt: null, approvalMode: "AUTOMATIC",
      fieldMapping: { company: "field_company", jobTitle: "field_role", consent: null },
      networkingUrl: "https://networking.example.com/e/demo",
    });
  });
  it("omits networkingUrl when PUBLIC_NETWORKING_URL is unset and defaults to manual approval", async () => {
    expect(await service.registrationInfo("demo")).toEqual({
      enabled: true, opensAt: null, closesAt: null, approvalMode: NetworkingConfigSchema.parse({}).approvalMode,
      fieldMapping: { consent: "consent" },
    });
  });
  it.each([
    ["disabled", { config: { enabled: false } }],
    ["archived", { event: { status: "ARCHIVED" } }],
    ["closed", { config: { closesAt: "2000-01-01T00:00:00.000Z" } }],
    ["past retention", { event: { endDate: new Date("2000-01-01T00:00:00.000Z") } }],
  ])("is { enabled: false } when %s", async (_label, overrides) => {
    seed(overrides);
    expect(await service.registrationInfo("demo")).toEqual({ enabled: false });
  });
  it("is { enabled: false } when a client module is gated and 404 for an unknown slug", async () => {
    db.modules.mockResolvedValue({ active: false, enabledModules: ["networking", "registrations", "emails"] });
    expect(await service.registrationInfo("demo")).toEqual({ enabled: false });
    await expect(service.registrationInfo("missing")).rejects.toMatchObject({ status: 404, response: { code: "NETWORKING_NOT_FOUND" } });
  });
});

describe("participant photo changes", () => {
  const own = "https://storage.example/networking/event/profiles/p/old.webp";
  it.each([
    [own, "networking/event/profiles/p/old.webp"],
    ["https://storage.example/forms/uploads/registrant.webp", null],
  ])("removing photo %s deletes only an owned upload, after commit", async (photoUrl, key) => {
    seed({ profile: { consent: true, photoUrl } });
    const ctx = await service.participant("demo", bearer);
    const row = await service.updateMe(ctx, { photoUrl: null });
    expect(row).toMatchObject({ photoUrl: null, overrides: { photoUrl: null } });
    if (key) expect(db.delete).toHaveBeenCalledWith(key);
    else expect(db.delete).not.toHaveBeenCalled();
  });
  it("a new upload replaces and deletes the previous owned photo", async () => {
    seed({ profile: { consent: true, photoUrl: own } });
    const ctx = await service.participant("demo", bearer);
    await service.updateMe(ctx, { photoUrl: "https://storage.example/networking/event/profiles/p/new.webp" });
    expect(db.delete).toHaveBeenCalledWith("networking/event/profiles/p/old.webp");
    expect(db.delete).toHaveBeenCalledOnce();
  });
  it("resetting the photo to the registration answer deletes the owned upload", async () => {
    seed({ profile: { consent: true, photoUrl: own, overrides: { photoUrl: own } } });
    db.sync.mockImplementation(async () => { Object.assign(db.rows.profiles![0]!, { photoUrl: "https://storage.example/forms/uploads/registrant.webp" }); });
    const ctx = await service.participant("demo", bearer);
    const row = await service.updateMe(ctx, { resetFields: ["photoUrl"] });
    expect(db.update).toHaveBeenCalledWith("profiles", { id: "p", eventId: "event" }, expect.objectContaining({ overrides: {} }));
    expect(row.photoUrl).toBe("https://storage.example/forms/uploads/registrant.webp");
    expect(db.delete).toHaveBeenCalledWith("networking/event/profiles/p/old.webp");
  });
});

describe("verified bearer identities (0.9)", () => {
  const ip = "192.0.2.1";
  const venue = networkingVenueKey(ip, "demo");
  it("remembers a live session for the throttler, even when the profile is refused", async () => {
    seed({ profile: { consent: true } });
    await service.participant("demo", bearer, { ip });
    expect(networkingIdentityCache.sessionFor(token)).toBe("session");
    networkingIdentityCache.clear();
    seed({ profile: { status: "SUSPENDED" } });
    await expect(service.participant("demo", bearer, { ip })).rejects.toMatchObject({ status: 403 });
    expect(networkingIdentityCache.sessionFor(token)).toBe("session");
  });
  it.each([
    ["an unknown token", `Bearer ${"u".repeat(48)}`, {}],
    ["a malformed token", "Bearer short", {}],
    ["an expired session", bearer, { session: { expiresAt: new Date(Date.now() - 1) } }],
    ["a revoked session", bearer, { session: { revokedAt: new Date() } }],
  ])("forgets and counts %s toward the venue lockout", async (_label, authorization, overrides) => {
    networkingIdentityCache.remember(authorization.slice(7), { id: "stale", profileId: "p", expiresAt: new Date(Date.now() + 60_000) });
    seed(overrides);
    const record = vi.spyOn(networkingBearerLockout, "recordRejected");
    await expect(service.participant("demo", authorization, { ip })).rejects.toMatchObject({ status: 401, response: { code: "NETWORKING_SESSION_EXPIRED" } });
    expect(record).toHaveBeenCalledWith(venue, authorization.slice(7));
    expect(networkingIdentityCache.sessionFor(authorization.slice(7))).toBeUndefined();
    record.mockRestore();
  });
  it("counts nothing without a bearer, for refused valid sessions, or for a closed event", async () => {
    const record = vi.spyOn(networkingBearerLockout, "recordRejected");
    await expect(service.participant("demo", undefined, { ip })).rejects.toMatchObject({ status: 401 });
    await expect(service.participant("demo", bearer, { ip })).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_CONSENT_REQUIRED" } });
    seed({ profile: { consent: true } });
    db.rows.secondFactors = [{ profileId: "p", enabledAt: new Date() }];
    await expect(service.participant("demo", bearer, { ip })).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_MFA_REQUIRED" } });
    seed({ config: { closesAt: "2000-01-01T00:00:00.000Z" } });
    await expect(service.participant("demo", `Bearer ${"u".repeat(48)}`, { ip })).rejects.toMatchObject({ response: { code: "NETWORKING_CLOSED" } });
    expect(record).not.toHaveBeenCalled();
    record.mockRestore();
  });
  it("locks the venue after 200 distinct rejected bearers", async () => {
    for (let i = 0; i < 200; i++)
      await expect(service.participant("demo", `Bearer ${String(i).padStart(48, "x")}`, { ip })).rejects.toMatchObject({ status: 401 });
    expect(networkingBearerLockout.lockedFor(venue)).toBeGreaterThan(0);
    expect(networkingBearerLockout.lockedFor(networkingVenueKey(ip, "other"))).toBe(0);
  });
  it("forgets the token on logout", async () => {
    networkingIdentityCache.remember(token, { id: "session", profileId: "p", expiresAt: new Date(Date.now() + 60_000) });
    await service.logout("demo", bearer);
    expect(networkingIdentityCache.sessionFor(token)).toBeUndefined();
  });
});

describe("OTP failed-attempt limits (0.9)", () => {
  const code = "123456";
  function seedChallenge(overrides: object = {}) {
    db.rows.challenges = [{
      id: "c1", eventId: "event", email: "ann@example.test", attempts: 0, consumedAt: null, verifiedAt: null,
      codeHash: networkingOtpHash("event", "ann@example.test", code), expiresAt: new Date(Date.now() + 60_000), ...overrides,
    }];
  }
  it.each([
    ["ten failures in 15 minutes", { recent: 10, daily: 10 }],
    ["thirty failures in 24 hours", { recent: 0, daily: 30 }],
  ])("returns 429 before comparing the code after %s", async (_label, failed) => {
    seedChallenge();
    db.failedOtpAttempts.mockResolvedValue(failed);
    const error = await service.verifyCode("demo", "c1", code).catch((e) => e);
    expect(error.status).toBe(429);
    expect(error.response).toEqual({ code: "NETWORKING_RATE_LIMITED", message: "Too many verification attempts" });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalledWith("sessions", expect.anything());
    expect(db.failedOtpAttempts).toHaveBeenCalledWith("event", "ann@example.test", expect.any(Date), expect.any(Date));
    const [, , recentSince, dailySince] = db.failedOtpAttempts.mock.calls[0];
    expect(recentSince.getTime() - dailySince.getTime()).toBe(86_400_000 - 15 * 60_000);
    expect(Math.abs(Date.now() - 15 * 60_000 - recentSince.getTime())).toBeLessThan(5_000);
  });
  it("still compares the code just below both limits", async () => {
    seedChallenge();
    db.failedOtpAttempts.mockResolvedValue({ recent: 9, daily: 29 });
    const error = await service.verifyCode("demo", "c1", "000000").catch((e) => e);
    expect(error.status).toBe(401);
    expect(db.update).toHaveBeenCalledWith("challenges", { id: "c1", eventId: "event" }, { attempts: 1 });
  });
  it("marks the successful attempt verified and throttles the new bearer as its session", async () => {
    seedChallenge({ attempts: 2 });
    const remember = vi.spyOn(networkingIdentityCache, "remember");
    const result = await service.verifyCode("demo", "c1", code);
    expect(db.update).toHaveBeenCalledWith("challenges", { id: "c1", eventId: "event" }, {
      attempts: 3, consumedAt: expect.any(Date), verifiedAt: expect.any(Date),
    });
    expect(result).not.toHaveProperty("session");
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "mfaEnrollmentRequired", "profile", "requiresSecondFactor", "token"]);
    expect(remember).toHaveBeenCalledWith(result.token, expect.objectContaining({ profileId: "p", eventId: "event" }));
    remember.mockRestore();
  });
});

describe("networking transactions ride one connection", () => {
  it("revalidates a participant without re-reading the event row and gates modules on the transaction", async () => {
    const ctx = await service.participant("demo", bearer, { allowConsentPending: true });
    db.reads = [];
    db.modules.mockClear();
    await service.currentParticipant(ctx, (await import("@app/db")).networkingStore(), { allowConsentPending: true });
    expect(db.reads).not.toContain("events");
    expect(db.modules).toHaveBeenCalledExactlyOnceWith("client", db.tx);
  });
  it("gates OTP requests and verification once, before the transaction", async () => {
    seed({ profile: { consent: true } });
    await service.requestCode("demo", "ann@example.test");
    expect(db.transactions).toBe(1);
    expect(db.modules).toHaveBeenCalledExactlyOnceWith("client");
    expect(db.reads.filter((kind) => kind === "events")).toHaveLength(1);
    db.modules.mockClear();
    db.reads = [];
    await service.verifyCode("demo", "missing", "123456").catch(() => undefined);
    expect(db.modules).toHaveBeenCalledExactlyOnceWith("client");
    expect(db.reads.filter((kind) => kind === "events")).toHaveLength(1);
  });
});
