import { describe, expect, it } from "vitest";
import { pickDefined } from "./pick-defined";

describe("pickDefined", () => {
  it("preserves explicit falsy values and null, omitting undefined and unlisted keys", () => {
    const source = { absent: undefined, zero: 0, empty: "", no: false, cleared: null, private: "secret" };
    expect(pickDefined(source, ["absent", "zero", "empty", "no", "cleared"])).toEqual({ zero: 0, empty: "", no: false, cleared: null });
    expect(source.private).toBe("secret");
  });
});
