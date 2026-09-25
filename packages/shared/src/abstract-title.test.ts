import { describe, expect, it } from "vitest";
import { getAbstractTitle } from "./abstract-title";

describe("getAbstractTitle", () => {
  it("returns the trimmed title", () => {
    expect(getAbstractTitle({ title: "  Heart failure  ", body: "x" })).toBe("Heart failure");
  });

  it.each([null, undefined, "title", ["title"], {}, { title: 42 }, { title: "   " }])(
    "falls back for %j",
    (content) => {
      expect(getAbstractTitle(content)).toBe("Untitled abstract");
      expect(getAbstractTitle(content, "")).toBe("");
    },
  );
});
