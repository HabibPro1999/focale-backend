import { describe, expect, it } from "vitest";
import { toOffsetPagination } from "./pagination";

describe("toOffsetPagination", () => {
  it.each([
    { page: 1, limit: 20, offset: 0 },
    { page: 3, limit: 10, offset: 20 },
    { page: 0, limit: 10, offset: -10 },
    { page: 1.5, limit: 5, offset: 2.5 },
    { page: 2, limit: 0, offset: 0 },
  ])("preserves raw arithmetic for page $page and limit $limit", ({ page, limit, offset }) => {
    expect(toOffsetPagination({ page, limit })).toEqual({ offset, limit });
  });
});
