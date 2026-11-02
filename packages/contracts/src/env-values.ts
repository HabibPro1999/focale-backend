export const DEFAULT_LOCAL_ORIGIN = "http://localhost:8080";

/**
 * Canonical origin of an HTTP(S) URL with no credentials, path, query, hash
 * or wildcard (URL parsing would accept a `*` host label).
 */
export function canonicalOrigin(value: string): string | null {
  if (value.includes("*")) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function listEntries(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Canonical origins of a comma list, or null when any entry is invalid. */
export function parseOriginList(raw: string | undefined): string[] | null {
  const origins: string[] = [];
  for (const entry of listEntries(raw)) {
    const origin = canonicalOrigin(entry);
    if (!origin) return null;
    origins.push(origin);
  }
  return [...new Set(origins)];
}

/** Parse a rate-limit window: bare milliseconds or "<n> <unit>". */
export function parseRateLimitWindowMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match =
    /^(\d+)\s*(ms|s|sec|second|seconds|m|min|minute|minutes|h|hour|hours)$/i.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit === "ms") return n;
  if (unit.startsWith("h")) return n * 3_600_000;
  if (unit === "m" || unit.startsWith("min")) return n * 60_000;
  return n * 1_000;
}

export function isJsonObject(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
