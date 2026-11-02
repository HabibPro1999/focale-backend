/** Same-type exclusivity; OTHER is additionally separated by its group label. */
export function getExclusivityKey(access: { type: string; groupLabel: string | null }): string {
  return access.type === "OTHER" ? `OTHER:${access.groupLabel ?? ""}` : access.type;
}

/** Touching endpoints do not overlap. Callers keep their own missing-date guards. */
export function timeRangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return !(aEnd.getTime() <= bStart.getTime() || bEnd.getTime() <= aStart.getTime());
}
