import { describe, expect, it } from "vitest";
import {
  applyDeferredOption,
  parseArguments,
  requireNoPositionals,
  throughOption,
} from "./cli-arguments";

describe("migrator CLI scope arguments", () => {
  it("rejects empty through and apply-deferred values", () => {
    expect(() => throughOption(parseArguments(["apply", "--through="]))).toThrow("Use --through=NNNN");
    expect(() => applyDeferredOption(parseArguments(["apply", "--apply-deferred="]))).toThrow("Use --apply-deferred=NNNN");
  });

  it("rejects stray positional arguments before a command connects", () => {
    expect(() => requireNoPositionals(parseArguments(["verify", "unexpected"]), "verify"))
      .toThrow("verify does not accept positional arguments");
  });

  it("keeps valid scope values and omitted values distinct", () => {
    expect(throughOption(parseArguments(["plan"]))).toBeUndefined();
    expect(throughOption(parseArguments(["plan", "--through=0018"]))).toBe("0018");
    expect(applyDeferredOption(parseArguments(["apply", "--apply-deferred=0017"]))).toBe("0017");
  });
});
