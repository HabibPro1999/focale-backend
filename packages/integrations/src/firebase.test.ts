import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock("firebase-admin", () => ({
  default: {
    credential: { applicationDefault: vi.fn() },
    initializeApp: () => ({ auth: () => auth }),
  },
}));

type FirebaseModule = typeof import("./firebase.js");
let verifyToken: FirebaseModule["verifyToken"];

const PROJECT = "demo-project";
const NOW_S = 1_800_000_000;
const fetchMock = vi.fn();

type Claims = Record<string, unknown>;
const validClaims = (overrides: Claims = {}): Claims => ({
  aud: PROJECT,
  iss: `https://securetoken.google.com/${PROJECT}`,
  sub: "user",
  auth_time: NOW_S - 600,
  iat: NOW_S - 60,
  exp: NOW_S + 3_000,
  ...overrides,
});
const token = (claims: Claims = validClaims()) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const lookupOk = (user: Record<string, unknown> = {}) =>
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      users: [{ localId: "user", validSince: String(NOW_S - 3_600), ...user }],
    }),
  });
const keysUnavailable = () =>
  auth.verifyIdToken.mockRejectedValue(new Error("Error fetching public keys"));

beforeEach(async () => {
  vi.resetAllMocks();
  // Fresh module per test: the lookup cache is module state.
  vi.resetModules();
  ({ verifyToken } = await import("./firebase.js"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_S * 1000);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("FIREBASE_SERVICE_ACCOUNT", "");
  vi.stubEnv("FIREBASE_PROJECT_ID", PROJECT);
  vi.stubEnv("FIREBASE_AUTH_LOOKUP_FALLBACK", "true");
  vi.stubEnv("FIREBASE_WEB_API_KEY", "test-key");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Firebase verification", () => {
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
});

describe("accounts:lookup fallback gating", () => {
  it("propagates the original error without fetching when the flag is off", async () => {
    vi.stubEnv("FIREBASE_AUTH_LOOKUP_FALLBACK", "false");
    keysUnavailable();
    lookupOk();
    await expect(verifyToken(token())).rejects.toThrow(
      "Error fetching public keys",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates the original error without fetching when the flag is unset", async () => {
    vi.stubEnv("FIREBASE_AUTH_LOOKUP_FALLBACK", undefined);
    keysUnavailable();
    await expect(verifyToken(token())).rejects.toThrow(
      "Error fetching public keys",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never falls back to a built-in web API key", async () => {
    vi.stubEnv("FIREBASE_WEB_API_KEY", undefined);
    keysUnavailable();
    await expect(verifyToken(token())).rejects.toThrow(
      "Error fetching public keys",
    );
    vi.stubEnv("FIREBASE_WEB_API_KEY", "");
    await expect(verifyToken(token())).rejects.toThrow(
      "Error fetching public keys",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("accounts:lookup fallback verification", () => {
  it("delegates verification to Google with a bounded request", async () => {
    keysUnavailable();
    lookupOk();
    expect(await verifyToken(token())).toMatchObject({
      uid: "user",
      sub: "user",
      aud: PROJECT,
      auth_time: NOW_S - 600,
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
    ["wrong aud", { aud: "other-project" }],
    ["missing aud", { aud: undefined }],
    ["wrong iss", { iss: "https://securetoken.google.com/other-project" }],
    ["non-Firebase iss", { iss: `https://accounts.google.com/${PROJECT}` }],
    ["expired exp", { exp: NOW_S - 1 }],
    ["exp equal to now", { exp: NOW_S }],
    ["missing exp", { exp: undefined }],
    ["empty sub", { sub: "" }],
    ["missing sub", { sub: undefined }],
    ["missing auth_time", { auth_time: undefined }],
    ["future auth_time", { auth_time: NOW_S + 60 }],
    ["non-numeric auth_time", { auth_time: "123" }],
  ])("rejects a token with %s", async (_label, overrides) => {
    keysUnavailable();
    lookupOk();
    await expect(verifyToken(token(validClaims(overrides)))).rejects.toThrow(
      /identitytoolkit/,
    );
  });

  it("rejects a token whose sub differs from the looked-up localId", async () => {
    keysUnavailable();
    lookupOk({ localId: "someone-else" });
    await expect(verifyToken(token())).rejects.toThrow(/sub/);
  });

  it("rejects an undecodable token payload", async () => {
    keysUnavailable();
    lookupOk();
    await expect(verifyToken("not-a-jwt")).rejects.toThrow(/identitytoolkit/);
    await expect(verifyToken("a.%%%.c")).rejects.toThrow(/identitytoolkit/);
  });

  it.each([
    { users: [] },
    { users: [{ localId: "user", disabled: true }] },
    { users: [{ localId: "user", validSince: String(NOW_S) }] },
  ])("rejects missing, disabled or revoked users (%j)", async (body) => {
    keysUnavailable();
    fetchMock.mockResolvedValue({ ok: true, json: async () => body });
    await expect(verifyToken(token())).rejects.toThrow();
  });

  it("does not trust a token that Google rejects", async () => {
    keysUnavailable();
    fetchMock.mockResolvedValue({ ok: false, status: 400 });
    await expect(verifyToken(token())).rejects.toThrow(
      "accounts:lookup failed: 400",
    );
  });
});

describe("accounts:lookup fallback cache", () => {
  it("serves a repeated token from cache without a second lookup", async () => {
    keysUnavailable();
    lookupOk();
    const first = await verifyToken(token());
    const second = await verifyToken(token());
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not share entries between different tokens", async () => {
    keysUnavailable();
    lookupOk();
    await verifyToken(token());
    await verifyToken(token(validClaims({ iat: NOW_S - 30 })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed lookups", async () => {
    keysUnavailable();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(verifyToken(token())).rejects.toThrow("failed: 503");
    lookupOk();
    await expect(verifyToken(token())).resolves.toMatchObject({ uid: "user" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache tokens rejected by claim checks", async () => {
    keysUnavailable();
    lookupOk({ localId: "someone-else" });
    await expect(verifyToken(token())).rejects.toThrow(/sub/);
    await expect(verifyToken(token())).rejects.toThrow(/sub/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("expires entries after five minutes when the token outlives that", async () => {
    keysUnavailable();
    lookupOk();
    await verifyToken(token());
    vi.setSystemTime(NOW_S * 1000 + 5 * 60_000 - 1);
    await verifyToken(token());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW_S * 1000 + 5 * 60_000);
    await verifyToken(token());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("expires entries at the token's exp when that comes first", async () => {
    keysUnavailable();
    lookupOk();
    const shortLived = token(validClaims({ exp: NOW_S + 120 }));
    await verifyToken(shortLived);
    vi.setSystemTime((NOW_S + 120) * 1000 - 1);
    await verifyToken(shortLived);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime((NOW_S + 120) * 1000);
    await expect(verifyToken(shortLived)).rejects.toThrow(/exp/);
  });

  it("stays bounded by evicting the oldest entries", async () => {
    keysUnavailable();
    lookupOk();
    const first = token(validClaims({ iat: 0 }));
    await verifyToken(first);
    for (let i = 1; i <= 1_000; i += 1) {
      await verifyToken(token(validClaims({ iat: i })));
    }
    expect(fetchMock).toHaveBeenCalledTimes(1_001);
    await verifyToken(first);
    expect(fetchMock).toHaveBeenCalledTimes(1_002);
  });
});
