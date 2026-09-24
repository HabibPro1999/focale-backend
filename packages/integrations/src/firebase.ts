import { createHash } from "node:crypto";
import admin from "firebase-admin";
import type { DecodedIdToken, Auth } from "firebase-admin/auth";
import type { Storage } from "firebase-admin/storage";
import { decodeFirebaseServiceAccount } from "@app/contracts";
import { integrationsConfig } from "./config";

// ponytail: lazy-init deviation from legacy (was eager at import). Still
// fail-fast loudly on first use so the API/worker can boot in tests without
// creds. Every legacy error message is preserved verbatim.

/**
 * Resolve the Firebase Admin credential.
 * Priority: FIREBASE_SERVICE_ACCOUNT (raw or base64-encoded JSON, validated at
 * boot) → application default (GOOGLE_APPLICATION_CREDENTIALS file path).
 */
function getCredential(): admin.credential.Credential {
  const serviceAccount = integrationsConfig().firebase.serviceAccount;
  if (serviceAccount) {
    const parsed = decodeFirebaseServiceAccount(serviceAccount);
    return admin.credential.cert(parsed as admin.ServiceAccount);
  }
  // Fallback to application default (GOOGLE_APPLICATION_CREDENTIALS file path)
  return admin.credential.applicationDefault();
}

let app: admin.app.App | null = null;

/** Initialize (once) and return the Firebase Admin app. Fail-fast on bad creds. */
function getApp(): admin.app.App {
  if (!app) {
    const storageBucket = integrationsConfig().firebase.storageBucket;
    app = admin.initializeApp({
      credential: getCredential(),
      ...(storageBucket && { storageBucket }),
    });
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  return getApp().auth();
}

export function getFirebaseStorage(): Storage {
  return getApp().storage();
}

// ---------------------------------------------------------------------------
// accounts:lookup fallback
//
// ponytail: Google 403-blocks our Render egress IP for the x509 cert endpoint,
// which kills local signature verification in the Admin SDK. When explicitly
// enabled (FIREBASE_AUTH_LOOKUP_FALLBACK=true + FIREBASE_WEB_API_KEY), the API
// lets Google verify the token server-side via identitytoolkit accounts:lookup
// and then checks the token's own claims against this project. Remove once
// the IP is unblocked.
//
// Successful lookups are cached by sha256(token) for at most
// min(exp - now, 5 min). Consequence: on this fallback path only, a token
// revoked (or a user disabled) after its first successful lookup can stay
// accepted for up to 5 minutes. The normal Admin SDK path is unaffected and
// checks revocation on every request.
// ---------------------------------------------------------------------------

const SECURE_TOKEN_ISSUER_PREFIX = "https://securetoken.google.com/";
const LOOKUP_CACHE_MAX_TTL_MS = 5 * 60_000;
const LOOKUP_CACHE_MAX_ENTRIES = 1_000;

type CachedLookup = { decoded: DecodedIdToken; expiresAt: number };
const lookupCache = new Map<string, CachedLookup>();

function lookupFallbackApiKey(): string | null {
  const firebase = integrationsConfig().firebase;
  if (!firebase.authLookupFallback) return null;
  return firebase.webApiKey || null;
}

function lookupCacheKey(idToken: string): string {
  return createHash("sha256").update(idToken).digest("hex");
}

function readCachedLookup(key: string, now: number): DecodedIdToken | null {
  const entry = lookupCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    lookupCache.delete(key);
    return null;
  }
  return { ...entry.decoded };
}

function cacheLookup(key: string, decoded: DecodedIdToken, now: number): void {
  const expiresAt = Math.min(decoded.exp * 1000, now + LOOKUP_CACHE_MAX_TTL_MS);
  if (expiresAt <= now) return;
  lookupCache.delete(key);
  while (lookupCache.size >= LOOKUP_CACHE_MAX_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest === undefined) break;
    lookupCache.delete(oldest);
  }
  lookupCache.set(key, { decoded: { ...decoded }, expiresAt });
}

function decodeTokenPayload(idToken: string): Record<string, unknown> {
  const segments = idToken.split(".");
  if (segments.length !== 3) {
    throw new Error("identitytoolkit: malformed ID token");
  }
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(segments[1] ?? "", "base64url").toString("utf-8"),
    );
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
  } catch {
    // fall through to the generic error; never echo token contents
  }
  throw new Error("identitytoolkit: malformed ID token payload");
}

/**
 * Check the claims Google's accounts:lookup does not bind to this project.
 * Mirrors the Admin SDK's own ID-token claim checks.
 */
