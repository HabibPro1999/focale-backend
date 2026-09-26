import { describe, expect, it } from "vitest";
import {
  SCORE_DIVERGENCE_ALERT_WINDOW_MS,
  planScoreDivergenceAlert,
  scoreDivergenceEmailDedupeKey,
} from "./score-divergence";

const HOUR = 60 * 60 * 1000;
const now = Date.UTC(2030, 0, 1, 10, 25, 30, 500);
const plan = (scores: number[], threshold: number) =>
  planScoreDivergenceAlert({ scores, threshold, averageScore: 12.5, reviewCount: 3, now });

describe("planScoreDivergenceAlert", () => {
  it.each([[[]], [[7]], [[20]]])("needs two scores: %j", (scores) => {
    expect(plan(scores, 0)).toBeNull();
  });

  it("does not alert on a zero spread, even with a zero threshold", () => {
    expect(plan([10, 10, 10], 0)).toBeNull();
  });

  it("does not alert under the threshold", () => {
    expect(plan([10, 15], 6)).toBeNull();
  });

  it("alerts from a spread equal to the threshold", () => {
    expect(plan([10, 16], 6)).not.toBeNull();
    expect(plan([10, 11], 0)).not.toBeNull();
  });

  it("reports min, max, average, count and threshold, whatever the score order", () => {
    expect(plan([14, 3, 9, 20], 6)?.details).toEqual({
      averageScore: 12.5,
      reviewCount: 3,
      minScore: 3,
      maxScore: 20,
      divergenceThreshold: 6,
    });
    expect(
      planScoreDivergenceAlert({ scores: [1, 9], threshold: 2, averageScore: null, reviewCount: 0, now })
        ?.details.averageScore,
    ).toBeNull();
  });

  it("is suppressed by an alert from the last hour and deduplicated per clock hour", () => {
    const alert = plan([0, 25], 6);
    expect(SCORE_DIVERGENCE_ALERT_WINDOW_MS).toBe(HOUR);
    expect(alert?.suppressedByAlertSince).toEqual(new Date(now - HOUR));
    expect(alert?.hourBucket).toBe(Math.floor(now / HOUR));
    const startOfHour = Date.UTC(2030, 0, 1, 11);
    const at = (t: number) =>
      planScoreDivergenceAlert({ scores: [0, 25], threshold: 6, averageScore: 1, reviewCount: 2, now: t })
        ?.hourBucket;
    expect(at(startOfHour - 1)).toBe(at(now));
    expect(at(startOfHour)).toBe(at(now)! + 1);
  });
});

describe("scoreDivergenceEmailDedupeKey", () => {
  it("scopes the email to the abstract, the admin and the hour", () => {
    expect(scoreDivergenceEmailDedupeKey("abs-1", "admin@example.test", 527_890)).toBe(
      "email:abstract:ABSTRACT_SCORE_DIVERGENCE:abs-1:admin@example.test:527890",
    );
  });
});
