import admin from "firebase-admin";
import type { Auth } from "firebase-admin/auth";
import type { Storage } from "firebase-admin/storage";
import { config } from "@config/app.config.js";

// Initialize Firebase Admin SDK
// Uses FIREBASE_SERVICE_ACCOUNT env var (Base64-encoded JSON) or falls back to GOOGLE_APPLICATION_CREDENTIALS
function getCredential() {
  if (config.firebase.serviceAccount) {
    let serviceAccount: object;
    try {
      const jsonString = Buffer.from(
        config.firebase.serviceAccount,
        "base64",
      ).toString("utf-8");
      serviceAccount = JSON.parse(jsonString);
    } catch {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT is not valid base64-encoded JSON. " +
          "Ensure the environment variable contains a base64-encoded Firebase service account JSON file.",
      );
    }
    return admin.credential.cert(serviceAccount as admin.ServiceAccount);
  }
  // Fallback to application default (GOOGLE_APPLICATION_CREDENTIALS file path)
  return admin.credential.applicationDefault();
}

const app = admin.initializeApp({
  credential: getCredential(),
  ...(config.firebase.storageBucket && {
    storageBucket: config.firebase.storageBucket,
  }),
});

// Explicit type annotations fix TypeScript inference error
export const firebaseAuth: Auth = app.auth();
export const firebaseStorage: Storage = app.storage();

/**
 * Verify Firebase ID token and return decoded token.
 */
export async function verifyToken(idToken: string) {
  return firebaseAuth.verifyIdToken(idToken, true);
}

/**
 * Create a new Firebase Auth user.
 */
export async function createFirebaseUser(email: string, password: string) {
  return firebaseAuth.createUser({
    email,
    password,
    emailVerified: true, // Admin-created accounts are pre-verified
  });
}

/**
 * Set custom claims on a Firebase user (role + clientId).
 */
export async function setCustomClaims(
  uid: string,
  claims: Record<string, unknown>,
): Promise<void> {
  await firebaseAuth.setCustomUserClaims(uid, claims);
}

/**
 * Delete a Firebase Auth user.
 */
export async function deleteFirebaseUser(uid: string): Promise<void> {
  await firebaseAuth.deleteUser(uid);
}
