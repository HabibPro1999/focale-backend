import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import {
  applyMigrations,
  defaultMigrationsDirectory,
  listMigrationRecords,
  listMigrationStepRecords,
  loadMigrations,
  migrationChecksum,
  parseMigrationDirectives,
  refreshMigrationLease,
  splitMigrationStatements,
  type ApplyMigrationsResult,
  type MigrationDefinition,
} from "../../src/migrator";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

// `apply` commits every unit of migration work through a lease fence: an
// UPDATE of the lease row just before COMMIT. The CLI's heartbeat renews that
// row from another connection every 30 s. On CockroachDB (SERIALIZABLE) a
// renewal that commits while a fenced transaction is open makes the fence fail
// with 40001, so apply must run that transaction again. These cases commit a
// renewal from a second connection in the middle of each kind of fenced
// transaction, exactly once per ledger row, and check what ran and what stuck.

function synthetic(id: string, name: string, source: string): MigrationDefinition {
  const file = `${id}_${name}.sql`;
  return {
    id,
    name: file,
    variant: "shared",
    filePath: `synthetic/${file}`,
    source,
    checksum: migrationChecksum(source),
    directives: parseMigrationDirectives(source, file),
    statements: splitMigrationStatements(source),
  };
}

// Synthetic files skip the directory lint. 9002/9003 insert one row each, so
// the row counts show which executions of their bodies were committed.
const PER_FILE = synthetic("9001", "lease_race_per_file", [
  "-- migrate: transaction per-file",
  "CREATE TABLE lease_race_runs (mode text NOT NULL);",
].join("\n"));
const PER_STATEMENT = synthetic("9002", "lease_race_per_statement", [
  "-- migrate: transaction per-statement",
  "INSERT INTO lease_race_runs (mode) VALUES ('per-statement');",
  "--> statement-breakpoint",
  "CREATE INDEX lease_race_runs_mode_idx ON lease_race_runs (mode);",
].join("\n"));
const NO_TRANSACTION = synthetic("9003", "lease_race_none", [
  "-- migrate: transaction none",
  "INSERT INTO lease_race_runs (mode) VALUES ('none');",
].join("\n"));
const DEFERRED = synthetic("9004", "lease_race_deferred", [
  "-- migrate: transaction per-file",
  "-- migrate: deferrable",
  '-- migrate: defer-unless "SELECT false"',
  "CREATE TABLE lease_race_deferred (id integer);",
].join("\n"));

const LEDGER_WRITE = /^\s*INSERT INTO public\.schema_migration(?:s|_steps)\b/;

interface RacingClient {
  client: Client;
  /** How many times the runner sent exactly this SQL text. */
  executions(sql: string): number;
  ledgerWrites(): number;
}

/**
 * The runner's client, except that right after the first write of each ledger
 * row a lease renewal commits from another connection: what the heartbeat does
 * every 30 s, landing while the fenced transaction is open (after its snapshot
 * on either engine). A retry of the same row does not renew again.
 */
