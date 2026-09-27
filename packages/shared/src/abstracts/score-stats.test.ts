import { describe, expect, it } from "vitest";
import { summarizeScores } from "./score-stats";

describe("summarizeScores", () => {
  it.each([
    { scores: [], expected: { average: null, min: null, max: null, spread: null } },
    { scores: [0], expected: { average: 0, min: null, max: null, spread: null } },
    { scores: [3, 9, 6], expected: { average: 6, min: 3, max: 9, spread: 6 } },
    { scores: [7, 7], expected: { average: 7, min: 7, max: 7, spread: 0 } },
  ])("summarizes $scores without changing the input", ({ scores, expected }) => {
    expect(summarizeScores(Object.freeze(scores))).toEqual(expected);
  });

  it("retains the existing left-to-right floating point sum", () => {
    expect(summarizeScores([1e16, -1e16, 1]).average).toBe(1 / 3);
    expect(summarizeScores([1, 1e16, -1e16]).average).toBe(0);
  });
});
