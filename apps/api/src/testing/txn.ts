import type { withTxn } from "@app/db";

type TestTransaction = Parameters<Parameters<typeof withTxn>[0]>[0];

/**
 * Query-mocked tests only: invokes the callback with the exact supplied executor
 * sentinel, preserving root-pool versus transaction identity assertions. No DB,
 * isolation, rollback, locking or retries are simulated. Use as the implementation
 * of a mocked withTxn/withLockingTxn/withSerializableTxn; mock every query it calls.
 * Hoisted vi.mock factories can obtain it through an awaited import.
 */
export function txnPassthrough(executor: unknown) {
  return <T>(run: (tx: TestTransaction) => Promise<T>): Promise<T> =>
    run(executor as TestTransaction);
}
