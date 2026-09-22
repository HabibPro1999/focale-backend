import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKING_CONFIG_UNCONFIGURED_REVISION, NetworkingConfigSchema, UpdateNetworkingConfigSchema } from "@app/contracts";
import type { NetworkingRow, NetworkingStore } from "@app/db";
const state = vi.hoisted(() => ({
  row: null as NetworkingRow<"configs"> | null,
  transaction: false,
  requireTransaction: false,
  audits: [] as unknown[],
  deliveries: [] as any[],
  tail: Promise.resolve() as Promise<unknown>,
}));
vi.mock("@app/db", () => {
  const store = {
    one: async (kind: string) => {
      if (kind === "configs") {
        if (state.requireTransaction) expect(state.transaction).toBe(true);
        return state.row;
      }
      return { id: "event", startDate: new Date("2030-01-01Z"), endDate: new Date("2031-01-01Z") };
    },
    all: async (kind: string) => kind === "deliveries" ? state.deliveries : [],
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
  it("accepts matching revisions and strips both transport fields from storage and audit", async () => {
    const patch = UpdateNetworkingConfigSchema.parse({ expectedRevision: revision, revision: "ignored", requireSecondFactor: true });
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

describe("NetworkingAdminService report regeneration", () => {
  it("refuses regeneration before event end", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-12-31Z"));
    await expect(service.regeneratePostEventReport("event", "admin")).rejects.toMatchObject({
      status: 409, response: { code: "NETWORKING_VALIDATION" },
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
    expect(state.audits).toMatchObject([{ actorId: "admin", action: "post_event_report.regenerate" }]);
    state.deliveries[0].status = "SENT";
    const second = await service.regeneratePostEventReport("event", "admin");
    expect(second.version).not.toBe(first.version);
    expect(state.deliveries[1].dedupeKey).not.toBe(state.deliveries[0].dedupeKey);
  });
});
