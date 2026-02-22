import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestApp } from "../helpers/test-app.js";
import { prismaMock } from "../mocks/prisma.js";
import {
  createMockForm,
  createMockEvent,
  createMockRegistration,
} from "../helpers/factories.js";
import type { AppInstance } from "../../src/shared/fastify.js";
import { faker } from "@faker-js/faker";

// ============================================================================
// Module-level mocks (must be hoisted before imports)
// ============================================================================

vi.mock("@pricing", () => ({
  // Route exports (no-op async plugins — server.ts registers these)
  pricingRulesRoutes: vi.fn().mockResolvedValue(undefined),
  pricingPublicRoutes: vi.fn().mockResolvedValue(undefined),
  pricingPaymentConfigPublicRoutes: vi.fn().mockResolvedValue(undefined),
  // Service export
  calculatePrice: vi.fn().mockResolvedValue({
    basePrice: 300,
    appliedRules: [],
    calculatedBasePrice: 300,
    extras: [],
    extrasTotal: 0,
    subtotal: 300,
    sponsorships: [],
    sponsorshipTotal: 0,
    total: 300,
    currency: "TND",
  }),
}));

vi.mock("@email", () => ({
  // Route exports (no-op async plugins — server.ts registers these)
  emailRoutes: vi.fn().mockResolvedValue(undefined),
  emailWebhookRoutes: vi.fn().mockResolvedValue(undefined),
  // Service exports
  queueTriggeredEmail: vi.fn().mockResolvedValue(undefined),
  queueSponsorshipEmail: vi.fn().mockResolvedValue(undefined),
  processEmailQueue: vi.fn().mockResolvedValue(undefined),
  buildBatchEmailContext: vi.fn().mockResolvedValue(undefined),
  buildLinkedSponsorshipContext: vi.fn().mockResolvedValue(undefined),
}));

// Form data validator: return valid by default — individual tests override as needed
vi.mock("@shared/utils/form-data-validator.js", () => ({
  validateFormData: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}));

// Dependencies used by createRegistration service internally.
// Use importOriginal to preserve real implementations (getEventById, getFormById)
// which call through to prismaMock. Only stub out side-effectful helpers.
vi.mock("@events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@events")>();
  return {
    ...actual,
    incrementRegisteredCount: vi.fn().mockResolvedValue(undefined),
    decrementRegisteredCount: vi.fn().mockResolvedValue(undefined),
    incrementRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
    decrementRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
    // getEventById is NOT overridden: it calls through to prismaMock.event.findUnique
  };
});

vi.mock("@access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@access")>();
  return {
    ...actual,
    validateAccessSelections: vi
      .fn()
      .mockResolvedValue({ valid: true, errors: [] }),
    reserveAccessSpot: vi.fn().mockResolvedValue(undefined),
    releaseAccessSpot: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@sponsorships", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sponsorships")>();
  return {
    ...actual,
    cleanupSponsorshipsForRegistration: vi.fn().mockResolvedValue(undefined),
  };
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a unique remote IP per test to avoid rate-limit collisions.
 * The registration endpoint allows 5 requests per minute per IP.
 */
let _ipCounter = 1;
function nextTestIp(): string {
  return `10.0.0.${_ipCounter++}`;
}

