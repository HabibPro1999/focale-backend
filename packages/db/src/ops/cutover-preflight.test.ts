import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  compareTableCounts,
  inReadOnlySnapshot,
  isolated,
  parseTableCountsFile,
  writeCutoverPostflight,
  writeCutoverPreflight,
  type CutoverPreflightReport,
  type CutoverPreflightResult,
  type DataCheckEntry,
  type TableCountsFile,
} from "./cutover-preflight";
import {
  formatCutoverPreflightMarkdown,
  migrationWillRun,
  parseCutoverCliArguments,
  preflightFindings,
} from "./cutover-preflight-report";

/** A clean CockroachDB report without a ledger; tests override what they need. */
function sampleReport(overrides: Partial<CutoverPreflightReport> = {}): CutoverPreflightReport {
  return {
    kind: "cutover-preflight",
    formatVersion: 1,
    generatedAt: "2026-10-30T00:00:00.000Z",
    notice: "The affected/ files contain personal data.",
    database: {
      engine: "cockroach",
      version: "CockroachDB CCL v26.2.5",
      name: "focale",
      settings: {
        version: { value: "26.2" },
        "feature.vector_index.enabled": { value: true },
        "sql.txn.read_committed_isolation.enabled": { value: true },
      },
    },
    session: { readOnly: true, isolation: "serializable, priority low", writeProbe: { table: "abstracts", sqlstate: "25006" }, attempts: 1 },
    ledger: { present: false, records: [], pending: ["0000", "0017"], unknown: [] },
    adopt: { ran: true, aborted: false, errors: [], warnings: [], verdicts: [], lines: ["Migration adoption (cockroach; dry run (no changes)):"] },
    foreignKeys: { total: 0, prismaNamed: 0, drizzleNamed: 0, otherNamed: 0, byMigration: [] },
    migrations: [
      { id: "0000", name: "0000_init.sql", variant: "shared", ledger: "no-ledger", adopt: "baseline", modifies: [] },
      { id: "0017", name: "0017_networking_vector_index.sql", variant: "cockroach", ledger: "no-ledger", adopt: "pending", modifies: [] },
    ],
    dataChecks: [],
    queues: [],
    emailStatusCounts: {},
    linkOrigins: { registrations: [], abstracts: [] },
    sponsoredVerifying: { count: 0, registrationIds: [] },
    tableCounts: { file: "table-counts.json", tables: 1, rows: 3, errors: {} },
    errors: [],
    findings: [],
    ...overrides,
  };
}

function dataCheck(overrides: Partial<DataCheckEntry>): DataCheckEntry {
  return {
    migrationId: "0011", file: "0011_registration_gross_total.sql", effect: "repairs totals", source: ["0011_registration_gross_total.sql:10"],
    status: "no-change", ledger: "no-ledger", adopt: "pending", summary: "nothing", affectedRows: 0, ...overrides,
  };
}

const levels = (report: CutoverPreflightReport) => preflightFindings(report).map((finding) => `${finding.level}: ${finding.topic}`);

const counts = (tables: Record<string, number>, overrides: Partial<TableCountsFile> = {}): TableCountsFile => ({
  kind: "cutover-table-counts", formatVersion: 1, generatedAt: "2026-10-30T00:00:00.000Z", engine: "cockroach",
  database: "focale", tables, ...overrides,
});