function assertProjectClaims(
  payload: Record<string, unknown>,
  projectId: string,
  nowSeconds: number,
): asserts payload is Record<string, unknown> & {
  sub: string;
  exp: number;
  auth_time: number;
} {
  if (payload.aud !== projectId) {
    throw new Error("identitytoolkit: token has incorrect aud claim");
  }
  if (payload.iss !== `${SECURE_TOKEN_ISSUER_PREFIX}${projectId}`) {
    throw new Error("identitytoolkit: token has incorrect iss claim");
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    throw new Error("identitytoolkit: token exp claim is missing or past");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("identitytoolkit: token sub claim is missing");
  }
  if (typeof payload.auth_time !== "number" || payload.auth_time > nowSeconds) {
    throw new Error(
      "identitytoolkit: token auth_time claim is missing or in the future",
    );
  }
}

/**
 * Verify an ID token through Google's accounts:lookup, then bind its claims to
 * this project. Only reached when the fallback is explicitly configured.
 */
async function verifyTokenViaIdentityToolkit(
  idToken: string,
  apiKey: string,
): Promise<DecodedIdToken> {
  const projectId = integrationsConfig().firebase.projectId;
  if (!projectId) {
    throw new Error("identitytoolkit: FIREBASE_PROJECT_ID is not configured");
  }
  const cacheKey = lookupCacheKey(idToken);
  const cached = readCachedLookup(cacheKey, Date.now());
  if (cached) return cached;

  // Reject tokens minted for another project (or expired) before spending a
  // Google round-trip on them; re-checked after the lookup below.
  assertProjectClaims(
    decodeTokenPayload(idToken),
    projectId,
    Math.floor(Date.now() / 1000),
  );

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );
  if (!res.ok) {
    throw new Error(`identitytoolkit accounts:lookup failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    users?: Array<{ localId: string; disabled?: boolean; validSince?: string }>;
  };
  const user = body.users?.[0];
  if (!user) {
    throw new Error("identitytoolkit accounts:lookup returned no user");
  }
  if (user.disabled) {
    throw new Error("identitytoolkit: user is disabled");
  }
  // accounts:lookup only succeeds for a token Google itself verified, so the
  // payload's signature is sound; its claims still have to name this project.
  const now = Date.now();
  const payload = decodeTokenPayload(idToken);
  assertProjectClaims(payload, projectId, Math.floor(now / 1000));
  if (payload.sub !== user.localId) {
    throw new Error("identitytoolkit: token sub does not match looked-up user");
  }
  if (payload.auth_time < Number(user.validSince ?? 0)) {
    throw new Error("identitytoolkit: token issued before revocation");
  }
  const decoded = { ...payload, uid: user.localId } as unknown as DecodedIdToken;
  cacheLookup(cacheKey, decoded, now);
  return decoded;
}

/**
 * Verify a Firebase ID token and return the decoded token. The Admin SDK path
 * checks revocation (`true` second arg). The accounts:lookup fallback runs only
 * for public-key retrieval failures, and only when explicitly configured;
 * otherwise the original verification error propagates.
 */
export async function verifyToken(idToken: string) {
  try {
    return await getFirebaseAuth().verifyIdToken(idToken, true);
  } catch (error) {
    const apiKey = lookupFallbackApiKey();
    if (
      apiKey &&
      error instanceof Error &&
      error.message.includes("Error fetching public keys")
    ) {
      return verifyTokenViaIdentityToolkit(idToken, apiKey);
    }
    throw error;
  }
}

/**
 * Create a new Firebase Auth user. Admin-created accounts are pre-verified.
 */
export async function createFirebaseUser(email: string, password: string) {
  return getFirebaseAuth().createUser({
    email,
    password,
    emailVerified: true,
  });
}

/**
 * Set custom claims on a Firebase user (role + clientId).
 */
export async function setCustomClaims(
  uid: string,
  claims: Record<string, unknown>,
): Promise<void> {
  await getFirebaseAuth().setCustomUserClaims(uid, claims);
}

/**
 * Delete a Firebase Auth user.
 */
export async function deleteFirebaseUser(uid: string): Promise<void> {
  await getFirebaseAuth().deleteUser(uid);
}

/**
 * Set a Firebase Auth user's password directly. Used by admin override flows
 * where the target user has lost access to their email.
 */
export async function updateFirebaseUserPassword(
  uid: string,
  password: string,
): Promise<void> {
  await getFirebaseAuth().updateUser(uid, { password });
}

/**
 * Invalidate all refresh tokens for a Firebase Auth user. Pairs with a direct
 * password change so existing sessions cannot keep refreshing with the old
 * credential context.
 */
export async function revokeFirebaseRefreshTokens(uid: string): Promise<void> {
  await getFirebaseAuth().revokeRefreshTokens(uid);
}
