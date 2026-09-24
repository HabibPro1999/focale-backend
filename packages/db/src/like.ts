import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

/**
 * Escape LIKE/ILIKE metacharacters so user input matches literally: the
 * escape character `\` first, then `%` and `_`. Pair it with an explicit
 * `ESCAPE '\'` (see {@link ilikeContains}) so the escape character never
 * depends on engine defaults — identical on PostgreSQL and CockroachDB.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Case-insensitive "contains" match of a literal term:
 * `column ILIKE '%<escaped term>%' ESCAPE '\'`. The term is a bound parameter.
 */
export function ilikeContains(column: AnyColumn | SQL, term: string): SQL {
  return sql`${column} ILIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`;
}
