import { beforeEach, describe, expect, it, vi } from "vitest";

const txn = vi.hoisted(() => ({ transactions: 0 }));
vi.mock("../txn", () => ({
  withExportStatementTimeout: vi.fn(async (fn: (tx: unknown) => unknown) => {
    txn.transactions += 1;
    return fn({ tx: txn.transactions });
  }),
}));

import { EXPORT_PAGE_SIZE, exportPageSize, pagesByIds } from "./export-pages";

type Row = { id: string; n: number };

async function drain<T>(pages: AsyncIterable<T[]>): Promise<T[][]> {
  const out: T[][] = [];
  for await (const page of pages) out.push(page);
  return out;
}

beforeEach(() => {
  txn.transactions = 0;
});

describe("exportPageSize", () => {
  it("defaults to EXPORT_PAGE_SIZE and refuses a non-positive or fractional size", () => {
    expect(EXPORT_PAGE_SIZE).toBe(500);
    expect(exportPageSize({})).toBe(500);
    expect(exportPageSize({ pageSize: 3 })).toBe(3);
    for (const pageSize of [0, -1, 1.5]) {
      expect(() => exportPageSize({ pageSize })).toThrow("positive integer");
    }
  });
});

describe("pagesByIds (3.7b)", () => {
  it("reads the ids a chunk at a time, one export transaction each, rows in the ids' order", async () => {
    const fetched: Array<{ ids: string[]; tx: unknown }> = [];
    const ids = ["e", "a", "d", "b", "c"];

    const pages = await drain(
      pagesByIds<Row>(
        ids,
        { pageSize: 2 },
        async (chunk, tx) => {
          fetched.push({ ids: chunk, tx });
          // The database returns a chunk in any order.
          return [...chunk].sort().map((id) => ({ id, n: ids.indexOf(id) }));
        },
        (row) => row.id,
      ),
    );

    expect(fetched).toEqual([
      { ids: ["e", "a"], tx: { tx: 1 } },
      { ids: ["d", "b"], tx: { tx: 2 } },
      { ids: ["c"], tx: { tx: 3 } },
    ]);
    expect(pages.map((page) => page.map((row) => row.id))).toEqual([["e", "a"], ["d", "b"], ["c"]]);
  });

  it("skips ids whose row is gone, and a chunk with none left", async () => {
    const pages = await drain(
      pagesByIds<Row>(
        ["a", "gone-1", "gone-2", "gone-3", "b"],
        { pageSize: 2 },
        async (chunk) => chunk.filter((id) => !id.startsWith("gone")).map((id) => ({ id, n: 0 })),
        (row) => row.id,
      ),
    );

    expect(pages.map((page) => page.map((row) => row.id))).toEqual([["a"], ["b"]]);
  });

  it("reads nothing for no ids", async () => {
    const fetch = vi.fn();
    expect(await drain(pagesByIds<Row>([], {}, fetch, (row) => row.id))).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops before the next chunk once the signal aborts", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (chunk: string[]) => chunk.map((id) => ({ id, n: 0 })));
    const pages = pagesByIds<Row>(["a", "b", "c"], { pageSize: 1, signal: controller.signal }, fetch, (row) => row.id);

    await expect(pages.next()).resolves.toMatchObject({ done: false });
    controller.abort(new Error("client gone"));

    await expect(pages.next()).rejects.toThrow("client gone");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
