import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";
import * as db from "@app/db";
import {
  getAccessCapacityInfo,
  getEventPrereqEdges,
  setAccessPrerequisites,
  withLockingTxn,
  withTxn,
  type DbExecutor,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { makeBarrier } from "../../../../../packages/db/tests/helpers/barrier";
import { seedEvent, seedEventAccess } from "../../../../../packages/db/tests/helpers/factories";
import { AccessService } from "./access.service";

// An access edit decides from the row it re-read under its lock:
// - lowering maxCapacity races the paid-count CAS of a payment; paid_count
//   never ends above max_capacity, and the side that loses gets
//   ACCESS_CAPACITY_EXCEEDED;
// - two prerequisite edits that together would close a cycle queue on the
//   event's access rows; the second sees the first's edges and is refused.
//
// A payment is AccessService.syncPaidCountDelta in a locking transaction: the
// paid-count move every payment writer goes through (applyPaidAccessDelta's
// guarded CAS). updateEventAccessRow is wrapped so a test can pause an edit
// after its row write, with its locks held.
vi.mock("@app/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@app/db")>();
  return { ...real, updateEventAccessRow: vi.fn(real.updateEventAccessRow) };
});

const mocked = vi.mocked(db);
const access = new AccessService();

afterEach(() => {
  mocked.updateEventAccessRow.mockReset();
  mocked.updateEventAccessRow.mockImplementation(realUpdateEventAccessRow);
});

async function realUpdateEventAccessRow(
  ...args: Parameters<typeof db.updateEventAccessRow>
): ReturnType<typeof db.updateEventAccessRow> {
  const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
  return actual.updateEventAccessRow(...args);
}

function paidState(accessId: string, status: string) {
  return { status, priceBreakdown: { accessItems: [{ accessId, quantity: 1 }] } };
}

/** One payment settling on `accessId`: its paid count goes up by one, within capacity. */
function takeOnePaidPlace(tx: DbExecutor, eventId: string, accessId: string): Promise<void> {
  return access.syncPaidCountDelta(eventId, paidState(accessId, "PENDING"), paidState(accessId, "PAID"), tx);
}

function payOnePlace(eventId: string, accessId: string): Promise<void> {
  return withLockingTxn((tx) => takeOnePaidPlace(tx, eventId, accessId));
}

async function capacityOf(accessId: string) {
  const row = await getAccessCapacityInfo(accessId);
  if (!row) throw new Error(`access ${accessId} not found`);
  return { maxCapacity: row.maxCapacity, paidCount: row.paidCount };
}

/** True when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
}

/** Start a transaction that runs `hold`, then keeps its row locks until `release()`. */
async function holdTransaction(hold: (tx: DbExecutor) => Promise<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const isHeld = new Promise<void>((resolve) => (held = resolve));
  const done = withTxn(async (tx) => {
    await hold(tx);
    held();
    await released;
  });
  await Promise.race([isHeld, done]);
  return { release, done };
}

/** Row-lock these access rows, ascending, by touching each (updated_at only). */
async function lockAccessRows(tx: DbExecutor, ids: string[]) {
  for (const id of [...ids].sort()) await realUpdateEventAccessRow(id, {}, tx);
}

function codeOf(result: PromiseSettledResult<unknown>): string | undefined {
  return result.status === "rejected" ? (result.reason as { code?: string }).code : undefined;
}

/** Whether the event's stored prerequisite graph has a cycle. */
async function storedGraphHasCycle(eventId: string): Promise<boolean> {
  const graph = new Map<string, string[]>();
  for (const { owner, required } of await getEventPrereqEdges(eventId)) {
    graph.set(owner, [...(graph.get(owner) ?? []), required]);
  }
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (node: string): boolean => {
    if (onPath.has(node)) return true;
    if (done.has(node)) return false;
    onPath.add(node);
    for (const next of graph.get(node) ?? []) if (visit(next)) return true;
    onPath.delete(node);
    done.add(node);
    return false;
  };
  return [...graph.keys()].some(visit);
}

function linkPrerequisites(ownerId: string, requiredIds: string[]): Promise<void> {
  return withTxn((tx) => setAccessPrerequisites(ownerId, requiredIds, tx));
}

async function seedItems(eventId: string, names: string[]) {
  const items = [];
  for (const name of names) items.push(await seedEventAccess({ eventId, name }));
  return items;
}

