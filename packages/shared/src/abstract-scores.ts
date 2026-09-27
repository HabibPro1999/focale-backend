export const DEFAULT_REVIEWERS_PER_ABSTRACT = 2;
export const DEFAULT_DIVERGENCE_THRESHOLD = 6;

/** Statistics only: callers retain their different divergence policies. */
export function summarizeScores(scores: readonly number[]): {
  average: number | null;
  min: number | null;
  max: number | null;
  spread: number | null;
} {
  const average = scores.length === 0
    ? null
    : scores.reduce((sum, score) => sum + score, 0) / scores.length;
  if (scores.length < 2) return { average, min: null, max: null, spread: null };
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return { average, min, max, spread: max - min };
}
