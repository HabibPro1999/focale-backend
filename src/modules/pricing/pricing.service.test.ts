import { beforeEach, describe, it, expect } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockEventPricing,
  createMockEventAccess,
  createMockSponsorship,
} from "../../../tests/helpers/factories.js";
import {
  getEventPricing,
  updateEventPricing,
  addPricingRule,
  updatePricingRule,
  deletePricingRule,
  calculatePrice,
} from "./pricing.service.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

function mockPassthroughTransaction(): void {
  prismaMock.$transaction.mockImplementation(async (callback: unknown) =>
    (callback as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock),
  );
}
describe("Pricing Service", () => {
  const eventId = "event-123";
  const pricingEnabledEvent = {
    status: "CLOSED" as const,
    client: { enabledModules: ["pricing"] },
  };

  beforeEach(() => {
    mockPassthroughTransaction();
    prismaMock.event.findUnique.mockResolvedValue(pricingEnabledEvent as never);
  });

  describe("getEventPricing", () => {
    it("should return pricing with parsed rules", async () => {
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 250,
        rules: [
          {
            id: "rule-1",
            name: "Student Discount",
            price: 150,
            conditions: [
              { fieldId: "status", operator: "equals", value: "student" },
            ],
            conditionLogic: "AND",
            priority: 1,
            active: true,
          },
        ],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);

      const result = await getEventPricing(eventId);

      expect(result).not.toBeNull();
      expect(result?.basePrice).toBe(250);
      expect(result?.rules).toHaveLength(1);
      expect(result?.rules[0].name).toBe("Student Discount");
    });

    it("should return null when pricing not found", async () => {
      prismaMock.eventPricing.findUnique.mockResolvedValue(null);

      const result = await getEventPricing("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("updateEventPricing", () => {
    it("should update base price", async () => {
      const updatedPricing = createMockEventPricing({
        eventId,
        basePrice: 300,
        rules: [],
      });

      prismaMock.eventPricing.upsert.mockResolvedValue(updatedPricing);

      const result = await updateEventPricing(eventId, { basePrice: 300 });

      expect(result.basePrice).toBe(300);
      expect(prismaMock.eventPricing.upsert).toHaveBeenCalledWith({
        where: { eventId },
        create: expect.objectContaining({ basePrice: 300 }),
        update: expect.objectContaining({ basePrice: 300 }),
      });
    });

    it("should update payment methods", async () => {
      const updatedPricing = createMockEventPricing({
        eventId,
        onlinePaymentEnabled: true,
        onlinePaymentUrl: "https://pay.example.com",
        rules: [],
      });

      prismaMock.eventPricing.upsert.mockResolvedValue(updatedPricing);

      const result = await updateEventPricing(eventId, {
        onlinePaymentEnabled: true,
        onlinePaymentUrl: "https://pay.example.com",
      });

      expect(result.onlinePaymentEnabled).toBe(true);
    });

    it("should reject currency changes when registrations exist", async () => {
      prismaMock.event.findUnique.mockResolvedValue({
        ...pricingEnabledEvent,
        pricing: { currency: "TND" },
      } as never);
      prismaMock.registration.count.mockResolvedValue(2);

      await expect(
        updateEventPricing(eventId, { currency: "EUR" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
        message: "Cannot change currency after registrations exist",
      });

      expect(prismaMock.eventPricing.upsert).not.toHaveBeenCalled();
    });

    it("should use TND as the current currency when pricing does not exist", async () => {
      prismaMock.event.findUnique.mockResolvedValue({
        ...pricingEnabledEvent,
        pricing: null,
      } as never);
      prismaMock.registration.count.mockResolvedValue(1);

      await expect(
        updateEventPricing(eventId, { currency: "EUR" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
        message: "Cannot change currency after registrations exist",
      });

      expect(prismaMock.registration.count).toHaveBeenCalledWith({
        where: { eventId },
      });
      expect(prismaMock.eventPricing.upsert).not.toHaveBeenCalled();
    });

    it("should not count registrations when currency is unchanged", async () => {
      const updatedPricing = createMockEventPricing({
        eventId,
        currency: "EUR",
        onlinePaymentEnabled: true,
        rules: [],
      });

      prismaMock.event.findUnique.mockResolvedValue({
        ...pricingEnabledEvent,
        pricing: { currency: "EUR" },
      } as never);
      prismaMock.eventPricing.upsert.mockResolvedValue(updatedPricing);

      const result = await updateEventPricing(eventId, {
        currency: "EUR",
        onlinePaymentEnabled: true,
      });

      expect(result.currency).toBe("EUR");
      expect(result.onlinePaymentEnabled).toBe(true);
      expect(prismaMock.registration.count).not.toHaveBeenCalled();
      expect(prismaMock.eventPricing.upsert).toHaveBeenCalledWith({
        where: { eventId },
        create: expect.objectContaining({
          currency: "EUR",
          onlinePaymentEnabled: true,
        }),
        update: expect.objectContaining({
          currency: "EUR",
          onlinePaymentEnabled: true,
        }),
      });
    });

    it("should throw when event not found", async () => {
      prismaMock.event.findUnique.mockResolvedValue(null);

      await expect(
        updateEventPricing(eventId, { basePrice: 300 }),
      ).rejects.toThrow(AppError);
    });
  });

  describe("addPricingRule", () => {
    it("should add a new rule with generated ID", async () => {
      const existingPricing = createMockEventPricing({ eventId, rules: [] });
      const updatedPricing = createMockEventPricing({
        eventId,
        rules: [
          {
            id: expect.any(String),
            name: "New Rule",
            price: 100,
            conditions: [],
            conditionLogic: "AND",
            priority: 0,
            active: true,
          },
        ],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValueOnce(existingPricing);
      prismaMock.eventPricing.upsert.mockResolvedValue(updatedPricing);

      const result = await addPricingRule(eventId, {
        name: "New Rule",
        price: 100,
        conditions: [{ fieldId: "test", operator: "equals", value: "test" }],
        conditionLogic: "AND",
        priority: 0,
        active: true,
      });

      expect(result.rules).toHaveLength(1);
      expect(result.rules[0].name).toBe("New Rule");
    });

    it("should throw when pricing not found", async () => {
      prismaMock.eventPricing.findUnique.mockResolvedValue(null);

      await expect(
        addPricingRule(eventId, {
          name: "Rule",
          price: 100,
          conditions: [{ fieldId: "test", operator: "equals", value: "test" }],
          conditionLogic: "AND",
          priority: 0,
          active: true,
        }),
      ).rejects.toThrow(AppError);
    });
  });

  describe("updatePricingRule", () => {
    it("should update an existing rule", async () => {
      const existingPricing = createMockEventPricing({
        eventId,
        rules: [
          {
            id: "rule-1",
            name: "Old Name",
            price: 100,
            conditions: [],
            conditionLogic: "AND",
            priority: 0,
            active: true,
          },
        ],
      });
      const updatedPricing = createMockEventPricing({
        eventId,
        rules: [
          {
            id: "rule-1",
            name: "New Name",
            price: 150,
            conditions: [],
            conditionLogic: "AND",
            priority: 0,
            active: true,
          },
        ],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValueOnce(existingPricing);
      prismaMock.eventPricing.upsert.mockResolvedValue(updatedPricing);

      const result = await updatePricingRule(eventId, "rule-1", {
        name: "New Name",
        price: 150,
      });

      expect(result.rules[0].name).toBe("New Name");
      expect(result.rules[0].price).toBe(150);
    });

    it("should throw when rule not found", async () => {
      const existingPricing = createMockEventPricing({ eventId, rules: [] });
      prismaMock.eventPricing.findUnique.mockResolvedValue(existingPricing);

      await expect(
        updatePricingRule(eventId, "non-existent", { name: "Test" }),
      ).rejects.toThrow(AppError);
    });
  });

  describe("deletePricingRule", () => {
    it("should delete an existing rule", async () => {
      const existingPricing = createMockEventPricing({
        eventId,
        rules: [
          {
            id: "rule-1",
            name: "Rule to Delete",
            price: 100,
            conditions: [],
            conditionLogic: "AND",
            priority: 0,
            active: true,
          },
        ],
      });
      const updatedPricing = createMockEventPricing({ eventId, rules: [] });

      prismaMock.eventPricing.findUnique.mockResolvedValueOnce(existingPricing);
      prismaMock.eventPricing.upsert.mockResolvedValue(updatedPricing);

      const result = await deletePricingRule(eventId, "rule-1");

      expect(result.rules).toHaveLength(0);
    });

    it("should throw when rule not found", async () => {
      const existingPricing = createMockEventPricing({ eventId, rules: [] });
      prismaMock.eventPricing.findUnique.mockResolvedValue(existingPricing);

      await expect(deletePricingRule(eventId, "non-existent")).rejects.toThrow(
        AppError,
      );
    });
  });

  describe("calculatePrice", () => {
    it("should calculate base price when no rules match", async () => {
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 300,
        currency: "TND",
        rules: [],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedAccessItems: [],
        sponsorshipCodes: [],
      });

      expect(result.basePrice).toBe(300);
      expect(result.calculatedBasePrice).toBe(300);
      expect(result.total).toBe(300);
      expect(result.currency).toBe("TND");
    });

    it("should apply matching pricing rule", async () => {
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 300,
        rules: [
          {
            id: "student-rule",
            name: "Student Price",
            price: 150,
            conditions: [
              { fieldId: "status", operator: "equals", value: "student" },
            ],
            conditionLogic: "AND",
            priority: 1,
            active: true,
            description: null,
          },
        ],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await calculatePrice(eventId, {
        formData: { status: "student" },
        selectedAccessItems: [],
        sponsorshipCodes: [],
      });

      expect(result.calculatedBasePrice).toBe(150);
      expect(result.appliedRules).toHaveLength(1);
      expect(result.appliedRules[0].ruleName).toBe("Student Price");
      expect(result.total).toBe(150);
    });

    it("should calculate extras total", async () => {
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 200,
        rules: [],
      });
      const mockAccess = createMockEventAccess({
        id: "workshop-1",
        name: "Advanced Workshop",
        price: 50,
        companionPrice: 50,
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([mockAccess]);

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedAccessItems: [{ accessId: "workshop-1", quantity: 2 }],
        sponsorshipCodes: [],
      });

      expect(result.accessTotal).toBe(100); // 50 + 50 (companion)
      expect(result.accessItems).toHaveLength(1);
      expect(result.accessItems[0].subtotal).toBe(100);
      expect(result.total).toBe(300); // 200 + 100
    });

    it("should ignore selected access items from another event", async () => {
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 200,
        rules: [],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedAccessItems: [{ accessId: "foreign-access", quantity: 1 }],
        sponsorshipCodes: [],
      });

      expect(prismaMock.eventAccess.findMany).toHaveBeenCalledWith({
        where: { id: { in: ["foreign-access"] }, eventId },
      });
      expect(result.accessItems).toHaveLength(0);
      expect(result.accessTotal).toBe(0);
      expect(result.total).toBe(200);
    });

    it("should apply sponsorship discount", async () => {
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 300,
        rules: [],
      });
      const mockSponsorship = createMockSponsorship({
        eventId,
        code: "SPONSOR123",
        totalAmount: 150,
        status: "PENDING",
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);
      prismaMock.sponsorship.findMany.mockResolvedValue([mockSponsorship]);

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedAccessItems: [],
        sponsorshipCodes: ["SPONSOR123"],
      });

      expect(result.sponsorshipTotal).toBe(150);
      expect(result.sponsorships[0].valid).toBe(true);
      expect(result.total).toBe(150); // 300 - 150
    });

    it("should not go below zero", async () => {
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 100,
        rules: [],
      });
      const mockSponsorship = createMockSponsorship({
        eventId,
        code: "BIGCODE",
        totalAmount: 200, // More than base price
        status: "PENDING",
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);
      prismaMock.sponsorship.findMany.mockResolvedValue([mockSponsorship]);

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedAccessItems: [],
        sponsorshipCodes: ["BIGCODE"],
      });

      expect(result.total).toBe(0); // Should not be negative
    });

    it("should repair missing pricing as a free event", async () => {
      prismaMock.eventPricing.findUnique.mockResolvedValue(null);
      prismaMock.eventPricing.upsert.mockResolvedValue(
        createMockEventPricing({
          eventId,
          basePrice: 0,
          currency: "TND",
          rules: [],
        }),
      );

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedAccessItems: [],
        sponsorshipCodes: [],
      });

      expect(result.total).toBe(0);
      expect(result.currency).toBe("TND");
    });

    it("should apply highest priority rule first", async () => {
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 300,
        rules: [
          {
            id: "low-priority",
            name: "Low Priority Rule",
            price: 200,
            conditions: [
              { fieldId: "type", operator: "equals", value: "member" },
            ],
            conditionLogic: "AND",
            priority: 1,
            active: true,
            description: null,
          },
          {
            id: "high-priority",
            name: "High Priority Rule",
            price: 100,
            conditions: [
              { fieldId: "type", operator: "equals", value: "member" },
            ],
            conditionLogic: "AND",
            priority: 10,
            active: true,
            description: null,
          },
        ],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await calculatePrice(eventId, {
        formData: { type: "member" },
        selectedAccessItems: [],
        sponsorshipCodes: [],
      });

      expect(result.calculatedBasePrice).toBe(100);
      expect(result.appliedRules[0].ruleName).toBe("High Priority Rule");
    });

    it("should skip inactive rules", async () => {
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 300,
        rules: [
          {
            id: "inactive-rule",
            name: "Inactive Rule",
            price: 50,
            conditions: [
              { fieldId: "status", operator: "equals", value: "student" },
            ],
            conditionLogic: "AND",
            priority: 100,
            active: false, // Inactive
            description: null,
          },
        ],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await calculatePrice(eventId, {
        formData: { status: "student" },
        selectedAccessItems: [],
        sponsorshipCodes: [],
      });

      // Should use base price since rule is inactive
      expect(result.calculatedBasePrice).toBe(300);
      expect(result.appliedRules).toHaveLength(0);
    });
  });
});
