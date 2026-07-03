import admin from "firebase-admin";
import type { ActionCodeSettings, Auth } from "firebase-admin/auth";
import type { Storage } from "firebase-admin/storage";

// ponytail: lazy-init deviation from legacy (was eager at import). Still
// fail-fast loudly on first use so the API/worker can boot in tests without
// creds. Every legacy error message is preserved verbatim.

/**
 * Resolve the Firebase Admin credential.
 * Priority: FIREBASE_SERVICE_ACCOUNT (base64-encoded JSON) → application default
 * (GOOGLE_APPLICATION_CREDENTIALS file path).
 */
function getCredential(): admin.credential.Credential {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccount) {
    let parsed: object;
    try {
      const jsonString = Buffer.from(serviceAccount, "base64").toString(
        "utf-8",
      );
      parsed = JSON.parse(jsonString);
    } catch {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT is not valid base64-encoded JSON. " +
          "Ensure the environment variable contains a base64-encoded Firebase service account JSON file.",
      );
    }
    return admin.credential.cert(parsed as admin.ServiceAccount);
  }
  // Fallback to application default (GOOGLE_APPLICATION_CREDENTIALS file path)
  return admin.credential.applicationDefault();
}

let app: admin.app.App | null = null;

/** Initialize (once) and return the Firebase Admin app. Fail-fast on bad creds. */
function getApp(): admin.app.App {
  if (!app) {
    const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
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
 * Verify a Firebase ID token and return the decoded token.
 * The `true` second arg checks token revocation.
 */
export async function verifyToken(idToken: string) {
  return getFirebaseAuth().verifyIdToken(idToken, true);
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
 * Generate a one-time password-reset link. Used to onboard newly created
 * accounts without requiring an admin to set (and share) a temporary password.
 */
export async function generatePasswordResetLink(
  email: string,
  actionCodeSettings?: ActionCodeSettings,
): Promise<string> {
  return getFirebaseAuth().generatePasswordResetLink(email, actionCodeSettings);
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