describe("postflight table-count comparison", () => {
  it("passes when no table shrank; new tables and growth are fine", () => {
    const result = compareTableCounts(counts({ a: 2, b: 5, c: 0 }), counts({ a: 2, b: 7, c: 0, schema_migrations: 36 }));
    expect(result).toMatchObject({
      ok: true, lost: [], vanished: [], uncounted: [], unchanged: 2,
      grown: [{ table: "b", before: 5, after: 7 }], added: [{ table: "schema_migrations", after: 36 }],
    });
  });

  it("fails on a lost row or a vanished table, but accepts abstract_code_sequences dropped by 0033", () => {
    const result = compareTableCounts(
      counts({ registrations: 10, email_logs: 4, legacy: 1, abstract_code_sequences: 3 }),
      counts({ registrations: 10, email_logs: 3 }),
    );
    expect(result.ok).toBe(false);
    expect(result.lost).toEqual([{ table: "email_logs", before: 4, after: 3 }]);
    expect(result.vanished).toEqual([{ table: "legacy", before: 1 }]);
    expect(result.exempt).toEqual([{ table: "abstract_code_sequences", before: 3, reason: expect.stringContaining("0033") }]);
    expect(compareTableCounts(counts({ abstract_code_sequences: 3 }), counts({})).ok).toBe(true);
  });

  it("does not excuse abstract_code_sequences losing rows while it still exists", () => {
    const result = compareTableCounts(counts({ abstract_code_sequences: 3 }), counts({ abstract_code_sequences: 1 }));
    expect(result).toMatchObject({ ok: false, lost: [{ table: "abstract_code_sequences", before: 3, after: 1 }] });
  });

  it("fails when a table could not be counted on either side, and warns about a different database", () => {
    const result = compareTableCounts(
      counts({ a: 1 }, { errors: { b: "permission denied" } }),
      counts({}, { database: "copy", errors: { a: "timeout" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.uncounted).toEqual([
      { table: "b", reason: "not counted in the baseline: permission denied" },
      { table: "a", reason: "timeout" },
    ]);
    expect(result.vanished).toEqual([]);
    expect(result.warnings).toEqual(['baseline database "focale", current "copy"']);
  });

  it("accepts only a table-counts.json written by preflight", () => {
    expect(parseTableCountsFile(JSON.stringify(counts({ a: 1 }))).tables).toEqual({ a: 1 });
    expect(() => parseTableCountsFile(JSON.stringify({ kind: "cutover-preflight", formatVersion: 1, tables: {} }))).toThrow("not a table-counts.json");
    expect(() => parseTableCountsFile(JSON.stringify(counts({ a: -1 })))).toThrow("a is not a row count");
  });
});

describe("cutover preflight output files", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cutover-preflight-unit-"));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  const result = (): CutoverPreflightResult => ({
    report: sampleReport(),
    tableCounts: counts({ registrations: 3 }),
    affected: [{
      kind: "cutover-preflight-affected-rows", formatVersion: 1, notice: "personal data", generatedAt: "2026-10-30T00:00:00.000Z",
      migrationId: "0011", file: "0011_registration_gross_total.sql", effect: "repairs totals", status: "changes-rows",
      summary: "1 registration changes", rows: [{ id: "reg-1", total_amount: 40, new_total_amount: 100 }],
    }],
  });

  it("writes owner-only files into a new directory and never into a non-empty one", async () => {
    const directory = join(root, "preflight");
    const written = await writeCutoverPreflight(directory, result());
    expect(written.map((path) => path.slice(directory.length + 1)))
      .toEqual(["report.json", "report.md", "table-counts.json", "affected/0011.json"]);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "affected", "0011.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(directory, "affected", "0011.json"), "utf8")).rows).toEqual([{ id: "reg-1", total_amount: 40, new_total_amount: 100 }]);
    expect(await readFile(join(directory, "report.md"), "utf8")).toContain("| registrations | 3 |");

    const used = join(root, "used");
    await writeCutoverPostflight(used, compareTableCounts(counts({}), counts({})), counts({}));
    await writeFile(join(used, "extra"), "");
    await expect(writeCutoverPreflight(used, result())).rejects.toThrow("not empty");
    expect((await readdir(used)).sort()).toEqual(["extra", "postflight.json", "table-counts.json"]);
  });
});

