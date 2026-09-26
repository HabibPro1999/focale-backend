import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKING_CONFIG_UNCONFIGURED_REVISION, NetworkingConfigSchema, UpdateNetworkingConfigSchema } from "@app/contracts";
import type { NetworkingRow, NetworkingStore } from "@app/db";
const state = vi.hoisted(() => ({
  row: null as NetworkingRow<"configs"> | null,
  transaction: false,
  requireTransaction: false,
  audits: [] as unknown[],
  deliveries: [] as any[],
  forms: [] as any[],
  profile: null as Record<string, unknown> | null,
  profiles: [] as Record<string, unknown>[],
  meeting: null as Record<string, unknown> | null,
  event: null as Record<string, unknown> | null,
  tx: { executor: "transaction" },
  transition: vi.fn(),
  delete: vi.fn(),
  sync: vi.fn(),
  tail: Promise.resolve() as Promise<unknown>,
}));
vi.mock("@app/db", async (original) => {
  const { networkingMeetingIs, networkingProfileListed, networkingRetentionEnded } = await original<typeof import("@app/db")>();
  const store = {
    one: async (kind: string) => {
      if (kind === "profiles" && state.profile) return state.profile;
      if (kind === "meetings") return state.meeting;
      if (kind === "events" && state.event) return state.event;
      if (kind === "configs") {
        if (state.requireTransaction) expect(state.transaction).toBe(true);
        return state.row;
      }
      return { id: "event", clientId: "client", startDate: new Date("2030-01-01Z"), endDate: new Date("2031-01-01Z") };
    },
    all: async (kind: string) => kind === "deliveries" ? state.deliveries : kind === "forms" ? state.forms : kind === "profiles" ? state.profiles : [],
    update: async (_kind: string, _where: unknown, values: object) => {
      state.row = { ...state.row!, ...values };
      return [state.row];
    },
    insert: async (kind: string, values: any) => {
      if (kind === "configs") state.row = values;
      else if (kind === "deliveries") state.deliveries.push(values);
      else state.audits.push(values);
      return values;
    },
  };
  return {
    networkingMeetingIs,
    networkingProfileListed,
    networkingRetentionEnded,
    transitionNetworkingMeetings: state.transition,
    requestNetworkingEventSync: state.sync,
    networkingFormField: (schema: { fields?: { id: string }[] }, id: string) => schema.fields?.find((field) => field.id === id),
    networkingStore: () => store,
    getNetworkingConfig: async () => NetworkingConfigSchema.parse({}),
    networkingTransaction: (_eventId: string, run: (store: NetworkingStore, db: unknown) => Promise<unknown>) => {
      const result = state.tail.then(async () => {
        state.transaction = true;
        try { return await run(store as unknown as NetworkingStore, state.tx); }
        finally { state.transaction = false; }
      });
      state.tail = result.catch(() => {});
      return result;
    },
  };
});
vi.mock("../clients/module-gates", () => ({ assertClientModuleEnabled: vi.fn() }));
vi.mock("@app/integrations", async (original) => ({
  ...(await original<typeof import("@app/integrations")>()),
  getStorageProvider: () => ({ delete: state.delete }),
}));
import { assertClientModuleEnabled } from "../clients/module-gates";
import { ZodValidationPipe } from "../../core/zod";
import { NetworkingConfigDto } from "./networking.dto";
import { NetworkingAdminService } from "./networking.admin.service";
import type { NetworkingService } from "./networking.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
const service = new NetworkingAdminService({} as NetworkingService, {} as NetworkingMeetingsService);
const revision = "2030-01-01T00:00:00.000Z";
beforeEach(() => {
  state.row = { eventId: "event", config: NetworkingConfigSchema.parse({}), createdAt: new Date(revision), updatedAt: new Date(revision), purgeStartedAt: null, purgedAt: null } as NetworkingRow<"configs">;
  state.transaction = false;
  state.requireTransaction = false;
  state.audits = [];
  state.deliveries = [];
  state.forms = [];
  state.profile = null;
  state.profiles = [];
  state.event = null;
  vi.mocked(assertClientModuleEnabled).mockClear();
  state.delete.mockReset();
  state.sync.mockReset();
  state.tail = Promise.resolve();
});
afterEach(() => vi.useRealTimers());
describe("NetworkingAdminService config", () => {
  it("returns the stored updatedAt revision", async () => {
    expect((await service.config("event")).revision).toBe(revision);
  });
  it("rejects stale revisions inside the transaction without writes", async () => {
    state.requireTransaction = true;
    await expect(service.config("event", { expectedRevision: "stale", requireSecondFactor: true })).rejects.toMatchObject({
      status: 409, response: { code: "NETWORKING_CONFIG_STALE" },
    });
    expect(state.row!.config.requireSecondFactor).toBe(false);
    expect(state.audits).toEqual([]);
  });
  it("rejects a stray read-only revision in a PATCH body", () => {
    expect(() => new ZodValidationPipe().transform({ revision: revision, requireSecondFactor: true }, { type: "body", metatype: NetworkingConfigDto })).toThrow();
  });
  it("accepts matching revisions and strips the transport field from storage and audit", async () => {
    const patch = UpdateNetworkingConfigSchema.parse({ expectedRevision: revision, requireSecondFactor: true });
    const result = await service.config("event", patch);
    expect(result.requireSecondFactor).toBe(true);
    expect(state.row!.config).not.toHaveProperty("revision");
    expect(state.row!.config).not.toHaveProperty("expectedRevision");
    expect(state.audits).toMatchObject([{ data: { fields: ["requireSecondFactor"] } }]);
  });
  it("preserves omitted settings through the controller validation pipe", async () => {
    const openingHours = [{ date: "2030-05-01", start: "09:00", end: "10:00" }];
    await service.config("event", { requireSecondFactor: true, meetingsEnabled: false, openingHours });
    const patch = new ZodValidationPipe().transform({ logoUrl: "https://example.test/logo.png" }, {
      type: "body", metatype: NetworkingConfigDto,
    });
    expect(patch).toEqual({ logoUrl: "https://example.test/logo.png" });
    expect(await service.config("event", patch as NetworkingConfigDto)).toMatchObject({ requireSecondFactor: true, meetingsEnabled: false, openingHours });
  });
  it("preserves sequential partial MFA and logo updates", async () => {
    await service.config("event", { requireSecondFactor: true });
    const result = await service.config("event", { logoUrl: "https://example.test/logo.png" });
    expect(result).toMatchObject({ requireSecondFactor: true, logoUrl: "https://example.test/logo.png" });
  });
  it("merges concurrent partial updates only after acquiring the event transaction", async () => {
    state.requireTransaction = true;
    await Promise.all([
      service.config("event", { requireSecondFactor: true }),
      service.config("event", { logoUrl: "https://example.test/logo.png" }),
    ]);
    expect(state.row!.config).toMatchObject({ requireSecondFactor: true, logoUrl: "https://example.test/logo.png" });
  });
  it("uses the absent-row sentinel and rejects it once a row exists", async () => {
    state.row = null;
    expect((await service.config("event")).revision).toBe(NETWORKING_CONFIG_UNCONFIGURED_REVISION);
    await expect(service.config("event", { expectedRevision: revision })).rejects.toMatchObject({ status: 409 });
    await service.config("event", { expectedRevision: NETWORKING_CONFIG_UNCONFIGURED_REVISION });
    await expect(service.config("event", { expectedRevision: NETWORKING_CONFIG_UNCONFIGURED_REVISION })).rejects.toMatchObject({
      status: 409, response: { code: "NETWORKING_CONFIG_STALE" },
    });
  });
  it("advances revisions even when writes occur in the same millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(revision));
    const first = await service.config("event", { expectedRevision: revision });
    const second = await service.config("event", { expectedRevision: first.revision });
    expect(Date.parse(first.revision)).toBe(Date.parse(revision) + 1);
    expect(Date.parse(second.revision)).toBe(Date.parse(revision) + 2);
  });
  it("accepts chronologically valid mixed-offset instants", async () => {
    await expect(service.config("event", { opensAt: "2030-05-01T10:00:00+02:00", closesAt: "2030-05-01T09:00:00Z" })).resolves.toHaveProperty("revision");
  });
  it.each([
    { opensAt: "2030-05-01T09:00:00Z", closesAt: "2030-05-01T10:00:00+02:00" },
    { opensAt: "2030-05-01T08:00:00Z", closesAt: "2030-05-01T10:00:00+02:00" },
    { opensAt: "not-a-date" },
    { openingHours: [{ date: "2030-99-99", start: "09:00", end: "10:00" }] },
  ])("rejects invalid instants/windows with a validation code: %j", async (patch) => {
    await expect(service.config("event", patch)).rejects.toMatchObject({ status: 400, response: { code: "NETWORKING_VALIDATION" } });
    expect(state.audits).toEqual([]);
  });
});

