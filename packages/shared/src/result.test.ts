import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, map, mapErr, unwrapOr } from "./result";

describe("result", () => {
  it("ok/err and guards", () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(err("x"))).toBe(true);
    expect(isOk(err("x"))).toBe(false);
  });

  it("map only over ok", () => {
    expect(map(ok(2), (v) => v * 3)).toEqual(ok(6));
    expect(map(err<string>("e"), (v: number) => v * 3)).toEqual(err("e"));
  });

  it("mapErr only over err", () => {
    expect(mapErr(err("e"), (e) => e + "!")).toEqual(err("e!"));
    expect(mapErr(ok(1), (e: string) => e + "!")).toEqual(ok(1));
  });

  it("unwrapOr", () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
    expect(unwrapOr(err("e"), 0)).toBe(0);
  });
});
