import admin from "firebase-admin";

let app: admin.app.App | undefined;

// Matches old src/shared/services/firebase.service.ts credential semantics:
// FIREBASE_SERVICE_ACCOUNT holds a base64-encoded service-account JSON; otherwise
// fall back to application default credentials (GOOGLE_APPLICATION_CREDENTIALS).
function getCredential(): admin.credential.Credential {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (encoded) {
    let serviceAccount: admin.ServiceAccount;
    try {
      serviceAccount = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf-8"),
      ) as admin.ServiceAccount;
    } catch {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT is not valid base64-encoded JSON.",
      );
    }
    return admin.credential.cert(serviceAccount);
  }
  return admin.credential.applicationDefault();
}

/** Lazy singleton Firebase Admin app. */
export function getFirebaseApp(): admin.app.App {
  if (!app) {
    app = admin.initializeApp({ credential: getCredential() });
  }
  return app;
}

/** Verify a Firebase ID token (checkRevoked = true, matching the old app). */
export function verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
  return getFirebaseApp().auth().verifyIdToken(idToken, true);
}
