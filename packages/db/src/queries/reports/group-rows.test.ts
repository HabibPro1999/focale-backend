import { describe, expect, it } from "vitest";
import { groupRows } from "./group-rows";

describe("report row grouping", () => {
  it("preserves first-seen key order and interleaved row order with an explicit projection", () => {
    const rows = [
      { parent: "b", value: 3, privateColumn: "hidden" },
      { parent: "a", value: 1, privateColumn: "hidden" },
      { parent: "b", value: 2, privateColumn: "hidden" },
      { parent: "", value: 0, privateColumn: "hidden" },
    ];
    const groups = groupRows(rows, (row) => row.parent, (row) => ({ value: row.value }));
    expect([...groups]).toEqual([
      ["b", [{ value: 3 }, { value: 2 }]],
      ["a", [{ value: 1 }]],
      ["", [{ value: 0 }]],
    ]);
    expect(rows[0]).toEqual({ parent: "b", value: 3, privateColumn: "hidden" });
  });

  it("returns an empty map for no rows", () => {
    expect([...groupRows<string, string>([], (row) => row, (row) => row)]).toEqual([]);
  });
});
