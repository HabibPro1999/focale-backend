import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns, getTableName, is, type SQL } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { NETWORKING_PROFESSIONAL_FIELDS } from "@app/contracts";
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  txSelect: vi.fn(),
  txSet: vi.fn(),
  enqueue: vi.fn(),
  revoke: vi.fn(),
  cancel: vi.fn(),
  order: [] as string[],
}));
const chain = (result: () => Promise<unknown>) => ({ from: () => ({ where: result }) });
vi.mock("../client", () => ({
  getDb: () => ({ execute: mocks.execute, select: () => chain(mocks.select) }),
}));
vi.mock("../txn", () => ({
  withSerializableTxn: (run: (tx: unknown) => Promise<unknown>) => run({
    select: () => chain(mocks.txSelect),
    update: () => ({ set: (values: unknown) => ({ where: () => mocks.txSet(values) }) }),
  }),
}));
vi.mock("./storage-delete", () => ({ enqueueNetworkingPhotoDeletes: mocks.enqueue }));
vi.mock("./networking", () => ({
  revokeNetworkingSessions: mocks.revoke,
  cancelNetworkingParticipantMeetings: mocks.cancel,
}));
import * as schema from "../schema";
import { networkingProfiles } from "../schema/networking";
import {
  NETWORKING_ERASURE_STEPS,
  NETWORKING_PROFILE_TOMBSTONE,
  NETWORKING_WITHDRAWAL_SCRUBBED_COLUMNS,
  eraseNetworkingProfile,
  eraseWithdrawnNetworkingProfiles,
  networkingProfilesToErase,
  withdrawNetworkingProfile,
} from "./networking-erasure";

const dialect = new PgDialect({ casing: "snake_case" });
const text = (query: SQL) => dialect.sqlToQuery(query);
const executed = () => mocks.execute.mock.calls.map(([query]) => text(query));
const schemaTables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.order = [];
  mocks.execute.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("the tombstone, derived from the Drizzle schema", () => {
  it("classifies every networking_profiles column as kept or scrubbed", () => {
    // A new column fails here (and in the type) until it is classified.
    expect(Object.keys(NETWORKING_PROFILE_TOMBSTONE).sort()).toEqual(Object.keys(getTableColumns(networkingProfiles)).sort());
    const kept = Object.entries(NETWORKING_PROFILE_TOMBSTONE).filter(([, fate]) => fate === "keep").map(([column]) => column);
    expect(kept.sort()).toEqual(["createdAt", "erasedAt", "eventId", "id", "registrationId", "updatedAt", "withdrawnAt"]);
  });

  it("leaves nothing personal: every scrubbed text is empty or null, every list and map empty", () => {
    for (const [column, fate] of Object.entries(NETWORKING_PROFILE_TOMBSTONE)) {
      if (fate === "keep") continue;
      const value = fate.scrub as unknown;
      if (value === null || value === "" || value === false) continue;
      if (Array.isArray(value)) expect(value, column).toEqual([]);
      else if (typeof value === "object") expect(value, column).toEqual({});
      // Enumerations reset to a fixed value that says nothing about the person.
      else expect([["status", "EXCLUDED"], ["emailPreference", "OFF"], ["language", "fr"]], column).toContainEqual([column, value]);
    }
  });

  it("scrubs every professional field and override at withdrawal, keeping only what the erasure needs", () => {
    for (const field of NETWORKING_PROFESSIONAL_FIELDS) expect(NETWORKING_WITHDRAWAL_SCRUBBED_COLUMNS).toContain(field);
    expect(NETWORKING_WITHDRAWAL_SCRUBBED_COLUMNS).toContain("overrides");
    for (const column of NETWORKING_WITHDRAWAL_SCRUBBED_COLUMNS) expect(NETWORKING_PROFILE_TOMBSTONE[column], column).not.toBe("keep");
  });
});

describe("erasure coverage, derived from the Drizzle foreign keys", () => {
  it("clears every foreign key to networking_profiles in some step on that table", () => {
    const missing: string[] = [];
    for (const table of schemaTables)
      for (const foreignKey of getTableConfig(table).foreignKeys) {
        const reference = foreignKey.reference();
        if (reference.foreignTable !== networkingProfiles) continue;
        for (const column of reference.columns)
          if (!NETWORKING_ERASURE_STEPS.some((step) => step.table === table && step.covers.includes(column)))
            missing.push(`${getTableName(table)}.${column.name}`);
      }
    expect(missing).toEqual([]);
    expect(NETWORKING_ERASURE_STEPS.flatMap((step) => step.covers).length).toBeGreaterThanOrEqual(17);
  });

  it("clears referencing rows before the rows they reference, and never deletes a profile or config", () => {
    const position = new Map(NETWORKING_ERASURE_STEPS.map((step, index) => [step.table, index]));
    const violations: string[] = [];
    for (const step of NETWORKING_ERASURE_STEPS)
      for (const foreignKey of getTableConfig(step.table).foreignKeys) {
        const target = position.get(foreignKey.reference().foreignTable);
        if (target !== undefined && target < position.get(step.table)!) violations.push(`${step.name} → ${getTableName(foreignKey.reference().foreignTable)}`);
      }
    expect(violations).toEqual([]);
    expect(NETWORKING_ERASURE_STEPS.map((step) => step.name)).not.toContain("networking_profiles");
    expect(NETWORKING_ERASURE_STEPS.map((step) => step.name)).not.toContain("networking_configs");
    expect(new Set(NETWORKING_ERASURE_STEPS.map((step) => step.name)).size).toBe(NETWORKING_ERASURE_STEPS.length);
  });
});

