/** Defaults, integer conversion and OFFSET behavior stay explicit at each query's call site. */
export const clampNetworkingPageLimit = (limit: number) => Math.min(100, Math.max(1, limit));
