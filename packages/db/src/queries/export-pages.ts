// ============================================================================
// Export paging shared by the report and abstract exports: pages of at most
// EXPORT_PAGE_SIZE rows, each read in its own short transaction under the
// export statement timeout, so a slow client never holds a transaction open
// and no statement carries a huge IN list.
// ============================================================================

import type { DbExecutor } from "../client";
import { withExportStatementTimeout } from "../txn";

/** Rows per export page: one short statement each, never a huge IN list. */
export const EXPORT_PAGE_SIZE = 500;

export interface ExportPageOptions {
  /** Rows per page (default EXPORT_PAGE_SIZE). */
  pageSize?: number;
  /** Checked before each page: an aborted export stops fetching. */
  signal?: AbortSignal;
}

export function exportPageSize(options: ExportPageOptions): number {
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("Export page size must be a positive integer");
  }
  return pageSize;
}

/**
 * Loads rows by id, `ids` being already in export order (ordering that SQL
 * cannot express portably, such as a French collation, or a nullable sort key
 * whose NULL placement differs between PostgreSQL and CockroachDB). Each
 * chunk of ids is fetched in its own export transaction; its rows are yielded
 * in `ids` order, and an id whose row is gone by then is skipped.
 */
export async function* pagesByIds<T>(
  ids: readonly string[],
  options: ExportPageOptions,
  fetch: (ids: string[], tx: DbExecutor) => Promise<T[]>,
  idOf: (row: T) => string,
): AsyncGenerator<T[]> {
  const pageSize = exportPageSize(options);
  for (let start = 0; start < ids.length; start += pageSize) {
    options.signal?.throwIfAborted();
    const chunk = ids.slice(start, start + pageSize);
    const rows = await withExportStatementTimeout((tx) => fetch(chunk, tx));
    const byId = new Map(rows.map((row) => [idOf(row), row]));
    const page: T[] = [];
    for (const id of chunk) {
      const row = byId.get(id);
      if (row !== undefined) page.push(row);
    }
    if (page.length > 0) yield page;
  }
}
