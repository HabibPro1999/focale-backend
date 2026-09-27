export const DEFAULT_REVIEWERS_PER_ABSTRACT = 2;
export const DEFAULT_DIVERGENCE_THRESHOLD = 6;

export interface ScoreStatistics {
  average: number | null;
  min: number | null;
  max: number | null;
  spread: number | null;
}

/** Callers retain their score filtering and their own review-count/divergence policy. */
export function summarizeScores(scores: readonly number[]): ScoreStatistics {
  const average =
    scores.length === 0
      ? null
      : scores.reduce((sum, score) => sum + score, 0) / scores.length;
  if (scores.length < 2) return { average, min: null, max: null, spread: null };
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return { average, min, max, spread: max - min };
}