describe("cutover preflight findings", () => {
  it("has nothing to say about a clean database", () => {
    expect(preflightFindings(sampleReport())).toEqual([]);
  });

  it("blocks on a failing or broken check, an aborted adopt, an unknown ledger row and an uncounted table", () => {
    const report = sampleReport({
      dataChecks: [
        dataCheck({ migrationId: "0004", file: "0004_abstract_book_jobs_active_unique.sql", status: "fails", summary: "apply stops at 0004" }),
        dataCheck({ status: "error", error: "permission denied" }),
        dataCheck({ migrationId: "0006", file: "0006_x.sql", status: "changes-rows", review: true, summary: "1 active theme moves" }),
      ],
      adopt: { ran: true, aborted: true, errors: ["0000: catalog probes partial"] },
      ledger: { present: true, records: [], pending: [], unknown: ["0099"] },
      tableCounts: { file: "table-counts.json", tables: 1, rows: 3, errors: { audit_logs: "timeout" } },
      errors: [{ section: "queues", message: "relation does not exist" }],
    });
    expect(levels(report)).toEqual([
      "blocker: queues",
      "blocker: table counts",
      "blocker: ledger",
      "blocker: adopt",
      "blocker: 0004 0004_abstract_book_jobs_active_unique.sql",
      "blocker: 0011 0011_registration_gross_total.sql",
      "review: 0006 0006_x.sql",
    ]);
  });

  it("blocks when apply would read an unreadable vector setting for a pending 0017, not when 0017 will not run", () => {
    const unreadable = { "feature.vector_index.enabled": { error: "user lacks VIEWCLUSTERSETTING" }, "sql.txn.read_committed_isolation.enabled": { value: false } };
    const report = sampleReport({ database: { ...sampleReport().database, settings: unreadable } });
    expect(levels(report)).toEqual(["blocker: feature.vector_index.enabled", "review: sql.txn.read_committed_isolation.enabled"]);
    const adopted = sampleReport({
      database: { ...sampleReport().database, settings: unreadable },
      migrations: [{ id: "0017", name: "0017_networking_vector_index.sql", variant: "cockroach", ledger: "deferred", modifies: [] }],
    });
    expect(levels(adopted)).toEqual(["review: sql.txn.read_committed_isolation.enabled"]);
    const off = sampleReport({ database: { ...sampleReport().database, settings: { ...sampleReport().database.settings, "feature.vector_index.enabled": { value: false } } } });
    expect(preflightFindings(off)).toEqual([expect.objectContaining({ level: "review", message: expect.stringContaining("records 0017 as deferred") })]);
  });

  it("asks for a review of in-flight queues, sponsored VERIFYING rows, origins and unchecked row changes", () => {
    const report = sampleReport({
      queues: [{ table: "email_logs", counts: { QUEUED: 3, SENDING: 1 }, inFlight: 1 }, { table: "outbox_events", counts: { PENDING: 2 }, inFlight: 0 }],
      sponsoredVerifying: { count: 2, registrationIds: ["r1", "r2"] },
      linkOrigins: {
        registrations: [{ origin: "https://forms.example.org", count: 3, lastSeen: "2026-10-01" }, { origin: null, count: 1, lastSeen: null }],
        abstracts: [{ origin: "https://forms.example.org", count: 1, lastSeen: "2026-10-01" }],
      },
      migrations: [
        { id: "0018", name: "0018_networking_spaces.sql", variant: "cockroach", ledger: "pending", modifies: [{ table: "networking_tables", rows: 4 }, { table: "networking_profiles", rows: 0 }] },
        { id: "0019", name: "0019_x.sql", variant: "shared", ledger: "pending", modifies: [{ table: "networking_meetings", rows: null }] },
      ],
    });
    const findings = preflightFindings(report);
    expect(findings.map((finding) => finding.topic)).toEqual([
      "0018 0018_networking_spaces.sql",
      "queue email_logs",
      "sponsored VERIFYING",
      "PUBLIC_LINK_ALLOWED_ORIGINS",
      "PUBLIC_LINK_ALLOWED_ORIGINS",
    ]);
    expect(findings[0].message).toContain("networking_tables (4 rows)");
    expect(findings[3].message).toContain("https://forms.example.org");
    expect(findings.every((finding) => finding.level === "review")).toBe(true);
  });

  it("knows which migrations apply will run", () => {
    const report = sampleReport({
      migrations: [
        { id: "0001", name: "a", variant: "shared", ledger: "no-ledger", adopt: "applied", modifies: [] },
        { id: "0002", name: "b", variant: "shared", ledger: "no-ledger", adopt: "abort", modifies: [] },
        { id: "0003", name: "c", variant: "shared", ledger: "deferred", modifies: [] },
        { id: "0004", name: "d", variant: "shared", ledger: "pending", modifies: [] },
      ],
    });
    expect(["0001", "0002", "0003", "0004", "0005"].map((id) => migrationWillRun(report, id))).toEqual([false, true, false, true, false]);
  });
});

describe("cutover preflight report.md", () => {
  it("leads with the personal-data notice and the verdict", () => {
    const report = sampleReport({ dataChecks: [dataCheck({ status: "fails", summary: "the predicate fails" })] });
    report.findings = preflightFindings(report);
    const markdown = formatCutoverPreflightMarkdown(report, { registrations: 3 });
    expect(markdown.split("\n").slice(0, 3)).toEqual(["# Cutover preflight", "", "> **Personal data.** The affected/ files contain personal data."]);
    expect(markdown).toContain("**1 blocker(s), 0 item(s) to review.**");
    expect(markdown).toContain("- **Blocker** (0011 0011_registration_gross_total.sql): the predicate fails");
    expect(markdown).toContain("write probe `DELETE FROM abstracts WHERE false` refused with SQLSTATE 25006");
    expect(markdown).toContain("postflight --baseline <dir>/table-counts.json");
    expect(formatCutoverPreflightMarkdown(sampleReport(), {})).toContain("**No blocker; 0 item(s) to review.**");
  });
});

