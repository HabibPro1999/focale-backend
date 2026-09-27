import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

vi.mock("../client", () => ({ getDb: () => undefined }));

import type { DbExecutor } from "../client";
import { configureJsonbValidation, StoredJsonError } from "../jsonb";
import {
  getActiveImageReadyCertificateTemplatesByIds,
  getAlreadySentAbstractCertTemplateIds,
  getAlreadySentCertTemplateIds,
  getCertificateTemplateWithEvent,
  listActiveImageReadyCertificateTemplates,
  listCertificateTemplates,
  updateCertificateTemplate,
  updateCertificateTemplateImage,
} from "./certificates";

// The certificate template reads and the already-sent reads: the real drizzle
// builders render the SQL; each awaited statement resolves the next canned
// rows.

const mockDb = drizzle.mock({ casing: "snake_case" });

type Rendered = { sql: string; params: unknown[] };

function recordingExec(results: unknown[][] = []) {
  const queries: Rendered[] = [];
  function settle<Query extends { toSQL(): Rendered }>(query: Query): Query {
    return Object.assign(query, {
      then: (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => {
        queries.push(query.toSQL());
        return Promise.resolve(results.shift() ?? []).then(resolve, reject);
      },
    });
  }
  const exec = {
    select: (fields: never) => {
      const builder = mockDb.select(fields);
      const from = builder.from.bind(builder);
      builder.from = ((table: never) =>
        settle(from(table))) as typeof builder.from;
      return builder;
    },
    update: (table: never) => {
      const builder = mockDb.update(table);
      const set = builder.set.bind(builder);
      builder.set = ((values: never) => settle(set(values))) as typeof builder.set;
      return builder;
    },
  } as unknown as DbExecutor;
  return { exec, queries };
}

const TEMPLATE_FROM = ` from "certificate_templates"`;
const ACCESS_FIELDS =
  `"event_access"."id", "event_access"."name", "event_access"."type"`;
const ACCESS_JOIN =
  ` left join "event_access"` +
  ` on ("event_access"."id" = "certificate_templates"."access_id"` +
  ` and "event_access"."event_id" = "certificate_templates"."event_id")`;

const image = {
  templateUrl: "https://storage.x.test/e1/certificates/t1.png",
  templateWidth: 1000,
  templateHeight: 700,
  renderImageKey: "e1/certificates/t1-render.jpg",
  renderImageWidth: 1000,
  renderImageHeight: 700,
};

function templateRow(
  overrides: Record<string, unknown> = {},
  accessRefId: string | null = "acc-1",
) {
  return {
    template: {
      id: "t1",
      zones: [],
      applicableRoles: ["SPEAKER"],
      ...overrides,
    },
    accessRefId,
    accessRefName: accessRefId ? "Workshop" : null,
    accessRefType: accessRefId ? "WORKSHOP" : null,
  };
}

afterEach(() => configureJsonbValidation(undefined));

describe("certificate template reads", () => {
  it("share one select list and access join; only their clauses differ", async () => {
    const list = recordingExec();
    await listCertificateTemplates("event-1", list.exec);
    const active = recordingExec();
    await listActiveImageReadyCertificateTemplates("event-1", active.exec);
    const byIds = recordingExec();
    await getActiveImageReadyCertificateTemplatesByIds(
      ["t1", "t2"],
      "event-1",
      byIds.exec,
    );
    // A write reloads the template with its access (loadTemplateWithAccess).
    const reload = recordingExec([[]]);
    await updateCertificateTemplateImage("t1", image, reload.exec);

    const queries = [
      list.queries[0],
      active.queries[0],
      byIds.queries[0],
      reload.queries[1],
    ];
    const first = queries[0].sql;
    const select = first.slice(0, first.indexOf(TEMPLATE_FROM));
    expect(select.startsWith(`select "certificate_templates"."id", `)).toBe(true);
    expect(select.endsWith(ACCESS_FIELDS)).toBe(true);
    for (const query of queries) {
      expect(query.sql.startsWith(select + TEMPLATE_FROM)).toBe(true);
    }

    expect(queries.map((query) => query.sql.slice(select.length))).toEqual([
      `${TEMPLATE_FROM}${ACCESS_JOIN} where "certificate_templates"."event_id" = $1` +
        ` order by "certificate_templates"."created_at" desc`,
      `${TEMPLATE_FROM}${ACCESS_JOIN} where ("certificate_templates"."event_id" = $1` +
        ` and "certificate_templates"."active" = $2` +
        ` and "certificate_templates"."template_url" <> $3` +
        ` and "certificate_templates"."template_width" > $4` +
        ` and "certificate_templates"."template_height" > $5)`,
      `${TEMPLATE_FROM}${ACCESS_JOIN} where ("certificate_templates"."id" in ($1, $2)` +
        ` and "certificate_templates"."active" = $3` +
        ` and "certificate_templates"."event_id" = $4` +
        ` and "certificate_templates"."template_url" <> $5` +
        ` and "certificate_templates"."template_width" > $6` +
        ` and "certificate_templates"."template_height" > $7)`,
      `${TEMPLATE_FROM}${ACCESS_JOIN}` +
        ` where "certificate_templates"."id" = $1 limit $2`,
    ]);
    expect(queries.map((query) => query.params)).toEqual([
      ["event-1"],
      ["event-1", true, "", 0, 0],
      ["t1", "t2", true, "event-1", "", 0, 0],
      ["t1", 1],
    ]);

    const withEvent = recordingExec();
    await getCertificateTemplateWithEvent("t1", withEvent.exec);
    expect(withEvent.queries).toEqual([
      {
        sql:
          `${select}, "events"."client_id", "events"."status"${TEMPLATE_FROM}` +
          ` inner join "events" on "events"."id" = "certificate_templates"."event_id"` +
          `${ACCESS_JOIN} where "certificate_templates"."id" = $1 limit $2`,
        params: ["t1", 1],
      },
    ]);
  });

  it("by ids: no read for no ids", async () => {
    const { exec, queries } = recordingExec();
    expect(
      await getActiveImageReadyCertificateTemplatesByIds([], "event-1", exec),
    ).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("map each row to the template, roles defaulted, with its access or null", async () => {
    const rows = [
      templateRow({ applicableRoles: null }),
      templateRow({ id: "t2" }, null),
    ];
    const access = { id: "acc-1", name: "Workshop", type: "WORKSHOP" };
    const expected = [
      { id: "t1", zones: [], applicableRoles: [], access },
      { id: "t2", zones: [], applicableRoles: ["SPEAKER"], access: null },
    ];
    const exec = () => recordingExec([rows]).exec;

    expect(await listCertificateTemplates("event-1", exec())).toStrictEqual(expected);
    expect(
      await listActiveImageReadyCertificateTemplates("event-1", exec()),
    ).toStrictEqual(expected);
    expect(
      await getActiveImageReadyCertificateTemplatesByIds(["t1", "t2"], "event-1", exec()),
    ).toStrictEqual(expected);
    expect(
      await updateCertificateTemplateImage("t1", image, recordingExec([[], rows]).exec),
    ).toStrictEqual(expected[0]);
  });

  it("reads check the stored zones; a write's reload only defaults the roles", async () => {
    configureJsonbValidation("enforce");
    const bad = templateRow({ zones: "not zones", applicableRoles: null });

    const reads = [
      (exec: DbExecutor) => listCertificateTemplates("event-1", exec),
      (exec: DbExecutor) => listActiveImageReadyCertificateTemplates("event-1", exec),
      (exec: DbExecutor) =>
        getActiveImageReadyCertificateTemplatesByIds(["t1"], "event-1", exec),
      (exec: DbExecutor) => getCertificateTemplateWithEvent("t1", exec),
    ];
    for (const read of reads) {
      await expect(read(recordingExec([[bad]]).exec)).rejects.toBeInstanceOf(
        StoredJsonError,
      );
    }
    expect(
      await updateCertificateTemplateImage("t1", image, recordingExec([[], [bad]]).exec),
    ).toStrictEqual({
      id: "t1",
      zones: "not zones",
      applicableRoles: [],
      access: { id: "acc-1", name: "Workshop", type: "WORKSHOP" },
    });
  });
});

describe("certificate template update", () => {
  it("writes only the defined fields of the patch", async () => {
    const { exec, queries } = recordingExec([[], []]);
    await updateCertificateTemplate(
      "t1",
      { name: "New", zones: undefined, accessId: null, scope: undefined },
      exec,
    );

    expect(queries[0]).toEqual({
      sql:
        `update "certificate_templates"` +
        ` set "name" = $1, "access_id" = $2, "updated_at" = $3` +
        ` where "certificate_templates"."id" = $4`,
      params: ["New", null, expect.any(String), "t1"],
    });
  });
});

describe("already-sent certificate reads", () => {
  const statusesSql = `"email_logs"."status" in ($3, $4, $5, $6, $7, $8, $9)`;
  const statuses = [
    "QUEUED",
    "SENDING",
    "SENT",
    "DELIVERED",
    "OPENED",
    "CLICKED",
    "UNCERTAIN",
  ];

  it("read the CERTIFICATE_SENT logs by registration or by abstract", async () => {
    const byRegistration = recordingExec();
    await getAlreadySentCertTemplateIds(["reg-1"], byRegistration.exec);
    const byAbstract = recordingExec();
    await getAlreadySentAbstractCertTemplateIds(["abs-1"], byAbstract.exec);

    expect([...byRegistration.queries, ...byAbstract.queries]).toEqual([
      {
        sql:
          `select "id", "registration_id", "context_snapshot" from "email_logs"` +
          ` where ("email_logs"."registration_id" in ($1)` +
          ` and "email_logs"."trigger" = $2 and ${statusesSql})`,
        params: ["reg-1", "CERTIFICATE_SENT", ...statuses],
      },
      {
        sql:
          `select "id", "abstract_id", "context_snapshot" from "email_logs"` +
          ` where ("email_logs"."abstract_id" in ($1)` +
          ` and "email_logs"."trigger" = $2 and ${statusesSql})`,
        params: ["abs-1", "CERTIFICATE_SENT", ...statuses],
      },
    ]);
  });

  it("collect the string template ids of each target across its logs", async () => {
    configureJsonbValidation("warn");
    // Result rows as pg returns them (id, target id, snapshot), mapped by drizzle.
    const snapshot = (ids: unknown) => ({ _certificateTemplateIds: ids });
    const rows = [
      ["l1", "t-1", snapshot(["c1", 2, "c2"])],
      ["l2", "t-2", snapshot("c9")],
      ["l3", "t-1", snapshot(["c3", "c1"])],
      ["l4", null, snapshot(["c4"])],
      ["l5", "t-3", null],
    ];
    const pgExec = () =>
      drizzle({
        client: { query: vi.fn(async () => ({ rows })) } as unknown as Pool,
        casing: "snake_case",
      });
    const expected = new Map([["t-1", new Set(["c1", "c2", "c3"])]]);

    const byRegistration = await getAlreadySentCertTemplateIds(
      ["t-1", "t-2", "t-3"],
      pgExec(),
    );
    const byAbstract = await getAlreadySentAbstractCertTemplateIds(
      ["t-1", "t-2", "t-3"],
      pgExec(),
    );
    expect(byRegistration).toEqual(expected);
    expect(byAbstract).toEqual(expected);
    expect([...byRegistration.get("t-1")!]).toEqual(["c1", "c2", "c3"]);
  });

  it("read nothing for no targets", async () => {
    const byRegistration = recordingExec();
    const byAbstract = recordingExec();
    expect(await getAlreadySentCertTemplateIds([], byRegistration.exec)).toEqual(
      new Map(),
    );
    expect(
      await getAlreadySentAbstractCertTemplateIds([], byAbstract.exec),
    ).toEqual(new Map());
    expect([...byRegistration.queries, ...byAbstract.queries]).toEqual([]);
  });
});
