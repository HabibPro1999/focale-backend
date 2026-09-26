/**
 * Score-divergence alert policy for abstract reviews.
 *
 * After a review, when the abstract's scored reviews spread by more than zero
 * and by at least the event's divergence threshold, each active client admin
 * gets an ABSTRACT_SCORE_DIVERGENCE email and the organizer UI a realtime
 * event. An alert email queued within the last hour suppresses a new alert,
 * and each admin's email is deduplicated per clock hour.
 */

/** The suppression window, and the size of the dedupe bucket. */
export const SCORE_DIVERGENCE_ALERT_WINDOW_MS = 60 * 60 * 1000;

/** What an alert reports: the email's extra context, and the realtime payload with the abstract id. */
export type ScoreDivergenceDetails = {
  averageScore: number | null;
  reviewCount: number;
  minScore: number;
  maxScore: number;
  divergenceThreshold: number;
};

export interface ScoreDivergenceAlert {
  /** A divergence email for the abstract queued at or after this time suppresses the alert. */
  suppressedByAlertSince: Date;
  /** The clock hour the admin emails are deduplicated in. */
  hourBucket: number;
  details: ScoreDivergenceDetails;
}

/**
 * The alert a review raises, or null when the scores don't diverge: fewer
 * than two scores, a zero spread, or a spread under the threshold.
 */
export function planScoreDivergenceAlert(input: {
  /** Scores of the abstract's active, scored reviews. */
  scores: readonly number[];
  threshold: number;
  averageScore: number | null;
  reviewCount: number;
  /** Epoch milliseconds. */
  now: number;
}): ScoreDivergenceAlert | null {
  const { scores, threshold } = input;
  if (scores.length < 2) return null;
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const spread = maxScore - minScore;
  if (spread <= 0 || spread < threshold) return null;
  return {
    suppressedByAlertSince: new Date(input.now - SCORE_DIVERGENCE_ALERT_WINDOW_MS),
    hourBucket: Math.floor(input.now / SCORE_DIVERGENCE_ALERT_WINDOW_MS),
    details: {
      averageScore: input.averageScore,
      reviewCount: input.reviewCount,
      minScore,
      maxScore,
      divergenceThreshold: threshold,
    },
  };
}

/** Outbox dedupe key of one admin's divergence email: one per abstract, admin and clock hour. */
export function scoreDivergenceEmailDedupeKey(
  abstractId: string,
  recipientEmail: string,
  hourBucket: number,
): string {
  return `email:abstract:ABSTRACT_SCORE_DIVERGENCE:${abstractId}:${recipientEmail}:${hourBucket}`;
}
