import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { generateEditToken, hashEditToken, verifyEditToken } from "@modules/registrations/edit-token.js";

vi.mock("@/database/client.js", () => ({
  prisma: {
    registration: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

const { prisma } = await import("@/database/client.js");
// vi.mock factory returns plain `unknown` — narrow once to the surface used here.
const prismaMock = prisma as never as {
  registration: { findUnique: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function futureDate(offsetMs = 24 * 60 * 60 * 1000) {
  return new Date(Date.now() + offsetMs);
}
function pastDate(offsetMs = 1000) {
  return new Date(Date.now() - offsetMs);
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.auditLog.create.mockResolvedValue({} as never);
});

describe("generateEditToken", () => {
  it("generates a 64-char hex string", () => {
    const token = generateEditToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateEditToken()));
    expect(tokens.size).toBe(100);
  });
});

describe("hashEditToken", () => {
  it("produces a 64-char hex SHA-256 hash", () => {
    const token = generateEditToken();
    const hash = hashEditToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const token = generateEditToken();
    expect(hashEditToken(token)).toBe(hashEditToken(token));
  });

  it("matches manual SHA-256 computation", () => {
    const token = "a".repeat(64);
    expect(hashEditToken(token)).toBe(sha256(token));
  });
});

describe("verifyEditToken", () => {
  it("round-trip: generate → hash → verify → true (event in future)", async () => {
    const token = generateEditToken();
    const hash = hashEditToken(token);
    prismaMock.registration.findUnique.mockResolvedValue({
      editTokenHash: hash,
      event: { startDate: futureDate() },
    } as never);

    const result = await verifyEditToken("reg-id", token);
    expect(result).toBe(true);
  });

  it("tampered token: returns false", async () => {
    const token = generateEditToken();
    const hash = hashEditToken(token);
    const tamperedToken = generateEditToken(); // different token
    prismaMock.registration.findUnique.mockResolvedValue({
      editTokenHash: hash,
      event: { startDate: futureDate() },
    } as never);

    const result = await verifyEditToken("reg-id", tamperedToken);
    expect(result).toBe(false);
  });

  it("event already started: throws EDIT_TOKEN_EXPIRED", async () => {
    const token = generateEditToken();
    const hash = hashEditToken(token);
    prismaMock.registration.findUnique.mockResolvedValue({
      editTokenHash: hash,
      event: { startDate: pastDate() },
    } as never);

    const { AppError } = await import("@shared/errors/app-error.js");
    await expect(verifyEditToken("reg-id", token)).rejects.toBeInstanceOf(AppError);
  });

  it("event date moved later: token still valid (dynamic expiry)", async () => {
    const token = generateEditToken();
    const hash = hashEditToken(token);
    // Simulate admin moved event 30 days out
    prismaMock.registration.findUnique.mockResolvedValue({
      editTokenHash: hash,
      event: { startDate: futureDate(30 * 24 * 60 * 60 * 1000) },
    } as never);

    const result = await verifyEditToken("reg-id", token);
    expect(result).toBe(true);
  });

  it("missing token (editTokenHash is null): returns false", async () => {
    prismaMock.registration.findUnique.mockResolvedValue({
      editTokenHash: null,
      event: { startDate: futureDate() },
    } as never);

    const result = await verifyEditToken("reg-id", generateEditToken());
    expect(result).toBe(false);
  });

  it("registration not found: returns false", async () => {
    prismaMock.registration.findUnique.mockResolvedValue(null);

    const result = await verifyEditToken("nonexistent", generateEditToken());
    expect(result).toBe(false);
  });

  it("logs audit on not_found", async () => {
    prismaMock.registration.findUnique.mockResolvedValue(null);

    await verifyEditToken("reg-id", generateEditToken());

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "EDIT_TOKEN_INVALID",
          changes: expect.objectContaining({ reason: { old: null, new: "not_found" } }),
        }),
      }),
    );
  });

  it("logs audit on hash_mismatch", async () => {
    const token = generateEditToken();
    const hash = hashEditToken(token);
    prismaMock.registration.findUnique.mockResolvedValue({
      editTokenHash: hash,
      event: { startDate: futureDate() },
    } as never);

    await verifyEditToken("reg-id", generateEditToken()); // wrong token

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "EDIT_TOKEN_INVALID",
          changes: expect.objectContaining({ reason: { old: null, new: "hash_mismatch" } }),
        }),
      }),
    );
  });

  it("logs audit on expired", async () => {
    const token = generateEditToken();
    const hash = hashEditToken(token);
    prismaMock.registration.findUnique.mockResolvedValue({
      editTokenHash: hash,
      event: { startDate: pastDate() },
    } as never);

    await verifyEditToken("reg-id", token).catch(() => undefined);

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "EDIT_TOKEN_INVALID",
          changes: expect.objectContaining({ reason: { old: null, new: "expired" } }),
        }),
      }),
    );
  });
});
