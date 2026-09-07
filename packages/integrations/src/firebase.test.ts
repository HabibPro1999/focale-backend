import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock("firebase-admin", () => ({
  default: {
    credential: { applicationDefault: vi.fn() },
    initializeApp: () => ({ auth: () => auth }),
  },
}));
import { verifyToken } from "./firebase";
const fetchMock = vi.fn();
const token = (authTime = 200) =>
  `header.${Buffer.from(JSON.stringify({ sub: "user", auth_time: authTime })).toString("base64url")}.signature`;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("FIREBASE_SERVICE_ACCOUNT", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("Firebase verification fallback", () => {
  it("normally uses revocation-aware Admin SDK verification", async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: "user" });
    expect(await verifyToken("id-token")).toEqual({ uid: "user" });
    expect(auth.verifyIdToken).toHaveBeenCalledWith("id-token", true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("only falls back for public-key retrieval errors", async () => {
    auth.verifyIdToken.mockRejectedValue(new Error("token expired"));
    await expect(verifyToken(token())).rejects.toThrow("token expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("delegates verification to Google with a bounded request", async () => {
    auth.verifyIdToken.mockRejectedValue(
      new Error("Error fetching public keys"),
    );
    vi.stubEnv("FIREBASE_WEB_API_KEY", "test-key");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ users: [{ localId: "user", validSince: "100" }] }),
    });
    expect(await verifyToken(token())).toMatchObject({
      uid: "user",
      auth_time: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=test-key",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
        body: JSON.stringify({ idToken: token() }),
      }),
    );
  });
  it.each([
    { users: [] },
    { users: [{ localId: "user", disabled: true }] },
    { users: [{ localId: "user", validSince: "300" }] },
  ])("rejects missing, disabled or revoked users (%j)", async (body) => {
    auth.verifyIdToken.mockRejectedValue(
      new Error("Error fetching public keys"),
    );
    fetchMock.mockResolvedValue({ ok: true, json: async () => body });
    await expect(verifyToken(token())).rejects.toThrow();
  });
  it("does not trust a token that Google rejects", async () => {
    auth.verifyIdToken.mockRejectedValue(
      new Error("Error fetching public keys"),
    );
    fetchMock.mockResolvedValue({ ok: false, status: 400 });
    await expect(verifyToken(token())).rejects.toThrow(
      "accounts:lookup failed: 400",
    );
  });
});
