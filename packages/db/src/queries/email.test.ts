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

import {
  createEmailLog,
  insertEmailTemplate,
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
