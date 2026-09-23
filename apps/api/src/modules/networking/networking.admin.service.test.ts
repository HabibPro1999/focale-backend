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
  delete: vi.fn(),
  sync: vi.fn(),
  tail: Promise.resolve() as Promise<unknown>,
}));
vi.mock("@app/db", () => {
  const store = {
    one: async (kind: string) => {
      if (kind === "profiles" && state.profile) return state.profile;
      if (kind === "configs") {
        if (state.requireTransaction) expect(state.transaction).toBe(true);
        return state.row;
      }
      return { id: "event", startDate: new Date("2030-01-01Z"), endDate: new Date("2031-01-01Z") };
    },
    all: async (kind: string) => kind === "deliveries" ? state.deliveries : kind === "forms" ? state.forms : [],
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
    syncNetworkingEvent: state.sync,
    networkingFormField: (schema: { fields?: { id: string }[] }, id: string) => schema.fields?.find((field) => field.id === id),
    networkingStore: () => store,
    networkingTransaction: (_eventId: string, run: (store: NetworkingStore) => Promise<unknown>) => {
      const result = state.tail.then(async () => {
        state.transaction = true;
        try { return await run(store as unknown as NetworkingStore); }
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
import { ZodValidationPipe } from "../../core/zod";
import { NetworkingConfigDto } from "./networking.dto";
import { NetworkingAdminService } from "./networking.admin.service";
import type { NetworkingService } from "./networking.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
const service = new NetworkingAdminService({} as NetworkingService, {} as NetworkingMeetingsService);
const revision = "2030-01-01T00:00:00.000Z";
beforeEach(() => {
  state.row = { eventId: "event", config: NetworkingConfigSchema.parse({}), createdAt: new Date(revision), updatedAt: new Date(revision) };
  state.transaction = false;
  state.requireTransaction = false;
  state.audits = [];
  state.deliveries = [];
  state.forms = [];
  state.profile = null;
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
  it("returns the committed config and revision even when the registration re-sync fails", async () => {
    state.sync.mockRejectedValue(new Error("sync crashed"));
    const result = await service.config("event", { enabled: true, meetingsEnabled: false }, "admin");
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
