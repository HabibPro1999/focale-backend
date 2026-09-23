// SQL keywords that PostgreSQL requires or commonly retains in quotes when
// they are used as identifiers. Lower-case non-keyword identifiers may safely
// compare as quoted or unquoted; preserve the spelling of other quoted names.
const QUOTED_KEYWORDS = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric",
  "authorization", "between", "binary", "both", "case", "cast", "check", "collate",
  "collation", "column", "concurrently", "constraint", "create", "cross", "current_catalog",
  "current_date", "current_role", "current_schema", "current_time", "current_timestamp",
  "current_user", "default", "deferrable", "desc", "distinct", "do", "else", "end",
  "except", "false", "fetch", "for", "foreign", "from", "full", "grant", "group",
  "having", "ilike", "in", "initially", "inner", "intersect", "into", "is", "isnull",
  "join", "lateral", "leading", "left", "like", "limit", "localtime", "localtimestamp",
  "natural", "new", "not", "notnull", "null", "offset", "old", "on", "only", "or",
  "order", "outer", "overlaps", "placing", "primary", "references", "returning", "right",
  "select", "session_user", "similar", "some", "symmetric", "table", "then", "to",
  "trailing", "true", "union", "unique", "user", "using", "variadic", "when",
  "where", "window", "with",
]);

function readQuotedIdentifierEnd(expression: string, start: number): number {
  for (let index = start + 1; index < expression.length; index++) {
    if (expression[index] !== '"') continue;
    if (expression[index + 1] === '"') {
      index++;
      continue;
    }
    return index + 1;
  }
  return expression.length;
}

function readSingleQuotedEnd(
  expression: string,
  start: number,
  backslashEscapes: boolean,
): number {
  for (let index = start + 1; index < expression.length; index++) {
    if (backslashEscapes && expression[index] === "\\") {
      index++;
      continue;
    }
    if (expression[index] !== "'") continue;
    if (expression[index + 1] === "'") {
      index++;
      continue;
    }
    return index + 1;
  }
  return expression.length;
}

function readDollarQuotedEnd(expression: string, start: number): number | undefined {
  const delimiter = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(expression.slice(start))?.[0];
  if (!delimiter) return undefined;
  const close = expression.indexOf(delimiter, start + delimiter.length);
  return close < 0 ? undefined : close + delimiter.length;
}

function protectQuotedTokens(expression: string): {
  text: string;
  restore(normalized: string): string;
} {
  const protectedTokens: Array<{ marker: string; original: string }> = [];
  let text = "";
  let index = 0;

  const protect = (original: string, kind: "literal" | "identifier") => {
    const marker = `\uE000${kind === "literal" ? "s" : "q"}${protectedTokens.length}\uE001`;
    protectedTokens.push({ marker, original });
    text += marker;
  };

  while (index < expression.length) {
    if (expression[index] === "'") {
      const escapePrefix = index > 0 && /e/i.test(expression[index - 1]) &&
        (index === 1 || !/[a-z0-9_$]/i.test(expression[index - 2]));
      const tokenStart = escapePrefix ? index - 1 : index;
      const end = readSingleQuotedEnd(expression, index, escapePrefix);
      protect(expression.slice(tokenStart, end), "literal");
      index = end;
      continue;
    }

    if (expression[index] === '"') {
      const end = readQuotedIdentifierEnd(expression, index);
      const original = expression.slice(index, end);
      const decoded = original.slice(1, -1).replace(/""/g, '"');
      if (/^[a-z_][a-z0-9_]*$/.test(decoded) && !QUOTED_KEYWORDS.has(decoded)) {
        text += decoded;
      } else {
        protect(original, "identifier");
      }
      index = end;
      continue;
    }

    if (expression[index] === "$") {
      const end = readDollarQuotedEnd(expression, index);
      if (end !== undefined) {
        protect(expression.slice(index, end), "literal");
        index = end;
        continue;
      }
    }

    text += expression[index];
    index++;
  }

  return {
    text,
    restore(normalized: string) {
      for (const token of protectedTokens) {
        normalized = normalized.replace(token.marker, token.original);
      }
      return normalized;
    },
  };
}

/** Canonicalize SQL syntax without changing literal bytes or quoted-name case. */
export function normalizeSqlExpression(
  expression: string | null,
  tableName?: string,
): string | null {
  if (expression === null) return null;
  const protectedExpression = protectQuotedTokens(expression);
  const tableQualifier = tableName ? new RegExp(`\\b${tableName}\\.`, "gi") : /$^/;
  const normalized = protectedExpression.text
    .replace(tableQualifier, "")
    .replace(
      /(\uE000s\d+\uE001)\s*::\s*(?:(?:\uE000q\d+\uE001|"(?:[^"]|"")+"|[a-z_][a-z0-9_]*)\s*\.\s*)?(?:\uE000q\d+\uE001|"(?:[^"]|"")+"|[a-z_][a-z0-9_]*)(?:\[\])?(?:\s+(?:without|with)\s+time\s+zone)?/gi,
      "$1",
    )
    .replace(/\btimestamp\s+(\uE000s\d+\uE001)/gi, "$1")
    .replace(/\bcurrent_timestamp\b/gi, "now()")
    .replace(/\b((?:[a-z_][a-z0-9_]*\s*\([^()]*\)|[a-z_][a-z0-9_]*))\s+between\s+([+-]?\w+)\s+and\s+([+-]?\w+)/gi, "$1 >= $2 AND $1 <= $3")
    .replace(/\b([a-z_][a-z0-9_]*)\s*=\s*any\s*\(\s*array\s*\[([^\]]*)\]\s*\)/gi, "$1 IN ($2)")
    .replace(/\bin\s*\(([^()]*)\)/gi, "IN[$1]")
    .replace(/\(([a-z_][a-z0-9_]*\s+in\x5b[^\x5b\x5d]*\x5d)\)/gi, "$1")
    .replace(/\s*(>=|<=|<>|!=|=|>|<)\s*/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .toLowerCase();
  // Restore exact literal and case-sensitive identifier bytes only after all
  // syntax normalization, especially lower-casing, has finished.
  return protectedExpression.restore(normalized);
}