describe("NetworkingAdminService config after retention (4.4)", () => {
  const DAY = 86_400_000;
  const ended = (daysAgo: number) => ({
    id: "event", clientId: "client",
    startDate: new Date(Date.now() - (daysAgo + 1) * DAY), endDate: new Date(Date.now() - daysAgo * DAY),
  });
  const stored = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    state.row = {
      eventId: "event", config: NetworkingConfigSchema.parse({ meetingsEnabled: false, ...config }),
      createdAt: new Date(revision), updatedAt: new Date(revision), purgeStartedAt: null, purgedAt: null, ...extra,
    } as NetworkingRow<"configs">;
  };
  const refused = { status: 409, response: { code: "NETWORKING_RETENTION_ENDED" } };

  it("refuses to re-enable once retention has ended, without writing", async () => {
    state.event = ended(100);
    stored({ enabled: false, retentionDays: 90 });
    const before = state.row;
    await expect(service.config("event", { enabled: true }, "admin")).rejects.toMatchObject(refused);
    // Raising retentionDays in the same request cannot bring back an event whose new limit has passed too.
    await expect(service.config("event", { enabled: true, retentionDays: 99 }, "admin")).rejects.toMatchObject(refused);
    expect(state.row).toBe(before);
    expect(state.audits).toEqual([]);
    expect(state.sync).not.toHaveBeenCalled();
  });

  it("refuses to enable at all once the purge has started, even inside the retention period", async () => {
    state.event = ended(1);
    stored({ enabled: false, retentionDays: 90 }, { purgeStartedAt: new Date() });
    await expect(service.config("event", { enabled: true }, "admin")).rejects.toMatchObject(refused);
    stored({ enabled: true, retentionDays: 90 }, { purgeStartedAt: new Date(), purgedAt: new Date() });
    await expect(service.config("event", { logoUrl: "https://example.test/logo.png" }, "admin")).rejects.toMatchObject(refused);
  });

  it("still saves edits that do not enable networking after retention", async () => {
    state.event = ended(100);
    stored({ enabled: false, retentionDays: 90 }, { purgeStartedAt: new Date() });
    await expect(service.config("event", { logoUrl: "https://example.test/logo.png" }, "admin")).resolves.toMatchObject({ enabled: false });
    // An already-enabled event (purge not started yet) keeps accepting edits; the purge disables it.
    stored({ enabled: true, retentionDays: 90 });
    await expect(service.config("event", { welcomeMessage: "Hello" }, "admin")).resolves.toMatchObject({ enabled: true });
  });

  it("allows extending retention and enabling before the purge started, while the new limit is ahead", async () => {
    state.event = ended(100);
    stored({ enabled: false, retentionDays: 90 });
    await expect(service.config("event", { enabled: true, retentionDays: 365 }, "admin")).resolves.toMatchObject({ enabled: true, retentionDays: 365 });
  });
});

