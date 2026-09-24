import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type Table } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), sleep: vi.fn(async (_ms: number) => undefined) }));
vi.mock("../client", () => ({ getDb: () => ({ transaction: mocks.transaction }) }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.sleep }));

import {
  NETWORKING_TXN_ATTEMPTS,
  NetworkingAllocationLockError,
  NetworkingBusyError,
  networkingAllocationBuckets,
  networkingAllocationTransaction,
  networkingTransaction,
} from "./networking-store";

const serialization = () => Object.assign(new Error("restart transaction"), { cause: { code: "40001" } });
const at = (iso: string) => new Date(`2099-01-01T${iso}:00.000Z`);

beforeEach(() => {
  mocks.transaction.mockReset();
  mocks.sleep.mockClear();
});

describe("networkingAllocationBuckets", () => {
  it("returns every UTC hour a half-open interval overlaps, ascending and deduplicated", () => {
    expect(networkingAllocationBuckets([
      { startsAt: at("11:45"), endsAt: at("12:15") },
      { startsAt: at("09:00"), endsAt: at("09:30") },
      { startsAt: at("11:00"), endsAt: at("12:00") },
    ])).toEqual([at("09:00"), at("11:00"), at("12:00")]);
    // An interval ending exactly on the hour does not take the next hour.
    expect(networkingAllocationBuckets([{ startsAt: at("10:30"), endsAt: at("11:00") }])).toEqual([at("10:00")]);
    expect(networkingAllocationBuckets([])).toEqual([]);
  });
  it("rejects empty, inverted, invalid and runaway intervals", () => {
    for (const interval of [
      { startsAt: at("10:00"), endsAt: at("10:00") },
      { startsAt: at("11:00"), endsAt: at("10:00") },
      { startsAt: new Date(Number.NaN), endsAt: at("10:00") },
    ]) expect(() => networkingAllocationBuckets([interval])).toThrow("non-empty");
    expect(() => networkingAllocationBuckets([{ startsAt: at("00:00"), endsAt: new Date(+at("00:00") + 49 * 3_600_000) }]))
      .toThrow("more than 48 hours");
  });
});

