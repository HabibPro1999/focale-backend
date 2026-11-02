/**
 * The title of an abstract's `content` JSON: the trimmed `title` string, or
 * `fallback` when it is missing or blank. The single helper for the admin and
 * committee views, exports, the Abstract Book, certificates and emails.
 */
export function getAbstractTitle(
  content: unknown,
  fallback = "Untitled abstract",
): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as { title?: unknown }).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return fallback;
}
