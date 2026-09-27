type Review = { reviewerId: string; active: boolean };

/** Scoring always requires an active explicit assignment. */
export function hasActiveReview(reviews: readonly Review[], reviewerId: string): boolean {
  return reviews.some((review) => review.reviewerId === reviewerId && review.active);
}

/** Viewing additionally allows active theme coverage; it does not grant scoring. */
export function canViewAbstract(
  abstract: { reviews: readonly Review[]; themes: ReadonlyArray<{ id: string }> },
  reviewerId: string,
  reviewerThemeIds: readonly string[],
): boolean {
  if (hasActiveReview(abstract.reviews, reviewerId)) return true;
  if (reviewerThemeIds.length === 0) return false;
  const covered = new Set(reviewerThemeIds);
  return abstract.themes.some((theme) => covered.has(theme.id));
}
