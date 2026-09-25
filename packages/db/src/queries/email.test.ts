import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake drizzle handle: insert(...).values(...).returning() resolves or rejects
// per the test. No live DB needed — we only exercise the 23505 race-guard branch.
const returning = vi.fn();
const fakeDb = {
  insert: () => ({ values: () => ({ returning }) }),
};

vi.mock("../client", () => ({
  getDb: () => fakeDb,
}));

import type { DbExecutor } from "../client";
import {
  createEmailLog,
  insertEmailLogsSkippingConflicts,
  insertEmailTemplate,
  EMAIL_LOG_INSERT_CHUNK_SIZE,
  EMAIL_LOGS_REGISTRATION_TRIGGER_ACTIVE_KEY,
  EMAIL_LOGS_TEMPLATE_RECIPIENT_TRIGGER_ACTIVE_KEY,
  EMAIL_TEMPLATE_REGISTRATION_UNIQ,
} from "./email";

function pgUnique(constraint: string) {
  return Object.assign(new Error("duplicate key value"), {
    code: "23505",
    constraint,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createEmailLog race guard", () => {
  it("returns ok with the row on success", async () => {
    returning.mockResolvedValue([{ id: "log-1" }]);
    const res = await createEmailLog({
      recipientEmail: "a@x.com",
      subject: "s",
    } as never);
    expect(res).toEqual({ ok: true, log: { id: "log-1" } });
  });

  it("maps a registration+trigger dedupe index violation to a conflict", async () => {
    returning.mockRejectedValue(
      pgUnique(EMAIL_LOGS_REGISTRATION_TRIGGER_ACTIVE_KEY),
    );
    const res = await createEmailLog({
      recipientEmail: "a@x.com",
      subject: "s",
    } as never);
    expect(res).toEqual({
      ok: false,
      conflictIndex: EMAIL_LOGS_REGISTRATION_TRIGGER_ACTIVE_KEY,
    });
  });

  it("maps a template+recipient+trigger dedupe index violation to a conflict", async () => {
    returning.mockRejectedValue(
      pgUnique(EMAIL_LOGS_TEMPLATE_RECIPIENT_TRIGGER_ACTIVE_KEY),
    );
    const res = await createEmailLog({
      recipientEmail: "a@x.com",
      subject: "s",
    } as never);
    expect(res).toMatchObject({ ok: false });
  });

  it("rethrows any other unique violation", async () => {
    returning.mockRejectedValue(pgUnique("some_other_key"));
    await expect(
      createEmailLog({ recipientEmail: "a@x.com", subject: "s" } as never),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("insertEmailTemplate race guard", () => {
  it("returns ok with the row on success", async () => {
    returning.mockResolvedValue([{ id: "tmpl-1" }]);
    const res = await insertEmailTemplate({ name: "n" } as never);
    expect(res).toEqual({ ok: true, template: { id: "tmpl-1" } });
  });

  it("maps a one-active-template index violation to a conflict", async () => {
    returning.mockRejectedValue(pgUnique(EMAIL_TEMPLATE_REGISTRATION_UNIQ));
    const res = await insertEmailTemplate({ name: "n" } as never);
    expect(res).toEqual({
      ok: false,
      conflictIndex: EMAIL_TEMPLATE_REGISTRATION_UNIQ,
    });
  });

  it("rethrows non-template unique violations", async () => {
    returning.mockRejectedValue(pgUnique("unrelated_key"));
    await expect(
      insertEmailTemplate({ name: "n" } as never),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("insertEmailLogsSkippingConflicts", () => {
  // Records each INSERT: its rows and the ON CONFLICT target; `refuse` ids are
  // left out of RETURNING, as a unique index would.
  function recordingExec(refuse: (id: string) => boolean = () => false) {
    const statements: { rows: Array<{ id: string }>; conflictTarget: unknown }[] = [];
    const exec = {
      insert: () => ({
        values: (rows: Array<{ id: string }>) => ({
          onConflictDoNothing: (config?: unknown) => ({
            returning: async () => {
              statements.push({ rows, conflictTarget: config });
              return rows.filter((row) => !refuse(row.id)).map(({ id }) => ({ id }));
            },
          }),
        }),
      }),
    } as unknown as DbExecutor;
    return { exec, statements };
  }

  const log = (overrides: Record<string, unknown> = {}) =>
    ({ recipientEmail: "a@x.com", subject: "", status: "QUEUED", ...overrides }) as never;

  it("inserts with a target-less ON CONFLICT DO NOTHING and returns the kept ids", async () => {
    const { exec, statements } = recordingExec((id) => id === "log-2");
    const kept = await insertEmailLogsSkippingConflicts(
      [log({ id: "log-1" }), log({ id: "log-2" }), log({ id: "log-3" })],
      exec,
    );
    expect(kept).toEqual(new Set(["log-1", "log-3"]));
    expect(statements).toHaveLength(1);
    expect(statements[0].conflictTarget).toBeUndefined();
  });

  it("gives every row an id so skipped rows can be told apart", async () => {
    const { exec, statements } = recordingExec();
    const kept = await insertEmailLogsSkippingConflicts([log(), log()], exec);
    const ids = statements[0].rows.map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(kept).toEqual(new Set(ids));
  });

  it("splits large batches into statements of EMAIL_LOG_INSERT_CHUNK_SIZE rows", async () => {
    const { exec, statements } = recordingExec();
    const kept = await insertEmailLogsSkippingConflicts(
      Array.from({ length: 2 * EMAIL_LOG_INSERT_CHUNK_SIZE + 1 }, () => log()),
      exec,
    );
    expect(statements.map((statement) => statement.rows.length)).toEqual([
      EMAIL_LOG_INSERT_CHUNK_SIZE,
      EMAIL_LOG_INSERT_CHUNK_SIZE,
      1,
    ]);
    expect(kept.size).toBe(2 * EMAIL_LOG_INSERT_CHUNK_SIZE + 1);
  });

  it("does nothing for an empty batch", async () => {
    const { exec, statements } = recordingExec();
    await expect(insertEmailLogsSkippingConflicts([], exec)).resolves.toEqual(new Set());
    expect(statements).toHaveLength(0);
  });
});
