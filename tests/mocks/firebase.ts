import { vi } from "vitest";
import type { DecodedIdToken } from "firebase-admin/auth";

/**
 * Mock Firebase Auth service.
 * Provides mocked methods for token verification, user management, and claims.
 */
export const firebaseAuthMock = {
  verifyIdToken: vi.fn<(token: string) => Promise<DecodedIdToken>>(),
  getUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  setCustomUserClaims: vi.fn(),
};

/**
 * Mock Firebase Storage service.
 * Provides mocked methods for file operations.
 */
export const firebaseStorageMock = {
  bucket: vi.fn(() => ({
    file: vi.fn(() => ({
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getSignedUrl: vi
        .fn()
        .mockResolvedValue(["https://storage.example.com/signed-url"]),
      exists: vi.fn().mockResolvedValue([true]),
      makePublic: vi.fn().mockResolvedValue(undefined),
      publicUrl: vi
        .fn()
        .mockReturnValue("https://storage.example.com/public-url"),
    })),
  })),
};

// Mock Firebase Admin SDK modules
vi.mock("firebase-admin", () => ({
  default: {
    initializeApp: vi.fn(() => ({
      auth: () => firebaseAuthMock,
      storage: () => firebaseStorageMock,
    })),
    credential: {
      cert: vi.fn(),
      applicationDefault: vi.fn(),
    },
  },
}));

// Mock the firebase service module
vi.mock("@shared/services/firebase.service.js", () => ({
  firebaseAuth: firebaseAuthMock,
  firebaseStorage: firebaseStorageMock,
  verifyToken: firebaseAuthMock.verifyIdToken,
  createFirebaseUser: firebaseAuthMock.createUser,
  setCustomClaims: firebaseAuthMock.setCustomUserClaims,
  deleteFirebaseUser: firebaseAuthMock.deleteUser,
}));

/**
 * Helper to create a mock decoded token for testing.
 */
export function createMockDecodedToken(
  overrides: Partial<DecodedIdToken> = {},
): DecodedIdToken {
  return {
    uid: "firebase-uid-123",
    email: "test@example.com",
    email_verified: true,
    aud: "demo-project",
    auth_time: Math.floor(Date.now() / 1000) - 3600,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: "https://securetoken.google.com/demo-project",
    sub: "firebase-uid-123",
    firebase: {
      identities: {},
      sign_in_provider: "password",
    },
    ...overrides,
  };
}
