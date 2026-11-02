/**
 * ReDoS-safety check for user-supplied regex patterns.
 *
 * Vendored so `@app/shared` stays a dependency-free leaf. The legacy
 * `form-data-validator.ts` used the `safe-regex` npm package, which lives in
 * the app layer and pulls in `regexp-tree`; that dependency must not leak into
 * shared.
 *
 * ponytail: heuristic star-height + repetition-limit check, not a full
 * automaton analysis. It rejects the catastrophic-backtracking signatures
 * (nested quantifiers such as `(a+)+`, `(a*)*`, and oversized bounded
 * repetitions) and any pattern that fails to parse. It FAILS CLOSED — anything
 * it cannot cheaply prove safe returns false, so the caller simply skips the
 * pattern constraint (never compiles a potentially-catastrophic regex).
 * Upgrade path: swap in safe-regex/regexp-tree at the app layer if a legitimate
 * deeply-nested-but-safe pattern is being wrongly rejected in practice.
 */

const MAX_REPETITION = 25; // matches safe-regex's default repetition limit

/**
 * Returns true only if `pattern` is valid regex syntax AND its star height is
 * <= 1 (no quantifier nested inside another quantifier) AND it contains no
 * oversized bounded repetition.
 */
export function isSafePattern(pattern: string): boolean {
  // Must be valid regex syntax.
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch {
    return false;
  }

  try {
    return maxStarHeight(pattern) <= 1;
  } catch {
    // Unbalanced groups or oversized repetitions bubble up here — fail closed.
    return false;
  }
}

function maxStarHeight(pattern: string): number {
  let i = 0;
  const n = pattern.length;

  // Parse one atom plus its trailing quantifier; return its star height.
  function parseAtom(): number {
    const ch = pattern[i];
    let innerHeight = 0;

    if (ch === "(") {
      i++; // consume '('
      if (pattern[i] === "?") {
        i++; // consume '?'
        if (pattern[i] === "<") {
          const after = pattern[i + 1];
          if (after === "=" || after === "!") {
            i += 2; // lookbehind (?<= or (?<!
          } else {
            while (i < n && pattern[i] !== ">") i++; // named group (?<name>
            if (i < n) i++; // consume '>'
          }
        } else {
          i++; // non-capturing / lookahead flag (?: (?= (?!
        }
      }
      innerHeight = parseSequence();
      if (pattern[i] !== ")") throw new Error("unbalanced group");
      i++; // consume ')'
    } else if (ch === "[") {
      i++; // consume '['
      if (pattern[i] === "^") i++;
      if (pattern[i] === "]") i++; // leading literal ']'
      while (i < n && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++; // skip escaped char
        i++;
      }
      if (i >= n) throw new Error("unterminated class");
      i++; // consume ']'
    } else if (ch === "\\") {
      i += 2; // escape sequence: backslash + next char
    } else {
      i++; // single literal char (incl. '.', '^', '$')
    }

    return consumeQuantifier() ? innerHeight + 1 : innerHeight;
  }

  // Consume a quantifier at `i` if present. Returns true if it can repeat > 1.
  function consumeQuantifier(): boolean {
    const ch = pattern[i];
    let repeats: boolean;

    if (ch === "*" || ch === "+") {
      i++;
      repeats = true;
    } else if (ch === "?") {
      i++;
      repeats = false;
    } else if (ch === "{") {
      const m = /^\{(\d*)(,(\d*))?\}/.exec(pattern.slice(i));
      if (!m) return false; // a literal '{'
      i += m[0].length;
      const lower = m[1] === "" ? 0 : Number.parseInt(m[1], 10);
      const hasComma = m[2] !== undefined;
      const upperStr: string | undefined = m[3];
      const upper = !hasComma
        ? lower // {n}
        : upperStr === undefined || upperStr === ""
          ? Number.POSITIVE_INFINITY // {n,}
          : Number.parseInt(upperStr, 10); // {n,m}
      if (
        lower > MAX_REPETITION ||
        (Number.isFinite(upper) && upper > MAX_REPETITION)
      ) {
        throw new Error("repetition too large");
      }
      repeats = upper > 1; // {0,1}, {1}, {1,1} do not repeat
    } else {
      return false;
    }

    // Absorb a lazy/possessive modifier following the quantifier (e.g. `a+?`).
    if (pattern[i] === "?" || pattern[i] === "+") i++;
    return repeats;
  }

  // Parse a sequence (with alternation) at the current group level.
  function parseSequence(): number {
    let maxHeight = 0;
    while (i < n) {
      const ch = pattern[i];
      if (ch === ")") break; // let the caller consume it
      if (ch === "|") {
        i++; // alternation separator, same level
        continue;
      }
      const atomHeight = parseAtom();
      if (atomHeight > maxHeight) maxHeight = atomHeight;
    }
    return maxHeight;
  }

  const height = parseSequence();
  if (i < n) throw new Error("unbalanced"); // e.g. a stray ')'
  return height;
}
