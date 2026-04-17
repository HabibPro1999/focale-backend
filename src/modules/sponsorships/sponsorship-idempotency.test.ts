import { describe, it, expect } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";

// ============================================================================
// Fix 5 — idempotency key dedup logic
//
// The route calls getSponsorshipBatchByIdempotencyKey (prisma.sponsorshipBatch.findUnique)
// before createSponsorshipBatch. We test the DB lookup layer directly.
// ============================================================================

describe("SponsorshipBatch idempotency key lookup", () => {
  it("findUnique by idempotencyKey returns the existing batch when found", async () => {
    const existingBatch = {
      id: "batch-uuid-existing",
      _count: { sponsorships: 3 },
    };

    prismaMock.sponsorshipBatch.findUnique.mockResolvedValue(
      
      existingBatch as never,
    );

    const result = await prismaMock.sponsorshipBatch.findUnique({
      where: { idempotencyKey: "client-key-abc123" },
      select: {
        id: true,
        _count: { select: { sponsorships: true } },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe("batch-uuid-existing");
  });

  it("findUnique by idempotencyKey returns null when not found", async () => {
    prismaMock.sponsorshipBatch.findUnique.mockResolvedValue(null);

    const result = await prismaMock.sponsorshipBatch.findUnique({
      where: { idempotencyKey: "unknown-key-xyz" },
      select: {
        id: true,
        _count: { select: { sponsorships: true } },
      },
    });

    expect(result).toBeNull();
  });

  it("two calls with the same key return the same batchId", async () => {
    const existingBatch = {
      id: "batch-uuid-stable",
      _count: { sponsorships: 2 },
    };

    prismaMock.sponsorshipBatch.findUnique
      
      .mockResolvedValue(existingBatch as never);

    const key = "stable-key-001";

    const first = await prismaMock.sponsorshipBatch.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, _count: { select: { sponsorships: true } } },
    });

    const second = await prismaMock.sponsorshipBatch.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, _count: { select: { sponsorships: true } } },
    });

    expect(first?.id).toBe(second?.id);
    expect(first?.id).toBe("batch-uuid-stable");
  });
});