describe("networkingTransaction", () => {
  it("runs one SERIALIZABLE transaction without touching the event row", async () => {
    const tx = { select: vi.fn(), insert: vi.fn() };
    mocks.transaction.mockImplementation(async (run) => run(tx));
    const run = vi.fn(async (store: { executor: unknown }, db: unknown) => [store.executor, db]);
    expect(await networkingTransaction("event", run)).toEqual([tx, tx]);
    expect(mocks.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { isolationLevel: "serializable" });
    expect(tx.select).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
  it("retries serialization failures with a capped, jittered backoff", async () => {
    mocks.transaction
      .mockRejectedValueOnce(serialization())
      .mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "40P01" }))
      .mockResolvedValueOnce("done");
    expect(await networkingTransaction("event", vi.fn())).toBe("done");
    expect(mocks.transaction).toHaveBeenCalledTimes(3);
    expect(mocks.sleep).toHaveBeenCalledTimes(2);
  });
  it("turns exhausted retries into NetworkingBusyError carrying the last failure", async () => {
    const last = serialization();
    mocks.transaction.mockImplementation(async () => { throw mocks.transaction.mock.calls.length === NETWORKING_TXN_ATTEMPTS ? last : serialization(); });
    const error = await networkingTransaction("event", vi.fn()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkingBusyError);
    expect((error as NetworkingBusyError).cause).toBe(last);
    expect(mocks.transaction).toHaveBeenCalledTimes(NETWORKING_TXN_ATTEMPTS);
    const delays = mocks.sleep.mock.calls.map(([ms]) => ms);
    expect(delays).toHaveLength(NETWORKING_TXN_ATTEMPTS - 1);
    // Capped at 400 ms ± 50 %: the whole budget stays within a few seconds.
    expect(Math.max(...delays)).toBeLessThanOrEqual(600);
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(5_000);
  });
  it("rethrows any other error at once", async () => {
    const unique = Object.assign(new Error("duplicate"), { cause: { code: "23505" } });
    mocks.transaction.mockRejectedValue(unique);
    await expect(networkingTransaction("event", vi.fn())).rejects.toBe(unique);
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
});

describe("networkingAllocationTransaction", () => {
  function tx() {
    const calls: string[] = [];
    const lock = { values: [] as unknown[], conflict: undefined as unknown };
    const reservations = { values: [] as unknown[], conflict: undefined as unknown, deleted: false };
    let returned: { id: string }[] = [];
    const db = {
      insert: vi.fn((table: Table) => {
        const name = getTableName(table);
        calls.push(`insert ${name}`);
        const target = name === "networking_allocation_locks" ? lock : reservations;
        return {
          values: (values: unknown[]) => {
            target.values = values;
            return {
              onConflictDoUpdate: async (config: unknown) => { target.conflict = config; },
              onConflictDoNothing: (config: unknown) => {
                target.conflict = config;
                return { returning: async () => returned };
              },
            };
          },
        };
      }),
      delete: vi.fn(() => ({ where: async () => { reservations.deleted = true; } })),
    };
    return { db, calls, lock, reservations, setReturned: (rows: { id: string }[]) => { returned = rows; } };
  }
  it("upserts the ascending hour locks as its first statement, before running the write", async () => {
    const { db, calls, lock } = tx();
    mocks.transaction.mockImplementation(async (run) => run(db));
    await networkingAllocationTransaction("event", [
      { startsAt: at("11:45"), endsAt: at("12:15") },
      { startsAt: at("10:00"), endsAt: at("10:30") },
    ], async () => { calls.push("run"); });
    expect(calls).toEqual(["insert networking_allocation_locks", "run"]);
    expect(lock.values).toEqual([
      { eventId: "event", bucketStart: at("10:00") },
      { eventId: "event", bucketStart: at("11:00") },
      { eventId: "event", bucketStart: at("12:00") },
    ]);
    const conflict = lock.conflict as { target: { name: string }[]; set: object };
    expect(conflict.target.map((column) => column.name)).toEqual(["eventId", "bucketStart"]);
    expect(Object.keys(conflict.set)).toEqual(["lockedAt"]);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "serializable" });
  });
  it("refuses an allocation without intervals", async () => {
    await expect(networkingAllocationTransaction("event", [], vi.fn())).rejects.toThrow("at least one interval");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("claims all quanta with ON CONFLICT DO NOTHING and only inside the locked hours", async () => {
    const { db, reservations, setReturned } = tx();
    mocks.transaction.mockImplementation(async (run) => run(db));
    const quanta = [at("09:50"), at("09:55")];
    await networkingAllocationTransaction("event", [{ startsAt: at("09:50"), endsAt: at("10:00") }], async (store) => {
      setReturned([{ id: "r1" }, { id: "r2" }]);
      expect(await store.claimResource("event", "meeting", "table:t", quanta)).toBe(true);
      expect(reservations.values).toEqual(quanta.map((startsAt) => ({ eventId: "event", meetingId: "meeting", resourceKey: "table:t", startsAt })));
      const conflict = reservations.conflict as { target: { name: string }[] };
      expect(conflict.target.map((column) => column.name)).toEqual(["eventId", "resourceKey", "startsAt"]);
      expect(reservations.deleted).toBe(false);
      // A partial claim is undone and reported, leaving the transaction usable.
      setReturned([{ id: "r3" }]);
      expect(await store.claimResource("event", "meeting", "table:u", quanta)).toBe(false);
      expect(reservations.deleted).toBe(true);
      expect(await store.claimResource("event", "meeting", "table:u", [])).toBe(true);
      await expect(store.claimResource("event", "meeting", "table:t", [at("10:00")])).rejects.toBeInstanceOf(NetworkingAllocationLockError);
    });
  });
  it("never lets a plain networking transaction claim resources", async () => {
    const { db } = tx();
    mocks.transaction.mockImplementation(async (run) => run(db));
    await expect(networkingTransaction("event", (store) => store.claimResource("event", "m", "table:t", [at("09:00")])))
      .rejects.toBeInstanceOf(NetworkingAllocationLockError);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