describe("cutover preflight command line", () => {
  it("accepts --name value and --name=value", () => {
    expect(parseCutoverCliArguments(["preflight", "--out", "/tmp/a"])).toEqual({ command: "preflight", options: new Map([["--out", "/tmp/a"]]), help: false });
    expect(parseCutoverCliArguments(["postflight", "--baseline=/tmp/a/table-counts.json", "--out", "/tmp/b"]).options)
      .toEqual(new Map([["--baseline", "/tmp/a/table-counts.json"], ["--out", "/tmp/b"]]));
    expect(parseCutoverCliArguments(["--help"]).help).toBe(true);
    expect(parseCutoverCliArguments(["preflight", "-h"]).help).toBe(true);
  });

  it("refuses a missing value, a repeated option and a stray argument", () => {
    expect(() => parseCutoverCliArguments(["preflight", "--out"])).toThrow("--out needs a value");
    expect(() => parseCutoverCliArguments(["preflight", "--out", "--baseline", "x"])).toThrow("--out needs a value");
    expect(() => parseCutoverCliArguments(["preflight", "--out=a", "--out=b"])).toThrow("--out is given twice");
    expect(() => parseCutoverCliArguments(["preflight", "dir"])).toThrow("Unexpected argument: dir");
  });
});

describe("cutover preflight read-only snapshot", () => {
  /** A connection that refuses writes; `SELECT flaky` fails with 40001 `failures` times. */
  function fakeClient(failures: number) {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        if (sql.includes("information_schema.tables")) return { rows: [{ table_name: "registrations" }] };
        if (sql.startsWith("DELETE")) throw Object.assign(new Error("cannot execute DELETE in a read-only transaction"), { code: "25006" });
        if (sql === "SELECT flaky" && failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("restart transaction: ReadWithinUncertaintyIntervalError"), { code: "40001" });
        }
        return { rows: [] };
      },
    };
    return { client: client as unknown as Client, statements };
  }

  it("starts the transaction again after a retry error, even when the reader swallowed it", async () => {
    const { client, statements } = fakeClient(1);
    const result = await inReadOnlySnapshot(client, "cockroach", async (session) => {
      // Like adopt's catalog probes or the 0011 check: the error is caught and the reader carries on.
      const outcome = await isolated(client, () => client.query("SELECT flaky")).then(() => "read", () => "swallowed");
      return { outcome, session };
    });
    expect(result).toEqual({
      outcome: "read",
      session: { readOnly: true, isolation: "serializable, priority low", writeProbe: { table: "registrations", sqlstate: "25006" }, attempts: 2 },
    });
    expect(statements.filter((sql) => sql.startsWith("BEGIN"))).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE, PRIORITY LOW, READ ONLY",
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE, PRIORITY LOW, READ ONLY",
    ]);
    expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(2);
    expect(statements).not.toContain("COMMIT");
    // No ROLLBACK TO SAVEPOINT after the retry error (CockroachDB refuses it); one after each refused write probe.
    expect(statements.filter((sql) => sql.startsWith("ROLLBACK TO SAVEPOINT"))).toHaveLength(2);
  });

  it("gives up after three attempts and reports the retry error", async () => {
    const { client, statements } = fakeClient(5);
    await expect(inReadOnlySnapshot(client, "cockroach", async () => {
      await isolated(client, () => client.query("SELECT flaky")).catch(() => undefined);
      return "done";
    })).rejects.toThrow("ReadWithinUncertaintyIntervalError");
    expect(statements.filter((sql) => sql.startsWith("BEGIN"))).toHaveLength(3);
  });

  it("stops before reading anything when a write is not refused", async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        if (sql.includes("information_schema.tables")) return { rows: [{ table_name: "registrations" }] };
        return { rows: [] };
      },
    } as unknown as Client;
    const collect = async () => "read";
    await expect(inReadOnlySnapshot(client, "postgres", collect)).rejects.toThrow("A write was not refused");
    expect(statements.at(-1)).toBe("ROLLBACK");
  });
});