/** Minimal valid request body matching CreateRegistrationSchema (minus formId). */
function buildValidBody(overrides: Record<string, unknown> = {}) {
  return {
    email: faker.internet.email(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    formData: {
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
    },
    ...overrides,
  };
}

/**
 * Build the enriched registration shape that createRegistration returns.
 * The service fetches back the registration with form + event includes,
 * then enrichWithAccessSelections appends accessSelections: [].
 */
function buildCreatedRegistrationMock(
  form: ReturnType<typeof createMockForm>,
  event: ReturnType<typeof createMockEvent>,
  email: string,
) {
  const reg = createMockRegistration({
    formId: form.id,
    eventId: event.id,
    email,
    priceBreakdown: {
      basePrice: 300,
      appliedRules: [],
      calculatedBasePrice: 300,
      accessItems: [],
      accessTotal: 0,
      subtotal: 300,
      sponsorships: [],
      sponsorshipTotal: 0,
      total: 300,
      currency: "TND",
    },
    editToken: faker.string.hexadecimal({ length: 64, prefix: "" }),
  });

  return {
    ...reg,
    form: { id: form.id, name: form.name },
    event: {
      id: event.id,
      name: event.name,
      slug: event.slug,
      clientId: event.clientId,
    },
    accessSelections: [],
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("POST /api/public/forms/:formId/register", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // --------------------------------------------------------------------------
  // 1. Happy path: valid form + open event → 201 with registration data
  // --------------------------------------------------------------------------
  it("returns 201 with registration and priceBreakdown on success", async () => {
    const form = createMockForm();
    const event = createMockEvent({ id: form.eventId, status: "OPEN" });
    const body = buildValidBody();
    const createdReg = buildCreatedRegistrationMock(
      form,
      event,
      body.email as string,
    );

    // getFormById (route level) and createRegistration's inner findOrThrow
    // both call prisma.form.findUnique — return form for both calls
    prismaMock.form.findUnique.mockResolvedValue(form);

    // getEventById (route level): prisma.event.findUnique with include: { pricing: true }
    // The mock returns the event with a pricing field (null is fine here)
    prismaMock.event.findUnique.mockResolvedValue({
      ...event,
      pricing: null,
    } as unknown as typeof event);

    // Duplicate email check inside createRegistration
    prismaMock.registration.findUnique
      // First call: idempotency key check (no key sent, so this won't be called
      // for idempotency — but the route only checks if idempotencyKey is present)
      // Second call: duplicate email check { where: { email_formId: {...} } }
      .mockResolvedValueOnce(null);

    // $transaction mock (globally set up in tests/mocks/prisma.ts) will call the
    // callback with prismaMock as tx. We set up tx-level calls via prismaMock:

    // tx.event.findUnique (re-check inside transaction)
    prismaMock.event.findUnique.mockResolvedValue({
      ...event,
      pricing: null,
    } as unknown as typeof event);

    // tx.registration.create
    prismaMock.registration.create.mockResolvedValue(
      createdReg as unknown as typeof createdReg,
    );

    // tx.registration.findUnique (fetch back with includes after create)
    prismaMock.registration.findUnique.mockResolvedValue(
      createdReg as unknown as typeof createdReg,
    );

    // tx.auditLog.create
    prismaMock.auditLog.create.mockResolvedValue({} as never);

    // enrichWithAccessSelections: priceBreakdown.accessItems is [] so no extra query

    const response = await app.inject({
      method: "POST",
      url: `/api/public/forms/${form.id}/register`,
      remoteAddress: nextTestIp(),
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    const responseBody = response.json();
    expect(responseBody).toHaveProperty("registration");
    expect(responseBody.registration.id).toBe(createdReg.id);
    expect(responseBody.registration.email).toBe(createdReg.email);
    expect(responseBody.registration.totalAmount).toBe(createdReg.totalAmount);
    expect(responseBody.registration.currency).toBe(createdReg.currency);
    expect(responseBody.registration.paymentStatus).toBe(
      createdReg.paymentStatus,
    );
    // Route maps editToken → token for frontend compatibility
    expect(responseBody.registration.token).toBe(createdReg.editToken);
  });

  // --------------------------------------------------------------------------
  // 2. Form not found → 404
  // --------------------------------------------------------------------------
  it("returns 404 when the formId does not exist", async () => {
    const nonExistentFormId = faker.string.uuid();

    // No idempotency key → idempotency check skipped
    // getFormById returns null
    prismaMock.form.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: `/api/public/forms/${nonExistentFormId}/register`,
      remoteAddress: nextTestIp(),
      payload: buildValidBody(),
    });

    expect(response.statusCode).toBe(404);
    const responseBody = response.json();
    expect(responseBody.message).toMatch(/not found/i);
  });

  // --------------------------------------------------------------------------
  // 3. Invalid body (missing required fields) → 400 Zod validation error
  // --------------------------------------------------------------------------
  it("returns 400 when email is missing from the request body", async () => {
    const form = createMockForm();

    const response = await app.inject({
      method: "POST",
      url: `/api/public/forms/${form.id}/register`,
      remoteAddress: nextTestIp(),
      payload: {
        // Missing required 'email' field
        firstName: faker.person.firstName(),
        formData: { firstName: "John" },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 when body is completely empty", async () => {
    const form = createMockForm();

    const response = await app.inject({
      method: "POST",
      url: `/api/public/forms/${form.id}/register`,
      remoteAddress: nextTestIp(),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  // --------------------------------------------------------------------------
  // 4. Event not open → 400 with appropriate error
  // --------------------------------------------------------------------------
  it("returns 400 when the event is not OPEN", async () => {
    const form = createMockForm();
    // Event exists but status is CLOSED (the factory default)
    const closedEvent = createMockEvent({ id: form.eventId, status: "CLOSED" });

    prismaMock.form.findUnique.mockResolvedValue(form);
    prismaMock.event.findUnique.mockResolvedValue({
      ...closedEvent,
      pricing: null,
    } as unknown as typeof closedEvent);

    const response = await app.inject({
      method: "POST",
      url: `/api/public/forms/${form.id}/register`,
      remoteAddress: nextTestIp(),
      payload: buildValidBody(),
    });

    expect(response.statusCode).toBe(400);
    const responseBody = response.json();
    expect(responseBody.message).toMatch(/not accepting registrations/i);
  });

  it("returns 400 when the event is ARCHIVED", async () => {
    const form = createMockForm();
    const archivedEvent = createMockEvent({
      id: form.eventId,
      status: "ARCHIVED",
    });

    prismaMock.form.findUnique.mockResolvedValue(form);
    prismaMock.event.findUnique.mockResolvedValue({
      ...archivedEvent,
      pricing: null,
    } as unknown as typeof archivedEvent);

    const response = await app.inject({
      method: "POST",
      url: `/api/public/forms/${form.id}/register`,
      remoteAddress: nextTestIp(),
      payload: buildValidBody(),
    });

    expect(response.statusCode).toBe(400);
    const responseBody = response.json();
    expect(responseBody.message).toMatch(/not accepting registrations/i);
  });

  // --------------------------------------------------------------------------
  // 5. Idempotency: existing registration with same idempotencyKey → 200
  // --------------------------------------------------------------------------
  it("returns 200 with existing registration when idempotencyKey matches", async () => {
    const idempotencyKey = faker.string.uuid();
    const form = createMockForm();
    const event = createMockEvent({ id: form.eventId, status: "OPEN" });
    const existingReg = createMockRegistration({
      formId: form.id,
      eventId: event.id,
      idempotencyKey,
      editToken: faker.string.hexadecimal({ length: 64, prefix: "" }),
      priceBreakdown: {
        basePrice: 300,
        appliedRules: [],
        calculatedBasePrice: 300,
        accessItems: [],
        accessTotal: 0,
        subtotal: 300,
        sponsorships: [],
        sponsorshipTotal: 0,
        total: 300,
        currency: "TND",
      },
    });

    // enrichWithAccessSelections queries prisma.eventAccess when accessItems is non-empty.
    // Our mock has empty accessItems so no extra query is needed.
    // getRegistrationByIdempotencyKey → prisma.registration.findUnique({ where: { idempotencyKey } })
    prismaMock.registration.findUnique.mockResolvedValue({
      ...existingReg,
      form: { id: form.id, name: form.name },
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        clientId: event.clientId,
      },
    } as unknown as typeof existingReg);

    const response = await app.inject({
      method: "POST",
      url: `/api/public/forms/${form.id}/register`,
      remoteAddress: nextTestIp(),
      payload: buildValidBody({ idempotencyKey }),
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json();
    expect(responseBody).toHaveProperty("registration");
    expect(responseBody.registration.id).toBe(existingReg.id);
    // Route maps editToken → token
    expect(responseBody.registration.token).toBe(existingReg.editToken);
  });
});