describe.runIf(dbTestsEnabled())("lowering an access item's capacity vs a concurrent payment", () => {
  it("a payment that commits while the edit waits is counted: the edit is refused", async () => {
    const event = await seedEvent();
    const item = await seedEventAccess({ eventId: event.id, maxCapacity: 5, paidCount: 1, registeredCount: 2 });

    // The payment's CAS holds the row until its transaction commits.
    const payment = await holdTransaction((tx) => takeOnePaidPlace(tx, event.id, item.id));
    let edit: Promise<unknown>;
    try {
      edit = access.updateEventAccess(item.id, { maxCapacity: 1 });
      expect(await settlesWithin(edit, 400)).toBe(false);
    } finally {
      payment.release();
      await payment.done;
    }

    await expect(edit).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      details: { paidCount: 2, requestedMaxCapacity: 1 },
    });
    expect(await capacityOf(item.id)).toEqual({ maxCapacity: 5, paidCount: 2 });
  });

  it("a payment that arrives while the edit holds the row meets the new capacity and is refused", async () => {
    const event = await seedEvent();
    const item = await seedEventAccess({ eventId: event.id, maxCapacity: 5, paidCount: 1, registeredCount: 2 });
    let paused!: () => void;
    const isPaused = new Promise<void>((resolve) => (paused = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    mocked.updateEventAccessRow.mockImplementationOnce(async (...args) => {
      const row = await realUpdateEventAccessRow(...args);
      paused();
      await resumed;
      return row;
    });

    const edit = access.updateEventAccess(item.id, { maxCapacity: 1 });
    let payment: Promise<void>;
    try {
      await Promise.race([isPaused, edit]);
      payment = payOnePlace(event.id, item.id);
      expect(await settlesWithin(payment, 400)).toBe(false);
    } finally {
      resume();
    }

    await expect(edit).resolves.toMatchObject({ maxCapacity: 1 });
    await expect(payment).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      details: { remaining: 0, requested: 1 },
    });
    expect(await capacityOf(item.id)).toEqual({ maxCapacity: 1, paidCount: 1 });
  });

  it("never leaves paid above capacity when an edit and a payment start together", async () => {
    const event = await seedEvent();
    for (let round = 0; round < 5; round += 1) {
      const item = await seedEventAccess({ eventId: event.id, maxCapacity: 3, paidCount: 2, registeredCount: 3 });
      const barrier = makeBarrier(2);
      const [edit, payment] = await Promise.allSettled([
        barrier().then(() => access.updateEventAccess(item.id, { maxCapacity: 2 })),
        barrier().then(() => payOnePlace(event.id, item.id)),
      ]);

      const final = await capacityOf(item.id);
      expect(final.paidCount).toBeLessThanOrEqual(final.maxCapacity!);
      // Exactly one side wins, and the loser gets the capacity refusal.
      if (edit.status === "fulfilled") {
        expect(codeOf(payment)).toBe(ErrorCodes.ACCESS_CAPACITY_EXCEEDED);
        expect(final).toEqual({ maxCapacity: 2, paidCount: 2 });
      } else {
        expect(edit.reason).toMatchObject({
          code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
          details: { paidCount: 3, requestedMaxCapacity: 2 },
        });
        expect(payment.status).toBe("fulfilled");
        expect(final).toEqual({ maxCapacity: 3, paidCount: 3 });
      }
    }
  });
});

describe.runIf(dbTestsEnabled())("two concurrent prerequisite edits that together would form a cycle", () => {
  /**
   * Hold the event's access rows, queue both edits behind them, then release:
   * each edit's own check ran (or would run) before the other committed.
   */
  async function queueBothBehindHeldRows(ids: string[], first: () => Promise<unknown>, second: () => Promise<unknown>) {
    const holder = await holdTransaction((tx) => lockAccessRows(tx, ids));
    try {
      const a = first();
      expect(await settlesWithin(a, 400)).toBe(false);
      const b = second();
      expect(await settlesWithin(b, 400)).toBe(false);
      holder.release();
      await holder.done;
      return await Promise.allSettled([a, b]);
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
    }
  }

  function expectOneRefusedAsCycle(results: PromiseSettledResult<unknown>[]) {
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.map(codeOf).filter(Boolean)).toEqual([ErrorCodes.ACCESS_CIRCULAR_DEPENDENCY]);
  }

  it("A requires B vs B requires A: one wins, the other is refused, no cycle is stored", async () => {
    const event = await seedEvent();
    const [a, b] = await seedItems(event.id, ["A", "B"]);

    const results = await queueBothBehindHeldRows(
      [a!.id, b!.id],
      () => access.updateEventAccess(a!.id, { requiredAccessIds: [b!.id] }),
      () => access.updateEventAccess(b!.id, { requiredAccessIds: [a!.id] }),
    );

    expectOneRefusedAsCycle(results);
    expect(await storedGraphHasCycle(event.id)).toBe(false);
    expect(await getEventPrereqEdges(event.id)).toHaveLength(1);
  });

  it("closes through existing edges between rows neither edit names (A→B→C→D→A)", async () => {
    // Existing: B requires C, D requires A. The edits name {A, B} and {C, D}:
    // no row in common, so only locking the whole event's rows serializes them.
    const event = await seedEvent();
    const [a, b, c, d] = await seedItems(event.id, ["A", "B", "C", "D"]);
    await linkPrerequisites(b!.id, [c!.id]);
    await linkPrerequisites(d!.id, [a!.id]);

    const results = await queueBothBehindHeldRows(
      [a!.id, b!.id, c!.id, d!.id],
      () => access.updateEventAccess(a!.id, { requiredAccessIds: [b!.id] }),
      () => access.updateEventAccess(c!.id, { requiredAccessIds: [d!.id] }),
    );

    expectOneRefusedAsCycle(results);
    expect(await storedGraphHasCycle(event.id)).toBe(false);
    expect(await getEventPrereqEdges(event.id)).toHaveLength(3);
  });

  it("never stores a cycle when the two edits start together", async () => {
    for (let round = 0; round < 3; round += 1) {
      const event = await seedEvent();
      const [a, b, c, d] = await seedItems(event.id, ["A", "B", "C", "D"]);
      await linkPrerequisites(b!.id, [c!.id]);
      await linkPrerequisites(d!.id, [a!.id]);
      const barrier = makeBarrier(2);

      const results = await Promise.allSettled([
        barrier().then(() => access.updateEventAccess(a!.id, { requiredAccessIds: [b!.id] })),
        barrier().then(() => access.updateEventAccess(c!.id, { requiredAccessIds: [d!.id] })),
      ]);

      expectOneRefusedAsCycle(results);
      expect(await storedGraphHasCycle(event.id)).toBe(false);
    }
  });
});
