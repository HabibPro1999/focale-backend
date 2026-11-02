/** Form answers must be object records; arrays and null have no field keys. */
export function asFormRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
