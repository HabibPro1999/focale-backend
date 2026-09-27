import { describe, expect, it } from "vitest";
import { summarizeScores } from "./abstract-scores";

describe("abstract score statistics", () => {
  it.each([
    { scores: [], expected: { average: null, min: null, max: null, spread: null } },
    { scores: [0], expected: { average: 0, min: null, max: null, spread: null } },
    { scores: [7], expected: { average: 7, min: null, max: null, spread: null } },
    { scores: [7, 7], expected: { average: 7, min: 7, max: 7, spread: 0 } },
    { scores: [9, 1, 5], expected: { average: 5, min: 1, max: 9, spread: 8 } },
    { scores: [1, 2, 2], expected: { average: 5 / 3, min: 1, max: 2, spread: 1 } },
  ])("keeps average and spread semantics for $scores", ({ scores, expected }) => {
    expect(summarizeScores(scores)).toEqual(expected);
  });

  it("retains left-to-right addition and propagates non-finite values", () => {
    expect(summarizeScores([1e16, -1e16, 1]).average).toBe(1 / 3);
    expect(summarizeScores([NaN, 1])).toEqual({ average: NaN, min: NaN, max: NaN, spread: NaN });
  });
});