describe("eraseNetworkingProfile", () => {
  const withdrawn = { eventId: "event", email: "Person@Example.invalid", withdrawnAt: new Date("2026-01-01"), erasedAt: null };

  it("refuses a profile that has not withdrawn", async () => {
    mocks.select.mockResolvedValue([{ ...withdrawn, withdrawnAt: null }]);
    await expect(eraseNetworkingProfile("p")).rejects.toThrow("has not withdrawn");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("has nothing to do for a missing or already erased profile", async () => {
    mocks.select.mockResolvedValueOnce([]);
    expect(await eraseNetworkingProfile("gone")).toEqual({ profileId: "gone", eventId: null, done: true, erased: false, deleted: {} });
    mocks.select.mockResolvedValueOnce([{ ...withdrawn, erasedAt: new Date() }]);
    expect(await eraseNetworkingProfile("p")).toMatchObject({ done: true, erased: true, deleted: {} });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it("drains every step in bounded batches, then scrubs the row to its tombstone last", async () => {
    mocks.select.mockResolvedValue([withdrawn]);
    let audit = 0;
    mocks.execute.mockImplementation(async (query: SQL) => {
      mocks.order.push("batch");
      if (text(query).sql.includes('DELETE FROM "networking_audit"')) return { rowCount: [2, 1][audit++] ?? 0 };
      return { rowCount: 0 };
    });
    mocks.txSelect.mockResolvedValue([{ photoUrl: "https://cdn.test/networking/event/profiles/p/old.webp" }]);
    mocks.enqueue.mockImplementation(async () => { mocks.order.push("enqueue"); });
    mocks.txSet.mockImplementation(async () => { mocks.order.push("tombstone"); });
    const batches: Array<[string, number]> = [];
    const result = await eraseNetworkingProfile("p", { batchSize: 2, onBatch: (table, count) => batches.push([table, count]) });

    expect(result).toEqual({ profileId: "p", eventId: "event", done: true, erased: true, deleted: { networking_audit: 3 } });
    expect(batches.slice(0, 3)).toEqual([["networking_audit", 2], ["networking_audit", 1], ["networking_notifications", 0]]);
    expect(batches.at(-1)).toEqual(["networking_profiles", 1]);
    expect(mocks.order.slice(-2)).toEqual(["enqueue", "tombstone"]);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), [{ id: "p", eventId: "event", photoUrl: "https://cdn.test/networking/event/profiles/p/old.webp" }], "networking.erasure");
    const values = mocks.txSet.mock.calls[0][0] as Record<string, unknown>;
    expect(values.erasedAt).toBeInstanceOf(Date);
    for (const [column, fate] of Object.entries(NETWORKING_PROFILE_TOMBSTONE))
      if (fate === "keep") expect(["erasedAt", "updatedAt"].includes(column) || !(column in values), column).toBe(true);
      else expect(values[column], column).toEqual(fate.scrub);

    const statements = executed();
    for (const statement of statements) {
      expect(statement.sql).toMatch(/LIMIT \$\d+/);
      // Every statement is keyed by the profile, or (codes) by its address.
      expect(statement.params.some((param) => param === "p" || param === "person@example.invalid"), statement.sql).toBe(true);
    }
    const emails = statements.find((statement) => statement.sql.includes('DELETE FROM "email_logs"'))!;
    expect(emails.sql).toContain(`("email_logs"."context_snapshot" ->> 'eventId') = $`);
    // Email-keyed rows match case-insensitively on the address the profile held.
    expect(emails.params).toContain("person@example.invalid");
    const audits = statements.find((statement) => statement.sql.includes('DELETE FROM "networking_audit"'))!;
    expect(audits.params).toContain("POST_EVENT_REPORT");
    const stands = statements.find((statement) => statement.sql.includes('UPDATE "networking_tables"'))!;
    expect(stands.sql).toContain("SET owner_profile_id=NULL");
  });

  it("stops at the deadline without the tombstone, so the next run resumes", async () => {
    mocks.select.mockResolvedValue([withdrawn]);
    expect(await eraseNetworkingProfile("p", { deadline: Date.now() - 1 })).toEqual({ profileId: "p", eventId: "event", done: false, erased: false, deleted: {} });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it("does not match email-keyed rows once the address is empty", async () => {
    mocks.select.mockResolvedValue([{ ...withdrawn, email: "" }]);
    mocks.txSelect.mockResolvedValue([{ photoUrl: null }]);
    await eraseNetworkingProfile("p");
    const challenges = executed().find((statement) => statement.sql.includes('DELETE FROM "networking_challenges"'))!;
    expect(challenges.sql).toContain("AND FALSE");
  });
});

describe("withdrawal erasure selection", () => {
  it("selects withdrawn, not yet erased profiles past the window, oldest first", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "p", event_id: "event", withdrawn_at: "2026-01-01T00:00:00.000Z" }] });
    expect(await networkingProfilesToErase({ eraseDays: 30, eventId: "event", limit: 5 })).toEqual([
      { profileId: "p", eventId: "event", withdrawnAt: new Date("2026-01-01T00:00:00.000Z") },
    ]);
    const [query] = executed();
    expect(query.sql).toContain("withdrawn_at IS NOT NULL AND erased_at IS NULL AND withdrawn_at < now() - interval '1 day'*$1::int");
    expect(query.sql).toContain("ORDER BY withdrawn_at, id LIMIT");
    expect(query.params).toEqual([30, "event", 5]);
  });

  it("maintenance stops within its budget and after an unfinished erasure", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ id: "p", event_id: "event", withdrawn_at: new Date() }, { id: "q", event_id: "event", withdrawn_at: new Date() }] });
    mocks.select.mockResolvedValue([{ eventId: "event", email: "", withdrawnAt: new Date(), erasedAt: null }]);
    // A spent budget: the first profile is not even started.
    expect(await eraseWithdrawnNetworkingProfiles({ eraseDays: 30, budgetMs: -1 })).toEqual([]);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});

