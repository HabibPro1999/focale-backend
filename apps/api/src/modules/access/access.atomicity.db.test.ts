import { describe, expect, it, vi } from "vitest";
import type { CreateEventAccessInput } from "@app/contracts";
import * as db from "@app/db";
import {
  getDb,
  getEventAccessById,
  listEventAccessRows,
  pgErrorCode,
  setAccessPrerequisites,
  withTxn,
  type DbExecutor,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { seedEvent, seedEventAccess } from "../../../../../packages/db/tests/helpers/factories";
import { AccessService } from "./access.service";

// Access writes span several statements: the row, then its prerequisite edges
// (delete + insert on update); the dependents' edges, then the row on delete.
// Each runs in one transaction, so a failure in a later statement leaves
// neither a partial row nor a partial prerequisite change.
//
// The real query functions run; two are wrapped so a test can inject a failure:
// findExistingAccessIdsInEvent (to delete a prerequisite right after the
// service checked it exists, so the edge insert hits the foreign key) and
// deleteEventAccessById.
vi.mock("@app/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@app/db")>();
  return {
    ...real,
    findExistingAccessIdsInEvent: vi.fn(real.findExistingAccessIdsInEvent),
    deleteEventAccessById: vi.fn(real.deleteEventAccessById),
  };
});

const mocked = vi.mocked(db);
const service = new AccessService();

/**
 * Delete `victimId` right after the service's prerequisite existence check, on
 * the executor the check ran on. Create checks on the pool, so this is a
 * concurrent delete. Update checks inside its transaction, after locking the
 * event's access rows, where a concurrent delete would wait for it; the delete
 * runs in that transaction instead, and its rollback restores the victim.
 */
function deleteAfterExistenceCheck(victimId: string): void {
  mocked.findExistingAccessIdsInEvent.mockImplementationOnce(async (ids, eventId, exec) => {
    const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
    const executor = exec ?? getDb();
    const found = await actual.findExistingAccessIdsInEvent(ids, eventId, executor);
    await actual.deleteEventAccessById(victimId, executor);
    return found;
  });
}

async function prerequisiteIdsOf(ownerId: string, exec: DbExecutor = getDb()): Promise<string[]> {
  const row = await getEventAccessById(ownerId, exec);
  if (!row) throw new Error(`access ${ownerId} not found`);
  return row.requiredAccess.map((r) => r.id).sort();
}

async function accessIdsOfEvent(eventId: string): Promise<string[]> {
  return (await listEventAccessRows(eventId, undefined)).map((r) => r.id).sort();
}

function linkPrerequisites(ownerId: string, requiredIds: string[]): Promise<void> {
  return withTxn((tx) => setAccessPrerequisites(ownerId, requiredIds, tx));
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (err: unknown) => err,
  );
}

describe.runIf(dbTestsEnabled())("access writes are atomic", () => {
  it("create: a failed prerequisite insert leaves no access row", async () => {
    const event = await seedEvent();
    const gone = await seedEventAccess({ eventId: event.id, name: "Gone prerequisite" });
    deleteAfterExistenceCheck(gone.id);

    const err = await caught(
      service.createEventAccess({
        eventId: event.id,
        name: "Workshop",
        requiredAccessIds: [gone.id],
      } as CreateEventAccessInput),
    );

    // The row insert ran; the edge insert then hit the foreign key.
    expect(pgErrorCode(err)).toBe("23503");
    expect(await accessIdsOfEvent(event.id)).toEqual([]);
  });

  it("update: a failed prerequisite insert keeps the row and its old prerequisites", async () => {
    const event = await seedEvent();
    const kept = await seedEventAccess({ eventId: event.id, name: "Kept prerequisite" });
    const gone = await seedEventAccess({ eventId: event.id, name: "Gone prerequisite" });
    const item = await seedEventAccess({ eventId: event.id, name: "Before" });
    await linkPrerequisites(item.id, [kept.id]);
    deleteAfterExistenceCheck(gone.id);

    const err = await caught(
      service.updateEventAccess(item.id, { name: "After", requiredAccessIds: [gone.id] }),
    );

    // Row update and edge delete ran; the edge insert then hit the foreign key.
    expect(pgErrorCode(err)).toBe("23503");
    expect((await getEventAccessById(item.id))?.name).toBe("Before");
    expect(await prerequisiteIdsOf(item.id)).toEqual([kept.id]);
  });

  it("update: the row and its prerequisites commit together", async () => {
    const event = await seedEvent();
    const prereq = await seedEventAccess({ eventId: event.id, name: "Prerequisite" });
    const item = await seedEventAccess({ eventId: event.id, name: "Before" });

    const updated = await service.updateEventAccess(item.id, {
      name: "After",
      requiredAccessIds: [prereq.id],
    });

    expect(updated.name).toBe("After");
    expect(updated.requiredAccess.map((r) => r.id)).toEqual([prereq.id]);
    expect(await prerequisiteIdsOf(item.id)).toEqual([prereq.id]);
  });

  it("update: an edit of the prerequisites alone saves them and bumps updated_at", async () => {
    const event = await seedEvent();
    const prereq = await seedEventAccess({ eventId: event.id, name: "Prerequisite" });
    const item = await seedEventAccess({ eventId: event.id, name: "Item" });

    // No column changes: Drizzle refuses an empty SET, so the row write sets updated_at.
    const updated = await service.updateEventAccess(item.id, { requiredAccessIds: [prereq.id] });

    expect(updated.name).toBe("Item");
    expect(updated.requiredAccess.map((r) => r.id)).toEqual([prereq.id]);
    expect(await prerequisiteIdsOf(item.id)).toEqual([prereq.id]);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(item.updatedAt.getTime());
  });

  it("delete: a failed row delete restores the dependents' prerequisite edges", async () => {
    const event = await seedEvent();
    const item = await seedEventAccess({ eventId: event.id, name: "Required" });
    const dependent = await seedEventAccess({ eventId: event.id, name: "Dependent" });
    await linkPrerequisites(dependent.id, [item.id]);
    const failure = new Error("injected row delete failure");
    let edgesSeenInTransaction: string[] | undefined;
    mocked.deleteEventAccessById.mockImplementationOnce(async (_id, tx) => {
      // The edge removal already ran in this same transaction.
      edgesSeenInTransaction = await prerequisiteIdsOf(dependent.id, tx);
      throw failure;
    });

    await expect(service.deleteEventAccess(item.id)).rejects.toBe(failure);

    expect(edgesSeenInTransaction).toEqual([]);
    expect(await prerequisiteIdsOf(dependent.id)).toEqual([item.id]);
    expect(await accessIdsOfEvent(event.id)).toEqual([item.id, dependent.id].sort());
  });
});
