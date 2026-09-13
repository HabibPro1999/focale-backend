export function normalizeNetworkingSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}
function networkingSoundex(value: string) {
  if (!/^[a-z]+$/.test(value)) return "";
  const groups: Record<string, string> = {
    b: "1",
    f: "1",
    p: "1",
    v: "1",
    c: "2",
    g: "2",
    j: "2",
    k: "2",
    q: "2",
    s: "2",
    x: "2",
    z: "2",
    d: "3",
    t: "3",
    l: "4",
    m: "5",
    n: "5",
    r: "6",
  };
  let result = value[0];
  let previous = groups[value[0]];
  for (const letter of value.slice(1)) {
    const digit = groups[letter];
    if (digit && digit !== previous) result += digit;
    previous = digit;
  }
  return (result + "000").slice(0, 4);
}
function networkingEditDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}
/** Lexical score: exact words, prefixes, substrings, bounded typos, then phonetic matches. */
export function networkingSearchScore(
  query: string,
  text: string,
): number | null {
  const tokens = normalizeNetworkingSearch(query).split(/\s+/).filter(Boolean);
  const words = normalizeNetworkingSearch(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    const code = token.length >= 4 ? networkingSoundex(token) : "";
    for (const word of words) {
      if (word === token) {
        best = 1;
        break;
      }
      if (word.startsWith(token)) {
        best = Math.max(best, 0.9);
        continue;
      }
      if (word.includes(token)) {
        best = Math.max(best, 0.8);
        continue;
      }
      if (token.length >= 4 && Math.abs(word.length - token.length) <= 2) {
        const distance = networkingEditDistance(word, token);
        if (distance <= (token.length >= 8 ? 2 : 1))
          best = Math.max(best, 0.7 - distance * 0.1);
      }
      if (code && word.length >= 4 && code === networkingSoundex(word))
        best = Math.max(best, 0.4);
    }
    if (!best) return null;
    total += best;
  }
  return tokens.length ? total / tokens.length : 0;
}
export function networkingSearchMatches(query: string, text: string) {
  return networkingSearchScore(query, text) !== null;
}
