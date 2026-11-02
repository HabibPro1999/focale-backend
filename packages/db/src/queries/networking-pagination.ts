/** Only the shared 1..100 clamp; callers keep defaults, offset and integer/NaN handling. */
export const networkingPageLimit = (limit: number) => Math.min(100, Math.max(1, limit));
