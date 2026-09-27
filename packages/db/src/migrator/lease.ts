import { Client } from "pg";

// Every lease time reads the wall clock (clock_timestamp()), never now(). Inside
// a transaction, now() is the transaction's start time on PostgreSQL and
// CockroachDB, so the pre-commit fence of a long migration transaction would
// write a lease already shortened by the transaction's duration (overwriting
// the heartbeat's later renewals), and the fence and the in-transaction
// liveness check would accept a lease that expired while it was open.
const LEASE_TTL_SECONDS = 90;

const LEASE_WAIT_MS = 2 * 60 * 1000;

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40001";
}

async function waitForLeaseRetry(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireMigrationLease(client: Client, owner: string): Promise<void> {
  const deadline = Date.now() + LEASE_WAIT_MS;
  let pauseMs = 200;
  while (Date.now() < deadline) {
    try {
      await client.query(
        `UPDATE public.schema_migration_lock
         SET owner = $1, lease_until = clock_timestamp() + interval '${LEASE_TTL_SECONDS} seconds'
         WHERE id = 1 AND (owner IS NULL OR lease_until < clock_timestamp() OR owner = $1)`,
        [owner],
      );
      const result = await client.query<{ owner: string }>(
        "SELECT owner FROM public.schema_migration_lock WHERE id = 1",
      );
      if (result.rows[0]?.owner === owner) return;
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
    }
    await waitForLeaseRetry(pauseMs);
    pauseMs = Math.min(2000, Math.ceil(pauseMs * 1.5));
  }
  throw new Error("Timed out waiting for the migration lease; another migrator may still be running");
}

async function extendLease(client: Client, owner: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE public.schema_migration_lock
     SET lease_until = clock_timestamp() + interval '${LEASE_TTL_SECONDS} seconds'
     WHERE id = 1 AND owner = $1 AND lease_until > clock_timestamp()`,
    [owner],
  );
  return result.rowCount === 1;
}

async function leaseHeldBy(client: Client, owner: string): Promise<boolean> {
  const result = await client.query<{ owner: string; active: boolean }>(
    `SELECT owner, lease_until > clock_timestamp() AS active
     FROM public.schema_migration_lock WHERE id = 1`,
  );
  return result.rows[0]?.owner === owner && Boolean(result.rows[0]?.active);
}

export async function refreshMigrationLease(client: Client, owner: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (!(await extendLease(client, owner))) throw new Error("Migration lease was lost or expired; stopping before the next SQL statement");
      return;
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 3) throw error;
      await waitForLeaseRetry((attempt + 1) * 50);
    }
  }
}

export async function releaseMigrationLease(client: Client, owner: string): Promise<void> {
  await client.query(
    "UPDATE public.schema_migration_lock SET owner = NULL, lease_until = NULL WHERE id = 1 AND owner = $1",
    [owner],
  );
}

export interface LeaseHeartbeat {
  assertAlive(): void;
  checkAlive(): Promise<void>;
  close(): Promise<void>;
}

export async function startLeaseHeartbeat(connectionString: string, owner: string): Promise<LeaseHeartbeat> {
  const keeper = new Client({ connectionString, application_name: "focale-migration-lease" });
  await keeper.connect();
  const observer = new Client({ connectionString, application_name: "focale-migration-lease-check" });
  try {
    await observer.connect();
  } catch (error) {
    await keeper.end().catch(() => undefined);
    throw error;
  }
  let stopped = false;
  let failure: Error | undefined;
  let timer: NodeJS.Timeout;
  const intervalMs = Math.floor((LEASE_TTL_SECONDS * 1000) / 3);
  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      await refreshMigrationLease(keeper, owner);
      failure = undefined;
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Migration lease renewal failed");
    }
    if (!stopped) {
      timer = setTimeout(() => void beat(), failure ? 5000 : intervalMs);
      timer.unref();
    }
  };
  timer = setTimeout(() => void beat(), intervalMs);
  timer.unref();
  const assertAlive = (): void => {
    if (failure) throw new Error(`Migration lease renewal failed: ${failure.message}`);
  };
  return {
    assertAlive,
    async checkAlive() {
      assertAlive();
      if (!(await leaseHeldBy(observer, owner))) {
        failure = new Error("Migration lease was lost or expired");
        assertAlive();
      }
      assertAlive();
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      await Promise.all([keeper.end(), observer.end()]);
    },
  };
}

export async function refreshLease(
  client: Client,
  owner: string,
  heartbeat?: LeaseHeartbeat,
): Promise<void> {
  heartbeat?.assertAlive();
  await refreshMigrationLease(client, owner);
}

/**
 * Fence a transaction immediately before commit. Updating the conditional lease
 * row holds its write lock until commit, so a competing runner cannot take the
 * lease between this ownership check and the schema/ledger commit.
 */
async function fenceMigrationLease(
  client: Client,
  owner: string,
  heartbeat?: LeaseHeartbeat,
): Promise<void> {
  await heartbeat?.checkAlive();
  if (!(await extendLease(client, owner))) {
    throw new Error("Migration lease was lost or expired; refusing to commit migration work");
  }
}

export async function assertLeaseAlive(
  client: Client,
  owner: string,
  heartbeat?: LeaseHeartbeat,
): Promise<void> {
  if (heartbeat) {
    await heartbeat.checkAlive();
    return;
  }
  if (!(await leaseHeldBy(client, owner))) {
    throw new Error("Migration lease was lost or expired; stopping before the next SQL statement");
  }
}

export async function commitWithLeaseFence(
  client: Client,
  owner: string,
  heartbeat: LeaseHeartbeat | undefined,
): Promise<void> {
  await fenceMigrationLease(client, owner, heartbeat);
  await client.query("COMMIT");
}

/** Runs of one lease-fenced transaction when it fails with a serialization failure (40001). */
export const LEASE_FENCED_TRANSACTION_ATTEMPTS = 5;

/**
 * Run `work` in a transaction committed through the lease fence.
 *
 * On CockroachDB (SERIALIZABLE), a lease renewal that the heartbeat commits
 * while this transaction is open makes the fence fail with 40001: it updates
 * a lease row that changed after the transaction started. The transaction is
 * rolled back and the lease is still ours, so the whole transaction runs
 * again, up to LEASE_FENCED_TRANSACTION_ATTEMPTS times. `work` must contain
 * only what this transaction commits: anything already committed outside it
 * (a non-transactional statement) is never part of a retry.
 */
export async function runLeaseFencedTransaction(
  client: Client,
  owner: string,
  heartbeat: LeaseHeartbeat | undefined,
  work: () => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    await client.query("BEGIN");
    try {
      await work();
      await commitWithLeaseFence(client, owner, heartbeat);
      return;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isSerializationFailure(error) || attempt >= LEASE_FENCED_TRANSACTION_ATTEMPTS) throw error;
    }
    await waitForLeaseRetry(attempt * 100);
  }
}
