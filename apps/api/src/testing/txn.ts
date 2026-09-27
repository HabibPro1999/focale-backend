import type { withTxn } from "@app/db";

type TestTransaction = Parameters<Parameters<typeof withTxn>[0]>[0];

function passthrough<T>(fn: (tx: TestTransaction) => Promise<T>): Promise<T> {
  return fn({} as TestTransaction);
}

/**
 * Query-mocked unit tests only: no DB, isolation, rollback, locking or retries.
 * Use vi.fn(txnPassthrough.withTxn), or pass it to mockImplementation after a
 * reset. Inside hoisted vi.mock factories, await import("../../testing/txn").
 * Each call receives a fresh dummy executor; all query functions must be mocked.
 */
export const txnPassthrough = {
  withTxn: passthrough,
  withSerializableTxn: passthrough,
  withLockingTxn: passthrough,
};