describe("withdrawNetworkingProfile", () => {
  function fakeDb() {
    const db = {
      select: () => chain(async () => { mocks.order.push("read"); return [{ photoUrl: "https://cdn.test/networking/e/profiles/p/a.webp" }]; }),
      update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { mocks.order.push("scrub"); db.values = values; } }) }),
      execute: async (query: SQL) => { mocks.order.push(text(query).sql); return { rowCount: 0 }; },
      values: {} as Record<string, unknown>,
    };
    return db;
  }

  it("scrubs the content and clears push, availability, embeddings and unsent deliveries in the caller's transaction", async () => {
    const db = fakeDb();
    mocks.revoke.mockImplementation(async () => { mocks.order.push("revoke"); });
    mocks.cancel.mockImplementation(async () => { mocks.order.push("cancel"); });
    mocks.enqueue.mockImplementation(async () => { mocks.order.push("enqueue"); });
    await withdrawNetworkingProfile(db as never, { eventId: "e", profileId: "p", slug: "event" });

    expect(db.values.withdrawnAt).toBeInstanceOf(Date);
    for (const column of NETWORKING_WITHDRAWAL_SCRUBBED_COLUMNS) {
      const fate = NETWORKING_PROFILE_TOMBSTONE[column];
      if (fate !== "keep") expect(db.values[column], column).toEqual(fate.scrub);
    }
    // Name and email stay for the window (reports, email-keyed rows at erasure).
    for (const column of ["email", "firstName", "lastName", "status"]) expect(db.values, column).not.toHaveProperty(column);
    expect(mocks.revoke).toHaveBeenCalledWith("p", db);
    expect(mocks.cancel).toHaveBeenCalledWith("p", "e", db, { slug: "event" });
    expect(mocks.enqueue).toHaveBeenCalledWith(db, [{ id: "p", eventId: "e", photoUrl: "https://cdn.test/networking/e/profiles/p/a.webp" }], "networking.withdrawal");
    const deletes = mocks.order.filter((step) => step.startsWith("DELETE"));
    expect(deletes.map((statement) => /DELETE FROM "(\w+)"/.exec(statement)![1])).toEqual([
      "networking_push_subscriptions", "networking_availability", "networking_embeddings", "networking_embedding_jobs", "networking_deliveries",
    ]);
    expect(deletes.at(-1)).toContain(`"networking_deliveries"."status" IN ('PENDING','PROCESSING','FAILED')`);
    // The cancellation notices (including the participant's own copy) are queued before the unsent deliveries go.
    expect(mocks.order.indexOf("cancel")).toBeLessThan(mocks.order.indexOf(deletes.at(-1)!));
    expect(mocks.order[0]).toBe("read");
    expect(mocks.order[1]).toBe("scrub");
  });

  it("does nothing for a profile outside the event", async () => {
    const db = { ...fakeDb(), select: () => chain(async () => []) };
    await withdrawNetworkingProfile(db as never, { eventId: "e", profileId: "p" });
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
