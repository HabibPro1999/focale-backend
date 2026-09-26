import { describe, expect, it, vi } from "vitest";
import type { DbExecutor } from "../client";
import { accessPrerequisites } from "../schema";
import { insertEventAccess, setAccessPrerequisites } from "./access";

/** A fake executor recording the table of each insert/delete, in order. */
function fakeExecutor(opts: { transaction: boolean }) {
  const statements: string[] = [];
  const exec = {
    delete: vi.fn((table: unknown) => {
      statements.push(table === accessPrerequisites ? "delete prerequisites" : "delete ?");
      return { where: vi.fn(async () => undefined) };
    }),
    insert: vi.fn((table: unknown) => {
      statements.push(table === accessPrerequisites ? "insert prerequisites" : "insert ?");
      return { values: vi.fn(async () => undefined) };
    }),
    ...(opts.transaction ? { rollback: vi.fn() } : {}),
  };
  return { exec: exec as unknown as DbExecutor, statements };
}

describe("setAccessPrerequisites", () => {
  it("deletes then inserts the edges on the one transaction it is given", async () => {
    const { exec, statements } = fakeExecutor({ transaction: true });
    await setAccessPrerequisites("owner", ["p1", "p2"], exec);
    expect(statements).toEqual(["delete prerequisites", "insert prerequisites"]);
  });

  it("refuses to run outside a transaction, before any statement", async () => {
    const { exec, statements } = fakeExecutor({ transaction: false });
    await expect(setAccessPrerequisites("owner", ["p1"], exec)).rejects.toThrow(
      "setAccessPrerequisites must run inside a transaction",
    );
    expect(statements).toEqual([]);
  });
});

describe("insertEventAccess", () => {
  it("refuses to run outside a transaction, before any statement", async () => {
    const { exec, statements } = fakeExecutor({ transaction: false });
    await expect(
      insertEventAccess({ eventId: "e1", name: "Workshop" }, ["p1"], exec),
    ).rejects.toThrow("insertEventAccess must run inside a transaction");
    expect(statements).toEqual([]);
  });
});