function renewingAfterLedgerWrites(client: Client, other: Client): RacingClient {
  const sent: string[] = [];
  const renewedFor = new Set<string>();
  let ledgerWrites = 0;
  const query = async (sql: string, values?: unknown[]) => {
    sent.push(sql);
    const result = await client.query(sql, values);
    if (LEDGER_WRITE.test(sql)) {
      ledgerWrites += 1;
      const key = `${sql}\u0000${JSON.stringify(values ?? [])}`;
      if (!renewedFor.has(key)) {
        renewedFor.add(key);
        const lock = await other.query<{ owner: string }>("SELECT owner FROM public.schema_migration_lock WHERE id = 1");
        await refreshMigrationLease(other, lock.rows[0]!.owner);
      }
    }
    return result;
  };
  const racing = new Proxy(client, {
    get(target, property) {
      if (property === "query") return query;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    client: racing,
    executions: (sql) => sent.filter((text) => text === sql).length,
    ledgerWrites: () => ledgerWrites,
  };
}

// The migrator's own session isolation, then SERIALIZABLE forced for the
// session, so the PostgreSQL tier also exercises the retry (a no-op on CockroachDB).
describe.runIf(dbTestsEnabled()).each([
  { session: "default isolation", serializable: false },
  { session: "SERIALIZABLE session", serializable: true },
])("migrate apply with lease renewals inside fenced transactions ($session)", ({ serializable }) => {
  let database: ScratchDatabase;
  let other: Client;
  let migrations: MigrationDefinition[];
  /** Runs of each fenced transaction: its first commit is rejected unless the session is READ COMMITTED. */
  let attempts: number;

  beforeAll(async () => {
    database = await createScratchDatabase({ label: "apply_lease_race", to: "0000" });
    other = new Client({ connectionString: database.url });
    await other.connect();
    const baseline = await loadMigrations(defaultMigrationsDirectory(), database.engine, { through: "0000" });
    migrations = [...baseline, PER_FILE, PER_STATEMENT, NO_TRANSACTION, DEFERRED];
    if (serializable) await database.client.query("SET default_transaction_isolation = 'serializable'");
    // Under SERIALIZABLE (CockroachDB's default for the migration client) the
    // fence cannot update a lease row that changed after its transaction's
    // snapshot (40001). PostgreSQL's READ COMMITTED default re-reads the row.
    const { rows } = await database.client.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
    attempts = rows[0]!.transaction_isolation === "read committed" ? 1 : 2;
    if (database.engine === "cockroach" || serializable) expect(attempts).toBe(2);
  }, dbTestSetupTimeoutMs());

  afterAll(async () => {
    await other?.end().catch(() => undefined);
    await database?.close();
  }, dbTestSetupTimeoutMs());

  async function apply(through: string): Promise<{ result: ApplyMigrationsResult; racing: RacingClient }> {
    const racing = renewingAfterLedgerWrites(database.client, other);
    const result = await applyMigrations(racing.client, migrations, {
      through,
      appliedBy: "apply-lease-race-test",
      leaseConnectionString: database.url,
    });
    return { result, racing };
  }

  async function runs(mode: string): Promise<number> {
    const { rows } = await database.client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM lease_race_runs WHERE mode = $1",
      [mode],
    );
    return Number(rows[0]!.n);
  }

  async function status(id: string): Promise<string | undefined> {
    return (await listMigrationRecords(database.client)).find((record) => record.id === id)?.status;
  }

  it("runs a per-file migration transaction again after its fence fails", async () => {
    const { result, racing } = await apply(PER_FILE.id);
    expect(result.applied).toEqual([PER_FILE.id]);
    expect(racing.executions(PER_FILE.statements[0]!)).toBe(attempts);
    // One step row and one migration row, each in the same transaction.
    expect(racing.ledgerWrites()).toBe(2 * attempts);
    expect(await status(PER_FILE.id)).toBe("applied");
    expect(await listMigrationStepRecords(database.client, PER_FILE.id, "shared")).toHaveLength(1);
    expect(await runs("per-file")).toBe(0);
  });

  it("runs each per-statement step and the final record again after its fence fails", async () => {
    const { result, racing } = await apply(PER_STATEMENT.id);
    expect(result.applied).toEqual([PER_STATEMENT.id]);
    for (const statement of PER_STATEMENT.statements) expect(racing.executions(statement)).toBe(attempts);
    // Two step transactions and the final record transaction.
    expect(racing.ledgerWrites()).toBe(3 * attempts);
    expect(await status(PER_STATEMENT.id)).toBe("applied");
    expect(await listMigrationStepRecords(database.client, PER_STATEMENT.id, "shared")).toHaveLength(2);
    // The rejected attempt was rolled back with its fence; one insert stuck.
    expect(await runs("per-statement")).toBe(1);
  });

  it("retries only the ledger write after a non-transactional statement, never the committed statement", async () => {
    const { result, racing } = await apply(NO_TRANSACTION.id);
    expect(result.applied).toEqual([NO_TRANSACTION.id]);
    expect(racing.executions(NO_TRANSACTION.statements[0]!)).toBe(1);
    // The step transaction and the final record transaction.
    expect(racing.ledgerWrites()).toBe(2 * attempts);
    expect(await status(NO_TRANSACTION.id)).toBe("applied");
    expect(await listMigrationStepRecords(database.client, NO_TRANSACTION.id, "shared")).toHaveLength(1);
    expect(await runs("none")).toBe(1);
  });

  it("writes a deferred record again after its fence fails", async () => {
    const { result, racing } = await apply(DEFERRED.id);
    expect(result.applied).toEqual([]);
    expect(result.deferred).toEqual([DEFERRED.id]);
    expect(racing.executions(DEFERRED.statements[0]!)).toBe(0);
    expect(racing.ledgerWrites()).toBe(attempts);
    expect(await status(DEFERRED.id)).toBe("deferred");
  });
});
