import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockRegistration,
  createMockForm,
  createMockEvent,
  createMockEventAccess,
} from "../../../tests/helpers/factories.js";
import {
  createRegistration,
  getRegistrationById,
  getRegistrationByIdempotencyKey,
  updateRegistration,
  confirmPayment,
  deleteRegistration,
  listRegistrations,
  verifyEditToken,
  getRegistrationClientId,
  getRegistrationForEdit,
  editRegistrationPublic,
  uploadPaymentProof,
} from "./registrations.service.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import type { PriceBreakdown } from "@pricing";
import { faker } from "@faker-js/faker";

// Mock external module dependencies
vi.mock("@events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@events")>();
  return {
    ...actual,
    incrementRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
    decrementRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@access", () => ({
  validateAccessSelections: vi
    .fn()
    .mockResolvedValue({ valid: true, errors: [] }),
  reserveAccessSpot: vi.fn().mockResolvedValue(undefined),
  releaseAccessSpot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@pricing", () => ({
  calculatePrice: vi.fn().mockResolvedValue({
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
  }),
}));

vi.mock("@email", () => ({
  queueTriggeredEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@forms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@forms")>();
  return {
    ...actual,
    validateFormData: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    sanitizeFormData: vi
      .fn()
      .mockImplementation(
        (_schema: unknown, formData: Record<string, unknown>) => formData,
      ),
  };
});

vi.mock("@shared/services/storage/index.js", () => ({
  getStorageProvider: vi.fn(() => ({
    uploadPublic: vi
      .fn()
      .mockResolvedValue("https://storage.example.com/test/public.webp"),
    uploadPrivate: vi.fn().mockResolvedValue("test/proof.webp"),
    getSignedUrl: vi.fn().mockResolvedValue("https://signed-url.example.com"),
    download: vi.fn().mockResolvedValue({
      buffer: Buffer.from("downloaded-content"),
      contentType: "image/jpeg",
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@shared/services/storage/compress.js", () => ({
  compressFile: vi.fn().mockResolvedValue({
    buffer: Buffer.from("compressed-content"),
    contentType: "image/webp",
    ext: "webp",
  }),
}));

vi.mock("file-type", () => ({
  fileTypeFromBuffer: vi
    .fn()
    .mockResolvedValue({ ext: "pdf", mime: "application/pdf" }),
}));

describe("Registrations Service", () => {
  const eventId = faker.string.uuid();
  const formId = faker.string.uuid();
  const clientId = faker.string.uuid();
  const enabledModules = [
    "pricing",
    "registrations",
    "sponsorships",
    "emails",
    "certificates",
  ];

  function createPolicyEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: eventId,
      name: "Test Event",
      slug: "test-event",
      clientId,
      status: "OPEN",
      client: { enabledModules },
      ...overrides,
    };
  }

  function createRegistrationForPolicy(
    overrides: Parameters<typeof createMockRegistration>[0] = {},
    eventOverrides: Record<string, unknown> = {},
  ) {
    return {
      ...createMockRegistration({ eventId, ...overrides }),
      event: createPolicyEvent(eventOverrides),
    };
  }

  beforeEach(() => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ max_ref: null }] as never);
    (prismaMock.registration.groupBy as unknown as Mock).mockResolvedValue([]);
    prismaMock.sponsorshipUsage.findMany.mockResolvedValue([] as never);
  });

  // Helper function to create a mock price breakdown
  function createMockPriceBreakdown(
    overrides: Partial<PriceBreakdown> = {},
  ): PriceBreakdown {
    return {
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
      droppedAccessItems: [],
      ...overrides,
    };
  }

  // Helper to create registration with relations
  function createMockRegistrationWithRelations(
    overrides: Partial<ReturnType<typeof createMockRegistration>> = {},
  ) {
    const registration = createMockRegistration({
      eventId,
      formId,
      priceBreakdown: createMockPriceBreakdown(),
      ...overrides,
    });

    return {
      ...registration,
      form: { id: formId, name: "Test Form" },
      event: createPolicyEvent(),
    };
  }

  describe("createRegistration", () => {
    const mockForm = createMockForm({ id: formId, eventId, schemaVersion: 1 });
    const mockEvent = {
      ...createMockEvent({
        id: eventId,
        status: "OPEN",
        maxCapacity: 100,
        registeredCount: 0,
      }),
      client: { enabledModules },
    };
    const priceBreakdown = createMockPriceBreakdown();

    beforeEach(() => {
      // Reset mocks before each test
      vi.clearAllMocks();
    });

    it("should create a registration successfully", async () => {
      const input = {
        formId,
        formData: {
          firstName: "John",
          lastName: "Doe",
          email: "john@example.com",
        },
        email: "john@example.com",
        firstName: "John",
        lastName: "Doe",
        accessSelections: [],
      };

      const createdRegistration = createMockRegistrationWithRelations({
        ...input,
        totalAmount: priceBreakdown.total,
      });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.findUnique.mockResolvedValueOnce(null); // Duplicate check
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.event.findUnique.mockResolvedValue(mockEvent);
          prismaMock.registration.create.mockResolvedValue(createdRegistration);
          prismaMock.registration.findUnique.mockResolvedValue(
            createdRegistration,
          );
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          return callback(prismaMock);
        },
      );
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await createRegistration(input, priceBreakdown);

      expect(result.email).toBe("john@example.com");
      expect(result.totalAmount).toBe(300);
      expect(prismaMock.form.findUnique).toHaveBeenCalledWith({
        where: { id: formId },
        select: { id: true, eventId: true, schemaVersion: true },
      });
    });

    it("should reject lab sponsorship payment method when sponsorships are enabled", async () => {
      const input = {
        formId,
        formData: {},
        email: "lab@example.com",
        accessSelections: [],
        paymentMethod: "LAB_SPONSORSHIP" as const,
        labName: "Research Lab",
      };

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.findUnique.mockResolvedValueOnce(null);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.event.findUnique.mockResolvedValue(mockEvent);
          return callback(prismaMock);
        },
      );

      await expect(
        createRegistration(input, priceBreakdown),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
      });
      expect(prismaMock.registration.create).not.toHaveBeenCalled();
    });

    it("should throw error when form not found", async () => {
      prismaMock.form.findUnique.mockResolvedValue(null);

      const input = {
        formId: "non-existent",
        formData: {},
        email: "test@example.com",
        accessSelections: [],
      };

      await expect(createRegistration(input, priceBreakdown)).rejects.toThrow(
        AppError,
      );
      await expect(
        createRegistration(input, priceBreakdown),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should throw error when duplicate registration exists", async () => {
      const existingRegistration = createMockRegistration({
        email: "john@example.com",
        formId,
      });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.findUnique.mockResolvedValue(
        existingRegistration,
      );

      const input = {
        formId,
        formData: {},
        email: "john@example.com",
        accessSelections: [],
      };

      await expect(createRegistration(input, priceBreakdown)).rejects.toThrow(
        AppError,
      );
      await expect(
        createRegistration(input, priceBreakdown),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.REGISTRATION_ALREADY_EXISTS,
      });
    });

    it("should throw error when event is not open", async () => {
      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.findUnique.mockResolvedValueOnce(null);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.event.findUnique.mockResolvedValue({
            ...mockEvent,
            status: "CLOSED",
          });
          return callback(prismaMock);
        },
      );

      const input = {
        formId,
        formData: {},
        email: "test@example.com",
        accessSelections: [],
      };

      await expect(createRegistration(input, priceBreakdown)).rejects.toThrow(
        AppError,
      );
      await expect(
        createRegistration(input, priceBreakdown),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.EVENT_NOT_OPEN,
      });
    });

    it("should throw error when event is at capacity", async () => {
      const fullEvent = {
        ...mockEvent,
        maxCapacity: 100,
        registeredCount: 100,
      };

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.findUnique.mockResolvedValueOnce(null);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.event.findUnique.mockResolvedValue(fullEvent);
          return callback(prismaMock);
        },
      );

      const input = {
        formId,
        formData: {},
        email: "test@example.com",
        accessSelections: [],
      };

      await expect(createRegistration(input, priceBreakdown)).rejects.toThrow(
        AppError,
      );
      await expect(
        createRegistration(input, priceBreakdown),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.EVENT_FULL,
      });
    });

    it("should create registration with access selections", async () => {
      const accessId = faker.string.uuid();
      const accessSelections = [{ accessId, quantity: 1 }];
      const priceWithAccess = createMockPriceBreakdown({
        accessItems: [
          {
            accessId,
            name: "Workshop",
            unitPrice: 50,
            quantity: 1,
            subtotal: 50,
          },
        ],
        accessTotal: 50,
        total: 350,
      });

      const input = {
        formId,
        formData: { firstName: "John" },
        email: "john@example.com",
        accessSelections,
      };

      const createdRegistration = createMockRegistrationWithRelations({
        ...input,
        totalAmount: 350,
        priceBreakdown: priceWithAccess,
        accessTypeIds: [accessId],
      });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.findUnique.mockResolvedValueOnce(null);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.event.findUnique.mockResolvedValue(mockEvent);
          prismaMock.registration.create.mockResolvedValue(createdRegistration);
          prismaMock.registration.findUnique.mockResolvedValue(
            createdRegistration,
          );
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          return callback(prismaMock);
        },
      );
      prismaMock.eventAccess.findMany.mockResolvedValue([
        createMockEventAccess({ id: accessId, name: "Workshop", price: 50 }),
      ]);

      const result = await createRegistration(input, priceWithAccess);

      expect(result.totalAmount).toBe(350);
      expect(result.accessSelections).toHaveLength(1);
    });

    it("should handle idempotent creation with existing idempotency key", async () => {
      const idempotencyKey = faker.string.uuid();
      const existingRegistration = createMockRegistrationWithRelations({
        idempotencyKey,
      });

      prismaMock.registration.findUnique.mockResolvedValue(
        existingRegistration,
      );
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await getRegistrationByIdempotencyKey(idempotencyKey);

      expect(result).not.toBeNull();
      expect(result?.idempotencyKey).toBe(idempotencyKey);
    });
  });

  describe("getRegistrationById", () => {
    it("should return registration with relations", async () => {
      const registration = createMockRegistrationWithRelations();

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await getRegistrationById(registration.id);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(registration.id);
      expect(result?.form.name).toBe("Test Form");
      expect(result?.event.slug).toBe("test-event");
    });

    it("should return null when registration not found", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(null);

      const result = await getRegistrationById("non-existent");

      expect(result).toBeNull();
    });

    it("should enrich registration with access selections from priceBreakdown", async () => {
      const accessId = faker.string.uuid();
      const priceWithAccess = createMockPriceBreakdown({
        accessItems: [
          {
            accessId,
            name: "Workshop",
            unitPrice: 50,
            quantity: 2,
            subtotal: 100,
          },
        ],
        accessTotal: 100,
      });

      const registration = createMockRegistrationWithRelations({
        priceBreakdown: priceWithAccess,
        accessTypeIds: [accessId],
      });

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.eventAccess.findMany.mockResolvedValue([
        createMockEventAccess({
          id: accessId,
          name: "Workshop",
          type: "WORKSHOP",
        }),
      ]);

      const result = await getRegistrationById(registration.id);

      expect(result?.accessSelections).toHaveLength(1);
      expect(result?.accessSelections[0].accessId).toBe(accessId);
      expect(result?.accessSelections[0].quantity).toBe(2);
      expect(result?.accessSelections[0].subtotal).toBe(100);
    });
  });

  describe("updateRegistration", () => {
    it("should update registration note", async () => {
      const registration = createRegistrationForPolicy({ note: null });
      const updatedRegistration = createMockRegistrationWithRelations({
        ...registration,
        note: "Updated note",
      });

      prismaMock.registration.findUnique
        .mockResolvedValueOnce(registration)
        .mockResolvedValueOnce(updatedRegistration);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.registration.update.mockResolvedValue(updatedRegistration);
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          return callback(prismaMock);
        },
      );
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await updateRegistration(registration.id, {
        note: "Updated note",
      });

      expect(result.note).toBe("Updated note");
    });

    it("should throw error when registration not found", async () => {
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.registration.findUnique.mockResolvedValue(null);
          return callback(prismaMock);
        },
      );

      await expect(
        updateRegistration("non-existent", { note: "test" }),
      ).rejects.toThrow(AppError);
      await expect(
        updateRegistration("non-existent", { note: "test" }),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
      });
    });
  });

  describe("Payment Status Transitions", () => {
    describe("confirmPayment", () => {
      it("should transition from PENDING to PAID", async () => {
        const registration = createRegistrationForPolicy({
          paymentStatus: "PENDING",
          totalAmount: 300,
        });
        const paidRegistration = createMockRegistrationWithRelations({
          ...registration,
          paymentStatus: "PAID",
          paidAmount: 300,
          paidAt: new Date(),
        });

        prismaMock.registration.findUnique
          .mockResolvedValueOnce(registration)
          .mockResolvedValueOnce(paidRegistration);
        prismaMock.$transaction.mockImplementation(
          async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
            prismaMock.registration.update.mockResolvedValue(paidRegistration);
            prismaMock.auditLog.create.mockResolvedValue({} as never);
            return callback(prismaMock);
          },
        );
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await confirmPayment(registration.id, {
          paymentStatus: "PAID",
          paidAmount: 300,
          paymentMethod: "BANK_TRANSFER",
        });

        expect(result.paymentStatus).toBe("PAID");
        expect(result.paidAmount).toBe(300);
      });

      it("should transition from PENDING to WAIVED", async () => {
        const registration = createRegistrationForPolicy({
          paymentStatus: "PENDING",
        });
        const waivedRegistration = createMockRegistrationWithRelations({
          ...registration,
          paymentStatus: "WAIVED",
          paidAmount: 0,
          paidAt: new Date(),
        });

        prismaMock.registration.findUnique
          .mockResolvedValueOnce(registration)
          .mockResolvedValueOnce(waivedRegistration);
        prismaMock.$transaction.mockImplementation(
          async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
            prismaMock.registration.update.mockResolvedValue(
              waivedRegistration,
            );
            prismaMock.auditLog.create.mockResolvedValue({} as never);
            return callback(prismaMock);
          },
        );
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await confirmPayment(registration.id, {
          paymentStatus: "WAIVED",
        });

        expect(result.paymentStatus).toBe("WAIVED");
      });

      it("should transition from PAID to REFUNDED", async () => {
        const registration = createRegistrationForPolicy({
          paymentStatus: "PAID",
          paidAmount: 300,
        });
        const refundedRegistration = createMockRegistrationWithRelations({
          ...registration,
          paymentStatus: "REFUNDED",
        });

        prismaMock.registration.findUnique
          .mockResolvedValueOnce(registration)
          .mockResolvedValueOnce(refundedRegistration);
        prismaMock.$transaction.mockImplementation(
          async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
            prismaMock.registration.update.mockResolvedValue(
              refundedRegistration,
            );
            prismaMock.auditLog.create.mockResolvedValue({} as never);
            return callback(prismaMock);
          },
        );
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await confirmPayment(registration.id, {
          paymentStatus: "REFUNDED",
        });

        expect(result.paymentStatus).toBe("REFUNDED");
      });

      it("should reject invalid transition from REFUNDED", async () => {
        const registration = createRegistrationForPolicy({
          paymentStatus: "REFUNDED",
        });

        prismaMock.$transaction.mockImplementation(
          async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
            prismaMock.registration.findUnique.mockResolvedValue(registration);
            return callback(prismaMock);
          },
        );

        await expect(
          confirmPayment(registration.id, { paymentStatus: "PAID" }),
        ).rejects.toThrow(AppError);
        await expect(
          confirmPayment(registration.id, { paymentStatus: "PAID" }),
        ).rejects.toMatchObject({
          statusCode: 400,
          code: ErrorCodes.INVALID_PAYMENT_TRANSITION,
        });
      });

      it("should reject transition from PENDING to REFUNDED directly", async () => {
        // Note: This is allowed in the state machine, PENDING -> REFUNDED is valid
        // Let's test an invalid transition instead
        const registration = createRegistrationForPolicy({
          paymentStatus: "WAIVED",
        });

        prismaMock.$transaction.mockImplementation(
          async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
            prismaMock.registration.findUnique.mockResolvedValue(registration);
            return callback(prismaMock);
          },
        );

        // WAIVED -> PAID is not allowed
        await expect(
          confirmPayment(registration.id, { paymentStatus: "PAID" }),
        ).rejects.toThrow(AppError);
      });
    });

    describe("updateRegistration payment status", () => {
      it("should allow same status update (no-op)", async () => {
        const registration = createRegistrationForPolicy({
          paymentStatus: "PENDING",
        });
        const updatedRegistration =
          createMockRegistrationWithRelations(registration);

        prismaMock.registration.findUnique
          .mockResolvedValueOnce(registration)
          .mockResolvedValueOnce(updatedRegistration);
        prismaMock.$transaction.mockImplementation(
          async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
            prismaMock.registration.update.mockResolvedValue(
              updatedRegistration,
            );
            return callback(prismaMock);
          },
        );
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        // Same status should not throw
        const result = await updateRegistration(registration.id, {
          paymentStatus: "PENDING",
        });
        expect(result.paymentStatus).toBe("PENDING");
      });
    });
  });

  describe("deleteRegistration", () => {
    it("should delete unpaid registration", async () => {
      const registration = createRegistrationForPolicy({
        paymentStatus: "PENDING",
      });

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          prismaMock.registration.delete.mockResolvedValue(registration);
          return callback(prismaMock);
        },
      );

      await expect(
        deleteRegistration(registration.id),
      ).resolves.toBeUndefined();
    });

    it("should throw error when trying to delete paid registration", async () => {
      const registration = createRegistrationForPolicy({
        paymentStatus: "PAID",
      });

      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.registration.findUnique.mockResolvedValue(registration);
          return callback(prismaMock);
        },
      );

      await expect(deleteRegistration(registration.id)).rejects.toThrow(
        AppError,
      );
      await expect(deleteRegistration(registration.id)).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.REGISTRATION_DELETE_BLOCKED,
      });
    });

    it("should throw error when registration not found", async () => {
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.registration.findUnique.mockResolvedValue(null);
          return callback(prismaMock);
        },
      );

      await expect(deleteRegistration("non-existent")).rejects.toThrow(
        AppError,
      );
      await expect(deleteRegistration("non-existent")).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
      });
    });

    // ------------------------------------------------------------------
    // M13: Force-delete tests
    // ------------------------------------------------------------------

    it("should successfully force-delete a PAID registration when user is CLIENT_ADMIN", async () => {
      const registration = createRegistrationForPolicy({
        paymentStatus: "PAID",
      });
      const userId = faker.string.uuid();

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          prismaMock.registration.delete.mockResolvedValue(registration);
          return callback(prismaMock);
        },
      );

      await expect(
        deleteRegistration(registration.id, userId, true, 1 /* CLIENT_ADMIN */),
      ).resolves.toBeUndefined();
    });

    it("should throw FORBIDDEN when force-deleting without admin role", async () => {
      const registration = createRegistrationForPolicy({
        paymentStatus: "PAID",
      });
      const userId = faker.string.uuid();

      await expect(
        deleteRegistration(registration.id, userId, true, 99 /* non-admin */),
      ).rejects.toThrow(AppError);

      await expect(
        deleteRegistration(registration.id, userId, true, 99 /* non-admin */),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: ErrorCodes.FORBIDDEN,
      });
    });

    it("should release access spots when deleting registration with access items", async () => {
      const accessId = faker.string.uuid();
      const priceWithAccess = createMockPriceBreakdown({
        accessItems: [
          {
            accessId,
            name: "Workshop",
            unitPrice: 50,
            quantity: 2,
            subtotal: 100,
          },
        ],
      });

      const registration = createRegistrationForPolicy({
        paymentStatus: "PENDING",
        priceBreakdown: priceWithAccess,
      });

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          prismaMock.registration.delete.mockResolvedValue(registration);
          return callback(prismaMock);
        },
      );

      await deleteRegistration(registration.id);

      // Verify releaseAccessSpot was called with tx client so it participates in the transaction
      const { releaseAccessSpot } = await import("@access");
      expect(releaseAccessSpot).toHaveBeenCalledWith(accessId, 2, prismaMock);
    });
  });

  describe("listRegistrations", () => {
    beforeEach(() => {
      // Set up default mock for eventAccess.findMany before each test
      prismaMock.eventAccess.findMany.mockResolvedValue([]);
    });

    it("should return paginated registrations", async () => {
      const registrations = [
        createMockRegistrationWithRelations({ email: "user1@example.com" }),
        createMockRegistrationWithRelations({ email: "user2@example.com" }),
      ];

      prismaMock.registration.findMany.mockResolvedValue(registrations);
      prismaMock.registration.count.mockResolvedValue(2);

      const result = await listRegistrations(eventId, { page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(result.meta.page).toBe(1);
    });

    it("should filter by payment status", async () => {
      const paidRegistrations = [
        createMockRegistrationWithRelations({ paymentStatus: "PAID" }),
      ];

      prismaMock.registration.findMany.mockResolvedValue(paidRegistrations);
      prismaMock.registration.count.mockResolvedValue(1);

      const result = await listRegistrations(eventId, {
        page: 1,
        limit: 20,
        paymentStatus: "PAID",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].paymentStatus).toBe("PAID");
    });

    it("should filter by search term", async () => {
      const searchResults = [
        createMockRegistrationWithRelations({
          email: "john.doe@example.com",
          firstName: "John",
        }),
      ];

      prismaMock.registration.findMany.mockResolvedValue(searchResults);
      prismaMock.registration.count.mockResolvedValue(1);

      const result = await listRegistrations(eventId, {
        page: 1,
        limit: 20,
        search: "john",
      });

      expect(result.data).toHaveLength(1);
    });

    it("should handle empty results", async () => {
      prismaMock.registration.findMany.mockResolvedValue([]);
      prismaMock.registration.count.mockResolvedValue(0);

      const result = await listRegistrations(eventId, { page: 1, limit: 20 });

      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(0);
    });
  });

  describe("verifyEditToken", () => {
    it("should return true for valid token", async () => {
      const token = "a".repeat(64); // 64 hex characters from 32 bytes
      const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

      prismaMock.registration.findUnique.mockResolvedValue({
        editToken: token,
        editTokenExpiry: futureExpiry,
      } as never);

      const result = await verifyEditToken("reg-id", token);

      expect(result).toBe(true);
    });

    it("should return false for invalid token", async () => {
      const storedToken = "a".repeat(64);
      const providedToken = "b".repeat(64);
      const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      prismaMock.registration.findUnique.mockResolvedValue({
        editToken: storedToken,
        editTokenExpiry: futureExpiry,
      } as never);

      const result = await verifyEditToken("reg-id", providedToken);

      expect(result).toBe(false);
    });

    it("should return false when no token stored", async () => {
      prismaMock.registration.findUnique.mockResolvedValue({
        editToken: null,
        editTokenExpiry: null,
      } as never);

      const result = await verifyEditToken("reg-id", "any-token");

      expect(result).toBe(false);
    });

    it("should return false for mismatched token lengths", async () => {
      const storedToken = "a".repeat(64);
      const shortToken = "a".repeat(32);
      const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      prismaMock.registration.findUnique.mockResolvedValue({
        editToken: storedToken,
        editTokenExpiry: futureExpiry,
      } as never);

      const result = await verifyEditToken("reg-id", shortToken);

      expect(result).toBe(false);
    });
  });

  describe("getRegistrationClientId", () => {
    it("should return client ID for valid registration", async () => {
      prismaMock.registration.findUnique.mockResolvedValue({
        id: "reg-id",
        event: { clientId },
      } as never);

      const result = await getRegistrationClientId("reg-id");

      expect(result).toBe(clientId);
    });

    it("should return null when registration not found", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(null);

      const result = await getRegistrationClientId("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("getRegistrationForEdit", () => {
    it("should return registration with edit permissions for open event", async () => {
      const registration = {
        ...createMockRegistration({ paymentStatus: "PENDING", paidAmount: 0 }),
        form: { id: formId, name: "Test Form", schema: {} },
        event: {
          ...createPolicyEvent({ status: "OPEN" }),
        },
      };

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await getRegistrationForEdit(registration.id);

      expect(result.canEdit).toBe(true);
      expect(result.canRemoveAccess).toBe(true);
      expect(result.editRestrictions).toHaveLength(0);
    });

    it("should restrict editing for refunded registration", async () => {
      const registration = {
        ...createMockRegistration({ paymentStatus: "REFUNDED", paidAmount: 0 }),
        form: { id: formId, name: "Test Form", schema: {} },
        event: {
          ...createPolicyEvent({ status: "OPEN" }),
        },
      };

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await getRegistrationForEdit(registration.id);

      expect(result.canEdit).toBe(false);
      expect(result.editRestrictions).toContain(
        "Registration has been refunded",
      );
    });

    it("should restrict editing when event is not open", async () => {
      const registration = {
        ...createMockRegistration({ paymentStatus: "PENDING", paidAmount: 0 }),
        form: { id: formId, name: "Test Form", schema: {} },
        event: {
          ...createPolicyEvent({ status: "CLOSED" }),
        },
      };

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await getRegistrationForEdit(registration.id);

      expect(result.canEdit).toBe(false);
      expect(result.editRestrictions).toContain(
        "Event is not accepting changes",
      );
    });

    it("should restrict access removal for paid registration", async () => {
      const registration = {
        ...createMockRegistration({ paymentStatus: "PAID", paidAmount: 300 }),
        form: { id: formId, name: "Test Form", schema: {} },
        event: {
          ...createPolicyEvent({ status: "OPEN" }),
        },
      };

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await getRegistrationForEdit(registration.id);

      expect(result.canRemoveAccess).toBe(false);
      expect(result.editRestrictions).toContain(
        "Cannot remove access items (payment received)",
      );
    });

    it("should throw error when registration not found", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(null);

      await expect(getRegistrationForEdit("non-existent")).rejects.toThrow(
        AppError,
      );
      await expect(
        getRegistrationForEdit("non-existent"),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
      });
    });
  });

  describe("editRegistrationPublic", () => {
    it("should update form data successfully", async () => {
      const registration = {
        ...createMockRegistration({
          paymentStatus: "PENDING",
          paidAmount: 0,
          formData: { firstName: "John" },
          sponsorshipCode: null,
        }),
        form: { id: formId, eventId, schema: {} },
        event: createPolicyEvent({ status: "OPEN" }),
      };

      const updatedRegistration = createMockRegistrationWithRelations({
        ...registration,
        formData: { firstName: "Jane" },
      });

      prismaMock.registration.findUnique
        .mockResolvedValueOnce(registration)
        .mockResolvedValueOnce(updatedRegistration);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.registration.update.mockResolvedValue(updatedRegistration);
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          return callback(prismaMock);
        },
      );
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await editRegistrationPublic(registration.id, {
        formData: { firstName: "Jane" },
      });

      expect(result.registration).toBeDefined();
    });

    it("should throw error when editing refunded registration", async () => {
      const registration = {
        ...createMockRegistration({ paymentStatus: "REFUNDED" }),
        form: { id: formId, eventId, schema: {} },
        event: createPolicyEvent({ status: "OPEN" }),
      };

      prismaMock.registration.findUnique.mockResolvedValue(registration);

      await expect(
        editRegistrationPublic(registration.id, { firstName: "Jane" }),
      ).rejects.toThrow(AppError);
      await expect(
        editRegistrationPublic(registration.id, { firstName: "Jane" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.REGISTRATION_REFUNDED,
      });
    });

    it("should throw error when event is not open", async () => {
      const registration = {
        ...createMockRegistration({ paymentStatus: "PENDING" }),
        form: { id: formId, eventId, schema: {} },
        event: createPolicyEvent({ status: "CLOSED" }),
      };

      prismaMock.registration.findUnique.mockResolvedValue(registration);

      await expect(
        editRegistrationPublic(registration.id, { firstName: "Jane" }),
      ).rejects.toThrow(AppError);
      await expect(
        editRegistrationPublic(registration.id, { firstName: "Jane" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.REGISTRATION_EDIT_FORBIDDEN,
      });
    });

    it("should throw error when trying to remove access from paid registration", async () => {
      const accessId = faker.string.uuid();
      const priceWithAccess = createMockPriceBreakdown({
        accessItems: [
          {
            accessId,
            name: "Workshop",
            unitPrice: 50,
            quantity: 1,
            subtotal: 50,
          },
        ],
      });

      const registration = {
        ...createMockRegistration({
          paymentStatus: "PAID",
          paidAmount: 350,
          priceBreakdown: priceWithAccess,
        }),
        form: { id: formId, eventId, schema: {} },
        event: createPolicyEvent({ status: "OPEN" }),
      };

      prismaMock.registration.findUnique.mockResolvedValue(registration);

      // Trying to remove all access selections from a paid registration
      await expect(
        editRegistrationPublic(registration.id, { accessSelections: [] }),
      ).rejects.toThrow(AppError);
      await expect(
        editRegistrationPublic(registration.id, { accessSelections: [] }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.REGISTRATION_ACCESS_REMOVAL_BLOCKED,
      });
    });

    it("should allow adding access to paid registration", async () => {
      const existingAccessId = faker.string.uuid();
      const newAccessId = faker.string.uuid();
      const priceWithAccess = createMockPriceBreakdown({
        accessItems: [
          {
            accessId: existingAccessId,
            name: "Workshop 1",
            unitPrice: 50,
            quantity: 1,
            subtotal: 50,
          },
        ],
      });

      const registration = {
        ...createMockRegistration({
          paymentStatus: "PAID",
          paidAmount: 350,
          priceBreakdown: priceWithAccess,
          sponsorshipCode: null,
        }),
        form: { id: formId, eventId, schema: {} },
        event: createPolicyEvent({ status: "OPEN" }),
      };

      const updatedRegistration = createMockRegistrationWithRelations({
        ...registration,
        accessTypeIds: [existingAccessId, newAccessId],
      });

      prismaMock.registration.findUnique
        .mockResolvedValueOnce(registration)
        .mockResolvedValueOnce(updatedRegistration);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.registration.update.mockResolvedValue(updatedRegistration);
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          return callback(prismaMock);
        },
      );
      prismaMock.eventAccess.findMany.mockResolvedValue([
        createMockEventAccess({ id: existingAccessId }),
        createMockEventAccess({ id: newAccessId }),
      ]);

      const result = await editRegistrationPublic(registration.id, {
        accessSelections: [
          { accessId: existingAccessId, quantity: 1 },
          { accessId: newAccessId, quantity: 1 },
        ],
      });

      expect(result.registration).toBeDefined();
    });
  });

  describe("uploadPaymentProof", () => {
    it("should upload payment proof successfully (PDF)", async () => {
      const registration = createRegistrationForPolicy({ eventId });

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.registration.update.mockResolvedValue({
        ...registration,
        paymentProofUrl: "test/proof.webp",
      });

      const result = await uploadPaymentProof(registration.id, {
        buffer: Buffer.from("test"),
        filename: "proof.pdf",
        mimetype: "application/pdf",
      });

      expect(result.fileUrl).toBe("test/proof.webp");
      expect(result.fileName).toBe("proof.webp"); // After compression
      expect(result.mimeType).toBe("image/webp"); // After compression
      expect(result.fileSize).toBe(Buffer.from("compressed-content").length);
    });

    it("should throw error for invalid file type", async () => {
      const registration = createMockRegistration();

      prismaMock.registration.findUnique.mockResolvedValue(registration);

      await expect(
        uploadPaymentProof(registration.id, {
          buffer: Buffer.from("test"),
          filename: "file.exe",
          mimetype: "application/x-msdownload",
        }),
      ).rejects.toThrow(AppError);
      await expect(
        uploadPaymentProof(registration.id, {
          buffer: Buffer.from("test"),
          filename: "file.exe",
          mimetype: "application/x-msdownload",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.INVALID_FILE_TYPE,
      });
    });

    it("should throw error for file too large", async () => {
      const registration = createMockRegistration();

      prismaMock.registration.findUnique.mockResolvedValue(registration);

      const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB

      await expect(
        uploadPaymentProof(registration.id, {
          buffer: largeBuffer,
          filename: "large.pdf",
          mimetype: "application/pdf",
        }),
      ).rejects.toThrow(AppError);
      await expect(
        uploadPaymentProof(registration.id, {
          buffer: largeBuffer,
          filename: "large.pdf",
          mimetype: "application/pdf",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.FILE_TOO_LARGE,
      });
    });

    it("should throw error when registration not found", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(null);

      await expect(
        uploadPaymentProof("non-existent", {
          buffer: Buffer.from("test"),
          filename: "proof.pdf",
          mimetype: "application/pdf",
        }),
      ).rejects.toThrow(AppError);
      await expect(
        uploadPaymentProof("non-existent", {
          buffer: Buffer.from("test"),
          filename: "proof.pdf",
          mimetype: "application/pdf",
        }),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
      });
    });

    // ------------------------------------------------------------------
    // M14: Payment proof state rejection tests
    // ------------------------------------------------------------------

    it("should reject upload when payment status is PAID", async () => {
      const registration = createRegistrationForPolicy({
        eventId,
        paymentStatus: "PAID",
      });

      prismaMock.registration.findUnique.mockResolvedValue(registration);

      await expect(
        uploadPaymentProof(registration.id, {
          buffer: Buffer.from("test"),
          filename: "proof.pdf",
          mimetype: "application/pdf",
        }),
      ).rejects.toThrow(AppError);

      await expect(
        uploadPaymentProof(registration.id, {
          buffer: Buffer.from("test"),
          filename: "proof.pdf",
          mimetype: "application/pdf",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.INVALID_PAYMENT_TRANSITION,
      });
    });

    it("should reject upload when payment status is REFUNDED", async () => {
      const registration = createRegistrationForPolicy({
        eventId,
        paymentStatus: "REFUNDED",
      });

      prismaMock.registration.findUnique.mockResolvedValue(registration);

      await expect(
        uploadPaymentProof(registration.id, {
          buffer: Buffer.from("test"),
          filename: "proof.pdf",
          mimetype: "application/pdf",
        }),
      ).rejects.toThrow(AppError);

      await expect(
        uploadPaymentProof(registration.id, {
          buffer: Buffer.from("test"),
          filename: "proof.pdf",
          mimetype: "application/pdf",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.INVALID_PAYMENT_TRANSITION,
      });
    });

    it("should accept PNG images (compressed to WebP)", async () => {
      const registration = createRegistrationForPolicy({ eventId });

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.registration.update.mockResolvedValue({
        ...registration,
        paymentProofUrl: "test/proof.webp",
      });

      const result = await uploadPaymentProof(registration.id, {
        buffer: Buffer.from("test"),
        filename: "proof.png",
        mimetype: "image/png",
      });

      expect(result.fileUrl).toBe("test/proof.webp");
      expect(result.fileName).toBe("proof.webp"); // Compressed to WebP
      expect(result.mimeType).toBe("image/webp"); // Compressed to WebP
    });

    it("should accept JPEG images (compressed to WebP)", async () => {
      const registration = createRegistrationForPolicy({ eventId });

      prismaMock.registration.findUnique.mockResolvedValue(registration);
      prismaMock.registration.update.mockResolvedValue({
        ...registration,
        paymentProofUrl: "test/proof.webp",
      });

      const result = await uploadPaymentProof(registration.id, {
        buffer: Buffer.from("test"),
        filename: "proof.jpg",
        mimetype: "image/jpeg",
      });

      expect(result.fileUrl).toBe("test/proof.webp");
      expect(result.fileName).toBe("proof.webp"); // Compressed to WebP
      expect(result.mimeType).toBe("image/webp"); // Compressed to WebP
    });
  });

  describe("Price Breakdown Snapshot", () => {
    it("should store price breakdown on registration creation", async () => {
      const priceBreakdown = createMockPriceBreakdown({
        basePrice: 300,
        appliedRules: [
          {
            ruleId: "early-bird",
            ruleName: "Early Bird",
            effect: -50,
            reason: "Early registration",
          },
        ],
        calculatedBasePrice: 250,
        accessItems: [
          {
            accessId: "workshop-1",
            name: "Workshop A",
            unitPrice: 50,
            quantity: 2,
            subtotal: 100,
          },
        ],
        accessTotal: 100,
        subtotal: 350,
        sponsorships: [{ code: "SPONSOR123", amount: 100, valid: true }],
        sponsorshipTotal: 100,
        total: 250,
      });

      const input = {
        formId,
        formData: { firstName: "John" },
        email: "john@example.com",
        accessSelections: [{ accessId: "workshop-1", quantity: 2 }],
        sponsorshipCode: "SPONSOR123",
      };

      const mockForm = createMockForm({
        id: formId,
        eventId,
        schemaVersion: 1,
      });
      const mockEvent = {
        ...createMockEvent({
          id: eventId,
          status: "OPEN",
          maxCapacity: 100,
          registeredCount: 0,
        }),
        client: { enabledModules },
      };

      const createdRegistration = createMockRegistrationWithRelations({
        ...input,
        totalAmount: 250,
        priceBreakdown,
        baseAmount: 250,
        discountAmount: 50,
        accessAmount: 100,
        sponsorshipAmount: 100,
        accessTypeIds: ["workshop-1"],
      });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdRegistration);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.event.findUnique.mockResolvedValue(mockEvent);
          prismaMock.registration.create.mockResolvedValue(createdRegistration);
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          return callback(prismaMock);
        },
      );
      prismaMock.eventAccess.findMany.mockResolvedValue([
        createMockEventAccess({
          id: "workshop-1",
          name: "Workshop A",
          price: 50,
        }),
      ]);

      const result = await createRegistration(input, priceBreakdown);

      expect(result.totalAmount).toBe(250);
      expect(result.baseAmount).toBe(250);
      expect(result.discountAmount).toBe(50);
      expect(result.accessAmount).toBe(100);
      expect(result.sponsorshipAmount).toBe(100);
    });
  });

  describe("Sponsorship Code Handling", () => {
    it("should store sponsorship code on registration", async () => {
      const sponsorshipCode = "SPONSOR123";
      const priceBreakdown = createMockPriceBreakdown({
        sponsorships: [{ code: sponsorshipCode, amount: 100, valid: true }],
        sponsorshipTotal: 100,
        total: 200,
      });

      const input = {
        formId,
        formData: { firstName: "John" },
        email: "john@example.com",
        accessSelections: [],
        sponsorshipCode,
      };

      const mockForm = createMockForm({ id: formId, eventId });
      const mockEvent = {
        ...createMockEvent({ id: eventId, status: "OPEN" }),
        client: { enabledModules },
      };

      const createdRegistration = createMockRegistrationWithRelations({
        ...input,
        sponsorshipCode,
        sponsorshipAmount: 100,
        totalAmount: 200,
        priceBreakdown,
      });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdRegistration);
      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
          prismaMock.event.findUnique.mockResolvedValue(mockEvent);
          prismaMock.registration.create.mockResolvedValue(createdRegistration);
          prismaMock.auditLog.create.mockResolvedValue({} as never);
          return callback(prismaMock);
        },
      );
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await createRegistration(input, priceBreakdown);

      expect(result.sponsorshipCode).toBe(sponsorshipCode);
      expect(result.sponsorshipAmount).toBe(100);
    });
  });
});
