import { lookupFallbackApiKey, verifyTokenViaIdentityToolkit } from "./firebase-lookup-fallback";
import admin from "firebase-admin";
import type { Auth } from "firebase-admin/auth";
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