describe("NetworkingAdminService config consent mapping and sync", () => {
  const form = (type: string) => ({ schema: { fields: [{ id: "consent_field", type }] } });
  it.each(["checkbox", "radio", "dropdown"])("accepts a consent mapping to a %s field", async (type) => {
    state.forms = [form(type)];
    await expect(service.config("event", { fieldMapping: { consent: "consent_field" } })).resolves.toHaveProperty("revision");
  });
  it.each([["a text field", [form("text")]], ["a deleted field", [form("radio")].map(() => ({ schema: { fields: [] } }))], ["no form", []]])("rejects a consent mapping to %s", async (_label, forms) => {
    state.forms = forms;
    await expect(service.config("event", { fieldMapping: { consent: "consent_field" } })).rejects.toMatchObject({ status: 400, response: { code: "NETWORKING_VALIDATION" } });
    expect(state.audits).toEqual([]);
  });
  it("requests the registration re-sync after commit, and returns the committed config and revision even when that request fails", async () => {
    state.sync.mockRejectedValue(new Error("sync request failed"));
    const result = await service.config("event", { enabled: true, meetingsEnabled: false }, "admin");
    // Module gates ride the config transaction's connection.
    expect(vi.mocked(assertClientModuleEnabled).mock.calls).toEqual([
      ["client", "registrations", state.tx], ["client", "emails", state.tx],
    ]);
    expect(state.sync).toHaveBeenCalledWith("event");
    expect(result).toMatchObject({ enabled: true, revision: expect.any(String) });
    expect(state.row!.config.enabled).toBe(true);
  });
});

