import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";

vi.mock("../client", () => ({ getDb: () => undefined }));

import type { DbExecutor } from "../client";
import { getRegistrationsForCertificateSend } from "./certificates";
import {
  getRegistrationForEmailContext,
  getRegistrationsForEmailContextByIds,
} from "./email";

// The three "registration + event + client + form language" reads: the email
// send (by id), the worker's batched send (by ids) and the certificate send
// (by event). The real drizzle builders render the SQL; each awaited select
// resolves the next canned rows.

const mockDb = drizzle.mock({ casing: "snake_case" });

function recordingExec(results: unknown[][]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const select = (fields: never) => {
    const builder = mockDb.select(fields);
    const from = builder.from.bind(builder);
    builder.from = ((table: never) => {
      const query = from(table);
      Object.assign(query, {
        then: (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) => {
          queries.push(query.toSQL());
          return Promise.resolve(results.shift() ?? []).then(resolve, reject);
        },
      });
      return query;
    }) as typeof builder.from;
    return builder;
  };
  return { exec: { select } as unknown as DbExecutor, queries };
}

const CONTEXT_FIELDS_TAIL =
  `"clients"."name", "clients"."email", "clients"."phone", ` +
  `"forms"."schema" -> 'settings' -> 'languages'`;
const CONTEXT_FROM =
  ` from "registrations"` +
  ` inner join "events" on "events"."id" = "registrations"."event_id"` +
  ` inner join "clients" on "clients"."id" = "events"."client_id"` +
  ` left join "forms" on "forms"."id" = "registrations"."form_id"`;

/** The select list and the rest (WHERE / LIMIT) of a context read. */
function splitContextQuery(sql: string): { select: string; rest: string } {
  const [select, rest, ...more] = sql.split(CONTEXT_FROM);
  expect(more).toEqual([]);
  expect(select.startsWith(`select "registrations"."id", `)).toBe(true);
  expect(select.endsWith(CONTEXT_FIELDS_TAIL)).toBe(true);
  return { select, rest };
}

function row(id: string, formLanguages: unknown) {
  return {
    registration: { id, eventId: "event-1", email: `${id}@x.test` },
    event: { id: "event-1", name: "Conf" },
    client: { name: "Org", email: "org@x.test", phone: null },
    formLanguages,
  };
}

function context(id: string, language: string) {
  return {
    id,
    eventId: "event-1",
    email: `${id}@x.test`,
    language,
    event: {
      id: "event-1",
      name: "Conf",
      client: { name: "Org", email: "org@x.test", phone: null },
    },
  };
}

describe("registration email context reads", () => {
  it("run the same select and joins, with their own WHERE and LIMIT", async () => {
    const byId = recordingExec([]);
    await getRegistrationForEmailContext("reg-1", byId.exec);
    const byIds = recordingExec([]);
    await getRegistrationsForEmailContextByIds(["reg-1", "reg-2"], byIds.exec);
    const all = recordingExec([]);
    await getRegistrationsForCertificateSend("event-1", undefined, all.exec);
    const listed = recordingExec([]);
    await getRegistrationsForCertificateSend("event-1", ["reg-1"], listed.exec);
    const none = recordingExec([]);
    await getRegistrationsForCertificateSend("event-1", [], none.exec);

    const queries = [byId, byIds, all, listed, none].map(({ queries }) => {
      expect(queries).toHaveLength(1);
      return queries[0];
    });
    const parts = queries.map((query) => splitContextQuery(query.sql));
    for (const part of parts) expect(part.select).toBe(parts[0].select);

    expect(parts.map((part) => part.rest)).toEqual([
      ` where "registrations"."id" = $1 limit $2`,
      ` where "registrations"."id" in ($1, $2)`,
      ` where "registrations"."event_id" = $1`,
      ` where ("registrations"."event_id" = $1 and "registrations"."id" in ($2))`,
      ` where ("registrations"."event_id" = $1 and false)`,
    ]);
    expect(queries.map((query) => query.params)).toEqual([
      ["reg-1", 1],
      ["reg-1", "reg-2"],
      ["event-1"],
      ["event-1", "reg-1"],
      ["event-1"],
    ]);
  });

  it("map a row to the registration, its primary language and the event with its client", async () => {
    const { exec } = recordingExec([[row("reg-1", ["en", "fr"])]]);
    const result = await getRegistrationForEmailContext("reg-1", exec);

    expect(result).toStrictEqual(context("reg-1", "en"));
    expect(Object.keys(result!)).toEqual(["id", "eventId", "email", "language", "event"]);
    expect(Object.keys(result!.event)).toEqual(["id", "name", "client"]);
  });

  it("by id: null without a row", async () => {
    const { exec } = recordingExec([[]]);
    expect(await getRegistrationForEmailContext("reg-1", exec)).toBeNull();
  });

  it("by ids: rows in read order, and no query for no ids", async () => {
    const { exec } = recordingExec([
      [row("reg-2", null), row("reg-1", ["ar"])],
    ]);
    expect(
      await getRegistrationsForEmailContextByIds(["reg-1", "reg-2"], exec),
    ).toStrictEqual([context("reg-2", "fr"), context("reg-1", "ar")]);

    const empty = recordingExec([]);
    expect(await getRegistrationsForEmailContextByIds([], empty.exec)).toEqual([]);
    expect(empty.queries).toEqual([]);
  });

  it("certificate send: then reads the check-ins of the rows it found, grouped per registration", async () => {
    const { exec, queries } = recordingExec([
      [row("reg-1", ["en"]), row("reg-2", undefined)],
      [
        { registrationId: "reg-2", accessId: "acc-b" },
        { registrationId: "reg-1", accessId: "acc-a" },
        { registrationId: "reg-2", accessId: "acc-c" },
      ],
    ]);
    const result = await getRegistrationsForCertificateSend("event-1", undefined, exec);

    expect(queries[1]).toEqual({
      sql:
        `select "registration_id", "access_id" from "access_check_ins"` +
        ` where "access_check_ins"."registration_id" in ($1, $2)`,
      params: ["reg-1", "reg-2"],
    });
    expect(result).toStrictEqual([
      { ...context("reg-1", "en"), accessCheckIns: [{ accessId: "acc-a" }] },
      {
        ...context("reg-2", "fr"),
        accessCheckIns: [{ accessId: "acc-b" }, { accessId: "acc-c" }],
      },
    ]);
    expect(Object.keys(result[0])).toEqual([
      "id",
      "eventId",
      "email",
      "language",
      "event",
      "accessCheckIns",
    ]);
  });

  it("certificate send: a registration without check-ins gets [], and no rows skip the check-in read", async () => {
    const { exec } = recordingExec([[row("reg-1", null)], []]);
    const [only] = await getRegistrationsForCertificateSend("event-1", ["reg-1"], exec);
    expect(only.accessCheckIns).toEqual([]);

    const empty = recordingExec([[]]);
    expect(
      await getRegistrationsForCertificateSend("event-1", undefined, empty.exec),
    ).toEqual([]);
    expect(empty.queries).toHaveLength(1);
  });
});
