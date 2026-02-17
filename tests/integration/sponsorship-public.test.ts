import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestApp } from "../helpers/test-app.js";
import type { AppInstance } from "../../src/shared/types/fastify.js";
import { prismaMock } from "../mocks/prisma.js";
import { createMockEvent, createMockForm } from "../helpers/factories.js";
import { faker } from "@faker-js/faker";

// ============================================================================
// Module Mocks (must be hoisted before imports)
// ============================================================================

vi.mock("@email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@email")>();
  return {
    ...actual,
    queueSponsorshipEmail: vi.fn().mockResolvedValue(true),
    buildBatchEmailContext: vi.fn().mockReturnValue({}),
    buildLinkedSponsorshipContext: vi.fn().mockReturnValue({}),
  };
});

vi.mock("@shared/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Mock the batch service to avoid deep Prisma call chain complexity.
// The route handler logic (event lookup, form lookup, status check) is still
// exercised via real code paths; only the final createSponsorshipBatch call is mocked.
vi.mock("@modules/sponsorships/sponsorships-batch.service.js", () => ({
  createSponsorshipBatch: vi.fn(),
}));

import { createSponsorshipBatch as _createSponsorshipBatch } from "@modules/sponsorships/sponsorships-batch.service.js";
const createSponsorshipBatch = vi.mocked(_createSponsorshipBatch);

// ============================================================================
// Helpers
// ============================================================================

/** Minimal valid CODE-mode payload with one beneficiary. */
function validBatchPayload(overrides: Record<string, unknown> = {}) {
  return {
    sponsor: {
      labName: "Acme Lab",
      contactName: "Dr. Contact",
      email: "contact@acmelab.com",
    },
    beneficiaries: [
      {
        name: "Dr. Beneficiary",
        email: "beneficiary@example.com",
        coversBasePrice: true,
        coveredAccessIds: [],
      },
    ],
    ...overrides,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("POST /api/public/events/:eventId/sponsorships", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // --------------------------------------------------------------------------
  // 1. Happy path — valid event + sponsor form → 201 + batchId + count
  // --------------------------------------------------------------------------
  it("returns 201 with batchId and count on valid CODE-mode submission", async () => {
    const eventId = faker.string.uuid();
    const batchId = faker.string.uuid();

    const mockEvent = createMockEvent({ id: eventId, status: "OPEN" });
    const mockForm = createMockForm({
      eventId,
      type: "SPONSOR",
      active: true,
    });

    // getEventById calls prisma.event.findUnique with include: { pricing: true }
    prismaMock.event.findUnique.mockResolvedValue({
      ...mockEvent,
      pricing: null,
    } as never);

    // getSponsorFormForEvent calls prisma.form.findFirst
    prismaMock.form.findFirst.mockResolvedValue({
      id: mockForm.id,
      eventId: mockForm.eventId,
      schema: mockForm.schema,
    } as never);

    // createSponsorshipBatch result
    createSponsorshipBatch.mockResolvedValue({ batchId, count: 1 });

    const response = await app.inject({
      method: "POST",
      url: `/api/public/events/${eventId}/sponsorships`,
      payload: validBatchPayload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.batchId).toBe(batchId);
    expect(body.count).toBe(1);
    expect(body.message).toContain("1 sponsoring(s) created successfully");
  });

  // --------------------------------------------------------------------------
  // 2. Event not found → 404
  // --------------------------------------------------------------------------
  it("returns 404 when event does not exist", async () => {
    const eventId = faker.string.uuid();

    prismaMock.event.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: `/api/public/events/${eventId}/sponsorships`,
      payload: validBatchPayload(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toMatch(/event not found/i);
  });

  // --------------------------------------------------------------------------
  // 3. Event not open (status !== "OPEN") → 400
  // --------------------------------------------------------------------------
  it("returns 400 when event status is not OPEN", async () => {
    const eventId = faker.string.uuid();
    const mockEvent = createMockEvent({ id: eventId, status: "CLOSED" });

    prismaMock.event.findUnique.mockResolvedValue({
      ...mockEvent,
      pricing: null,
    } as never);

    const response = await app.inject({
      method: "POST",
      url: `/api/public/events/${eventId}/sponsorships`,
      payload: validBatchPayload(),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.message).toMatch(/not accepting/i);
  });

  // --------------------------------------------------------------------------
  // 4. Invalid body (empty beneficiaries + missing sponsor info) → 400 (Zod)
  // --------------------------------------------------------------------------
  it("returns 400 when body fails Zod validation (empty beneficiaries, missing sponsor)", async () => {
    const eventId = faker.string.uuid();

    // No prisma mocks needed — Zod validation fires before route handler runs
    const response = await app.inject({
      method: "POST",
      url: `/api/public/events/${eventId}/sponsorships`,
      payload: {
        // Missing required sponsor fields, empty beneficiaries array
        sponsor: {},
        beneficiaries: [],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  // --------------------------------------------------------------------------
  // 5. Sponsor form not found for event → 404
  // --------------------------------------------------------------------------
  it("returns 404 when sponsor form does not exist for the event", async () => {
    const eventId = faker.string.uuid();
    const mockEvent = createMockEvent({ id: eventId, status: "OPEN" });

    prismaMock.event.findUnique.mockResolvedValue({
      ...mockEvent,
      pricing: null,
    } as never);

    // No active SPONSOR form found
    prismaMock.form.findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: `/api/public/events/${eventId}/sponsorships`,
      payload: validBatchPayload(),
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.message).toMatch(/sponsor form not found/i);
  });
});