describe("NetworkingAdminService profile photo removal", () => {
  it.each([
    ["https://storage.example/networking/event/profiles/p/photo.webp", "networking/event/profiles/p/photo.webp"],
    ["https://storage.example/forms/uploads/registrant.webp", null],
    ["https://storage.example/networking/event/profiles/other/photo.webp", null],
  ])("removing %s deletes only the participant's own upload after commit", async (photoUrl, key) => {
    state.profile = { id: "p", eventId: "event", photoUrl, overrides: {} };
    const row = await service.updateProfile("event", "p", { photoUrl: null }, "admin");
    expect(row).toMatchObject({ photoUrl: null, overrides: { photoUrl: null } });
    if (key) expect(state.delete).toHaveBeenCalledWith(key);
    else expect(state.delete).not.toHaveBeenCalled();
  });
});

describe("NetworkingAdminService withdrawn participants", () => {
  it("refuses to edit a withdrawn profile (409), writing nothing", async () => {
    state.profile = { id: "p", eventId: "event", photoUrl: null, overrides: {}, withdrawnAt: new Date("2030-06-01Z") };
    await expect(service.updateProfile("event", "p", { bio: "restored", status: "ACTIVE" }, "admin")).rejects.toMatchObject({
      status: 409, response: { code: "NETWORKING_PROFILE_WITHDRAWN" },
    });
    expect(state.row).not.toHaveProperty("bio");
    expect(state.audits).toEqual([]);
    expect(state.delete).not.toHaveBeenCalled();
  });
  it("leaves erased tombstones out of the participant list", async () => {
    const profile = (id: string, erasedAt: Date | null) => ({
      id, eventId: "event", firstName: id, lastName: "", company: "", jobTitle: "", email: "", sector: "", status: "ACTIVE",
      lastActiveAt: null, withdrawnAt: erasedAt, erasedAt,
    });
    state.profiles = [profile("kept", null), profile("tombstone", new Date("2030-07-01Z"))];
    const result = await service.profiles("event", { page: 1, limit: 20 });
    expect(result.total).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual(["kept"]);
  });
});

describe("NetworkingAdminService report regeneration", () => {
  beforeEach(() => { state.row = { ...state.row!, config: NetworkingConfigSchema.parse({ enabled: true }) }; });
  it("refuses regeneration before event end", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-12-31Z"));
    await expect(service.regeneratePostEventReport("event", "admin")).rejects.toMatchObject({
      status: 409, response: { code: "NETWORKING_ACTION_NOT_ALLOWED" },
    });
    expect(state.deliveries).toEqual([]);
  });
  it("refuses regeneration when networking is disabled for the event", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2031-01-01T01:00:00Z"));
    state.row = { ...state.row!, config: NetworkingConfigSchema.parse({ enabled: false }) };
    await expect(service.regeneratePostEventReport("event", "admin")).rejects.toMatchObject({
      status: 403, response: { code: "NETWORKING_FEATURE_DISABLED" },
    });
    expect(state.deliveries).toEqual([]);
  });
  it("queues immediately after end, reuses in-flight work, and creates a new completed version", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2031-01-01T01:00:00Z"));
    const [first, duplicate] = await Promise.all([
      service.regeneratePostEventReport("event", "admin"), service.regeneratePostEventReport("event", "admin"),
    ]);
    expect(first).toEqual(duplicate);
    expect(first.availableAt).toEqual(new Date());
    expect(first.version).toBe(first.deliveryId);
    expect(state.deliveries).toHaveLength(1);
    expect(state.audits).toMatchObject([{ actorId: "admin", action: "POST_EVENT_REPORT_REGENERATE" }]);
    state.deliveries[0].status = "SENT";
    const second = await service.regeneratePostEventReport("event", "admin");
    expect(second.version).not.toBe(first.version);
    expect(state.deliveries[1].dedupeKey).not.toBe(state.deliveries[0].dedupeKey);
  });
});

