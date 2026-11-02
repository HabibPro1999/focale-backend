/** Preserve first-seen key order and row order while keeping each query's projection explicit. */
export function groupRows<Row, Value>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  project: (row: Row) => Value,
): Map<string, Value[]> {
  const groups = new Map<string, Value[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(project(row));
    groups.set(key, group);
  }
  return groups;
}
