import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
const db = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  update: vi.fn(), insert: vi.fn(), enqueue: vi.fn(), modules: vi.fn(), sync: vi.fn(), delete: vi.fn(),
}));
vi.mock("@app/db", async (original) => {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => value === undefined || (value === null ? row[key] == null : row[key] === value));
  const store = {
    one: async (kind: string, where: Record<string, unknown>) => (db.rows[kind] ?? []).find((row) => matches(row, where)) ?? null,
    all: async (kind: string, where: Record<string, unknown>) => (db.rows[kind] ?? []).filter((row) => matches(row, where)),
    update: async (kind: string, where: Record<string, unknown>, values: Record<string, unknown>) => {
      db.update(kind, where, values);
      return (db.rows[kind] ?? []).filter((row) => matches(row, where)).map((row) => Object.assign(row, values));
    },
    insert: async (kind: string, values: Record<string, unknown>) => { db.insert(kind, values); return values; },
  };
  return {
    ...(await original<typeof import("@app/db")>()),
    networkingStore: () => store,
    networkingTransaction: async (_event: string, run: (s: typeof store, tx: object) => unknown) => run(store, {}),
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
import { networkingHash } from "./networking.security";

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
  process.env.NETWORKING_TOKEN_SECRET = "test-networking-secret-at-least-32-characters";
  db.modules.mockResolvedValue({ active: true, enabledModules: ["networking", "registrations", "emails"] });
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
    expect(db.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: "OTP", profileId: "p", email: "ann@example.test" }), {});
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
    expect(db.update).toHaveBeenCalledWith("sessions", { eventId: "event", tokenHash: networkingHash(token), revokedAt: null }, { revokedAt: expect.any(Date) });
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
