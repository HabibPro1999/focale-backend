export const FIREBASE_SERVICE_ACCOUNT_INVALID_MESSAGE =
  "FIREBASE_SERVICE_ACCOUNT must be a service account JSON object, either raw or base64-encoded";

/**
 * Decode FIREBASE_SERVICE_ACCOUNT: raw JSON (starts with "{") or base64 of
 * that JSON. Throws with a value-free message when neither yields an object.
 */
export function decodeFirebaseServiceAccount(raw: string): Record<string, unknown> {
  const value = raw.trim();
  const json = value.startsWith("{")
    ? value
    : Buffer.from(value, "base64").toString("utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(FIREBASE_SERVICE_ACCOUNT_INVALID_MESSAGE);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(FIREBASE_SERVICE_ACCOUNT_INVALID_MESSAGE);
  }
  return parsed as Record<string, unknown>;
}
