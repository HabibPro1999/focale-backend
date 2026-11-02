import { describe, expect, it } from "vitest";
import {
  adoptOptions,
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

describe("migrator CLI adopt arguments", () => {
  it("is a dry run unless --apply is given", () => {
    expect(adoptOptions(parseArguments(["adopt"]))).toEqual({ writeLedger: false });
    expect(adoptOptions(parseArguments(["adopt", "--apply"]))).toEqual({ writeLedger: true });
  });

  it("rejects unknown options, values and positionals before connecting", () => {
    expect(() => adoptOptions(parseArguments(["adopt", "--yes"]))).toThrow("Unknown option: --yes");
    expect(() => adoptOptions(parseArguments(["adopt", "--apply=true"]))).toThrow("Unknown option: --apply");
    expect(() => adoptOptions(parseArguments(["adopt", "--through=0018"]))).toThrow("Unknown option: --through");
    expect(() => adoptOptions(parseArguments(["adopt", "apply"]))).toThrow("adopt does not accept positional arguments");
  });
});