describe("NetworkingAdminService meeting assignment", () => {
  const startsAt = new Date("2099-01-01T09:00:00Z"), endsAt = new Date("2099-01-01T09:30:00Z");
  function harness() {
    const plans: unknown[] = [];
    const store = {
      one: async (kind: string) => kind === "meetings" ? state.meeting : kind === "profiles" ? { id: "a" } : { id: "event" },
      update: async (_kind: string, _where: unknown, values: object) => [{ ...state.meeting, ...values }],
      insert: async () => ({}),
      remove: async () => undefined,
    };
    const meetings = {
      allocation: vi.fn(async (_eventId: string, plan: () => Promise<unknown>, run: (store: unknown, db: unknown) => Promise<unknown>) => {
        plans.push(await plan());
        return run(store, state.tx);
      }),
      reserve: vi.fn(async () => ({ tableId: "t", status: "CONFIRMED" })),
      notify: vi.fn(),
      hydrate: vi.fn(async (row: unknown) => row),
    };
    return { plans, meetings, admin: new NetworkingAdminService({} as NetworkingService, meetings as unknown as NetworkingMeetingsService) };
  }
  beforeEach(() => {
    state.transition.mockReset().mockImplementation(async (_db, transition: string, _event, ids: string[], set = {}) =>
      ids.map((id) => ({ ...state.meeting, ...set, id, status: ({ CANCEL: "CANCELLED", COMPLETED: "COMPLETED", NO_SHOW: "NO_SHOW" } as Record<string, string>)[transition] })));
  });
  it("locks the meeting's own slot to assign a table and nothing to cancel it", async () => {
    state.meeting = { id: "m", eventId: "event", requesterId: "a", recipientId: "b", status: "CONFIRMED", startsAt, endsAt, revision: 1 };
    const { plans, meetings, admin } = harness();
    await admin.updateMeeting("event", "m", { action: "ASSIGN", tableId: "t" }, "admin");
    expect(meetings.reserve).toHaveBeenCalledWith(expect.anything(), state.meeting, startsAt, endsAt, expect.anything(), "t", false);
    await admin.updateMeeting("event", "m", { action: "CANCEL" }, "admin");
    expect(plans).toEqual([[{ startsAt, endsAt }], []]);
    // Cancelling is the lifecycle's CANCEL transition, which releases the reservations; the notice says why.
    expect(state.transition).toHaveBeenCalledWith(state.tx, "CANCEL", "event", ["m"], { proposedStartsAt: null, proposalBy: null });
    expect(meetings.notify).toHaveBeenLastCalledWith({ event: expect.anything() }, expect.objectContaining({ status: "CANCELLED" }),
      "MEETING_CANCEL", ["a", "b"], state.tx, { reason: "ORGANIZER" });
  });
  it.each(["COMPLETED", "NO_SHOW"] as const)("records %s once a confirmed meeting started, through a transition that keeps its reservations", async (action) => {
    state.meeting = { id: "m", eventId: "event", requesterId: "a", recipientId: "b", status: "CONFIRMED", startsAt: new Date(Date.now() + 60_000), endsAt, revision: 1 };
    const { admin } = harness();
    await expect(admin.updateMeeting("event", "m", { action }, "admin")).rejects.toThrow("once a confirmed meeting starts");
    expect(state.transition).not.toHaveBeenCalled();
    state.meeting = { ...state.meeting, startsAt: new Date(Date.now() - 60_000) };
    expect(await admin.updateMeeting("event", "m", { action }, "admin")).toMatchObject({ status: action });
    expect(state.transition).toHaveBeenCalledWith(state.tx, action, "event", ["m"], {});
  });
});
