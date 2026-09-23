import { describe, expect, it } from "vitest";
import { normalizeSqlExpression } from "./sql-expression-normalizer";

describe("normalizeSqlExpression", () => {
  it("preserves case and whitespace inside string literals", () => {
    expect(normalizeSqlExpression("scope IN ('BOTH')"))
      .not.toBe(normalizeSqlExpression("scope IN ('both')"));
    expect(normalizeSqlExpression("'A  B'")).not.toBe(normalizeSqlExpression("'a b'"));
    expect(normalizeSqlExpression("'A''B'")).not.toBe(normalizeSqlExpression("'a''b'"));
  });

  it("preserves case-sensitive quoted identifiers", () => {
    expect(normalizeSqlExpression('"Scope" = 1'))
      .not.toBe(normalizeSqlExpression('"scope" = 1'));
    expect(normalizeSqlExpression('"scope" = 1')).toBe(normalizeSqlExpression("scope=1"));
    expect(normalizeSqlExpression('"trigger" IS NULL')).toBe(normalizeSqlExpression("trigger is null"));
    expect(normalizeSqlExpression('"SELECT" = 1'))
      .not.toBe(normalizeSqlExpression("select = 1"));
  });

  it("normalizes syntax outside literals without changing their contents", () => {
    expect(normalizeSqlExpression("scope = 'BOTH'::text"))
      .toBe(normalizeSqlExpression("scope='BOTH'"));
    expect(normalizeSqlExpression("'PENDING'::\"AbstractBookJobStatus\""))
      .toBe(normalizeSqlExpression("'PENDING'"));
    expect(normalizeSqlExpression("capacity BETWEEN 1 AND 10"))
      .toBe(normalizeSqlExpression("capacity >= 1 and capacity <= 10"));
    expect(normalizeSqlExpression("scope = ANY(ARRAY['A'::text, 'B'::text])"))
      .toBe(normalizeSqlExpression("scope IN ('A', 'B')"));
    expect(normalizeSqlExpression("CURRENT_TIMESTAMP"))
      .toBe(normalizeSqlExpression("now()"));
  });

  it("keeps escaped and dollar-quoted literal bytes intact", () => {
    expect(normalizeSqlExpression("E'A\\\\B'"))
      .not.toBe(normalizeSqlExpression("E'a\\\\b'"));
    expect(normalizeSqlExpression("$tag$A  B$tag$"))
      .not.toBe(normalizeSqlExpression("$tag$a b$tag$"));
  });
});
