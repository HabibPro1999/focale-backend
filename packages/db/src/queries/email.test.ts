import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DbExecutor } from "../client";

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
  getRegistrationForEmailContext,
  getRegistrationFormLanguage,
  getRegistrationsForEmailContextByIds,
  insertEmailTemplate,
  EMAIL_LOGS_REGISTRATION_TRIGGER_ACTIVE_KEY,
  EMAIL_LOGS_TEMPLATE_RECIPIENT_TRIGGER_ACTIVE_KEY,
  EMAIL_TEMPLATE_REGISTRATION_UNIQ,
} from "./email";

const dialect = new PgDialect({ casing: "snake_case" });
const render = (sql: SQL) => dialect.sqlToQuery(sql);

// Fake select chain: records the selected fields, each left join's ON clause and
// the WHERE clause, then resolves the canned rows (via limit() or a bare await).
function fakeSelectExec(rows: unknown[]) {
  const seen = {
    fields: {} as Record<string, SQL>,
    leftJoins: [] as string[],
    where: undefined as { sql: string; params: unknown[] } | undefined,
  };
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: (_table: unknown, on: SQL) => {
      seen.leftJoins.push(render(on).sql);
      return chain;
    },
    where: (condition: SQL) => {
      seen.where = render(condition);
      return chain;
    },
    limit: () => Promise.resolve(rows),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
  const exec = {
    select: (fields: Record<string, SQL>) => {
      seen.fields = fields;
      return chain;
    },
  } as unknown as DbExecutor;
  return { exec, seen };
}

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

describe("registration email context — form language", () => {
  const FORM_JOIN = '"forms"."id" = "registrations"."form_id"';
  const row = (id: string, formLanguages: unknown) => ({
    registration: { id, formId: "form-1" },
    event: { id: "event-1", slug: "conf" },
    client: { name: "Org", email: null, phone: null },
    formLanguages,
  });

  it("takes the primary language of the registration's own form", async () => {
    const { exec, seen } = fakeSelectExec([row("reg-1", ["en", "fr"])]);
    const ctx = await getRegistrationForEmailContext("reg-1", exec);

    expect(ctx?.language).toBe("en");
    expect(seen.leftJoins).toEqual([FORM_JOIN]);
    // Only settings.languages is read, not the whole schema jsonb.
    expect(render(seen.fields.formLanguages).sql).toBe(
      `"forms"."schema" -> 'settings' -> 'languages'`,
    );
  });

  it("defaults to fr when the form sets no languages", async () => {
    const { exec } = fakeSelectExec([row("reg-1", null)]);
    const ctx = await getRegistrationForEmailContext("reg-1", exec);
    expect(ctx?.language).toBe("fr");
  });

  it("maps each registration's language in the batched worker read", async () => {
    const { exec, seen } = fakeSelectExec([
      row("reg-1", ["ar", "fr"]),
      row("reg-2", undefined),
    ]);
    const regs = await getRegistrationsForEmailContextByIds(
      ["reg-1", "reg-2"],
      exec,
    );

    expect(regs.map((r) => [r.id, r.language])).toEqual([
      ["reg-1", "ar"],
      ["reg-2", "fr"],
    ]);
    expect(seen.leftJoins).toEqual([FORM_JOIN]);
  });

  it("getRegistrationFormLanguage reads the event's REGISTRATION form", async () => {
    const { exec, seen } = fakeSelectExec([{ languages: ["en"] }]);
    expect(await getRegistrationFormLanguage("event-1", exec)).toBe("en");
    expect(seen.where?.sql).toContain('"forms"."type" = $2');
    expect(seen.where?.params).toEqual(["event-1", "REGISTRATION"]);

    const { exec: noForm } = fakeSelectExec([]);
    expect(await getRegistrationFormLanguage("event-1", noForm)).toBe("fr");
  });
});
