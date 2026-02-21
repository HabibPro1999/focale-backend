// ============================================================================
// Access Type Helpers
// ============================================================================

/**
 * Get the type key for grouping access items.
 * Items with type OTHER are grouped by groupLabel, others by type.
 */
export function getAccessTypeKey(
  type: string,
  groupLabel: string | null,
): string {
  return type === "OTHER" ? `OTHER:${groupLabel || ""}` : type;
}
