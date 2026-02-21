import { describe, it, expect } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockEventPricing,
  createMockEventAccess,
  createMockSponsorship,
  createMockEvent,
  createMockClient,
} from "../../../tests/helpers/factories.js";
import {
  getEventPricing,
  updateEventPricing,
  addPricingRule,
  updatePricingRule,
  deletePricingRule,
  calculatePrice,
  getEventPaymentConfig,
} from "./pricing.service.js";
import { AppError } from "@shared/errors/app-error.js";

describe("Pricing Service", () => {
  const eventId = "event-123";

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
            conditionLogic: "and",
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
      const existingPricing = createMockEventPricing({
        eventId,
        basePrice: 200,
      });
      const updatedPricing = createMockEventPricing({
        eventId,
        basePrice: 300,
        rules: [],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(existingPricing);
      prismaMock.eventPricing.update.mockResolvedValue(updatedPricing);

      const result = await updateEventPricing(eventId, { basePrice: 300 });

      expect(result.basePrice).toBe(300);
      expect(prismaMock.eventPricing.update).toHaveBeenCalledWith({
        where: { eventId },
        data: expect.objectContaining({ basePrice: 300 }),
      });
    });

    it("should update payment methods", async () => {
      const existingPricing = createMockEventPricing({ eventId });
      const updatedPricing = createMockEventPricing({
        eventId,
        onlinePaymentEnabled: true,
        onlinePaymentUrl: "https://pay.example.com",
        rules: [],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(existingPricing);
      prismaMock.eventPricing.update.mockResolvedValue(updatedPricing);

      const result = await updateEventPricing(eventId, {
        onlinePaymentEnabled: true,
        onlinePaymentUrl: "https://pay.example.com",
      });

      expect(result.onlinePaymentEnabled).toBe(true);
    });

    it("should throw when pricing not found", async () => {
      prismaMock.eventPricing.findUnique.mockResolvedValue(null);

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
            conditionLogic: "and",
            priority: 0,
            active: true,
          },
        ],
      });

      prismaMock.eventPricing.findUnique
        .mockResolvedValueOnce(existingPricing)
        .mockResolvedValueOnce(existingPricing);
      prismaMock.eventPricing.update.mockResolvedValue(updatedPricing);

      const result = await addPricingRule(eventId, {
        name: "New Rule",
        price: 100,
        conditions: [{ fieldId: "test", operator: "equals", value: "test" }],
        conditionLogic: "and",
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
          conditionLogic: "and",
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
            conditionLogic: "and",
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
            conditionLogic: "and",
            priority: 0,
            active: true,
          },
        ],
      });

      prismaMock.eventPricing.findUnique
        .mockResolvedValueOnce(existingPricing)
        .mockResolvedValueOnce(existingPricing);
      prismaMock.eventPricing.update.mockResolvedValue(updatedPricing);

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
            conditionLogic: "and",
            priority: 0,
            active: true,
          },
        ],
      });
      const updatedPricing = createMockEventPricing({ eventId, rules: [] });

      prismaMock.eventPricing.findUnique
        .mockResolvedValueOnce(existingPricing)
        .mockResolvedValueOnce(existingPricing);
      prismaMock.eventPricing.update.mockResolvedValue(updatedPricing);

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
      prismaMock.sponsorship.findFirst.mockResolvedValue(null);

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedExtras: [],
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
            conditionLogic: "and",
            priority: 1,
            active: true,
            description: null,
          },
        ],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);
      prismaMock.sponsorship.findFirst.mockResolvedValue(null);

      const result = await calculatePrice(eventId, {
        formData: { status: "student" },
        selectedExtras: [],
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
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([mockAccess]);
      prismaMock.sponsorship.findFirst.mockResolvedValue(null);

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedExtras: [{ extraId: "workshop-1", quantity: 2 }],
        sponsorshipCodes: [],
      });

      expect(result.extrasTotal).toBe(100); // 50 * 2
      expect(result.extras).toHaveLength(1);
      expect(result.extras[0].subtotal).toBe(100);
      expect(result.total).toBe(300); // 200 + 100
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
      prismaMock.sponsorship.findFirst.mockResolvedValue(mockSponsorship);

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedExtras: [],
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
      prismaMock.sponsorship.findFirst.mockResolvedValue(mockSponsorship);

      const result = await calculatePrice(eventId, {
        formData: {},
        selectedExtras: [],
        sponsorshipCodes: ["BIGCODE"],
      });

      expect(result.total).toBe(0); // Should not be negative
    });

    it("should throw when pricing not found", async () => {
      prismaMock.eventPricing.findUnique.mockResolvedValue(null);

      await expect(
        calculatePrice(eventId, {
          formData: {},
          selectedExtras: [],
          sponsorshipCodes: [],
        }),
      ).rejects.toThrow(AppError);
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
            conditionLogic: "and",
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
            conditionLogic: "and",
            priority: 10,
            active: true,
            description: null,
          },
        ],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);
      prismaMock.sponsorship.findFirst.mockResolvedValue(null);

      const result = await calculatePrice(eventId, {
        formData: { type: "member" },
        selectedExtras: [],
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
            conditionLogic: "and",
            priority: 100,
            active: false, // Inactive
            description: null,
          },
        ],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);
      prismaMock.sponsorship.findFirst.mockResolvedValue(null);

      const result = await calculatePrice(eventId, {
        formData: { status: "student" },
        selectedExtras: [],
        sponsorshipCodes: [],
      });

      // Should use base price since rule is inactive
      expect(result.calculatedBasePrice).toBe(300);
      expect(result.appliedRules).toHaveLength(0);
    });
  });

  describe("getEventPaymentConfig", () => {
    it("should return event config with pricing when event and pricing exist", async () => {
      const mockClient = createMockClient({
        id: "client-1",
        name: "Acme Corp",
        logo: "https://example.com/logo.png",
        primaryColor: "#ff0000",
      });
      const mockEvent = createMockEvent({
        id: eventId,
        status: "OPEN",
        name: "Annual Conference",
        slug: "annual-conference",
        location: "Tunis",
      });
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 250,
        currency: "TND",
        bankName: "BIAT",
        bankAccountName: "Acme Events",
        bankAccountNumber: "TN12345678",
        onlinePaymentEnabled: false,
        onlinePaymentUrl: null,
        rules: [],
      });

      prismaMock.event.findUnique.mockResolvedValue({
        ...mockEvent,
        pricing: mockPricing,
        client: {
          id: mockClient.id,
          name: mockClient.name,
          logo: mockClient.logo,
          primaryColor: mockClient.primaryColor,
        },
      } as never);

      const result = await getEventPaymentConfig(eventId);

      expect(result).not.toBeNull();
      expect(result?.event.id).toBe(eventId);
      expect(result?.event.name).toBe("Annual Conference");
      expect(result?.event.slug).toBe("annual-conference");
      expect(result?.event.status).toBe("OPEN");
      expect(result?.event.location).toBe("Tunis");
      expect(result?.event.client.name).toBe("Acme Corp");
      expect(result?.pricing?.basePrice).toBe(250);
      expect(result?.pricing?.currency).toBe("TND");
      expect(result?.pricing?.paymentMethods).toContain("BANK_TRANSFER");
      expect(result?.pricing?.paymentMethods).not.toContain("ONLINE");
      expect(result?.pricing?.bankDetails).toMatchObject({
        bankName: "BIAT",
        accountName: "Acme Events",
        iban: "TN12345678",
      });
      expect(result?.pricing?.onlinePaymentUrl).toBeNull();
    });

    it("should include ONLINE payment method when online payment is enabled", async () => {
      const mockEvent = createMockEvent({ id: eventId });
      const mockPricing = createMockEventPricing({
        eventId,
        onlinePaymentEnabled: true,
        onlinePaymentUrl: "https://pay.example.com/checkout",
      });

      prismaMock.event.findUnique.mockResolvedValue({
        ...mockEvent,
        pricing: mockPricing,
        client: {
          id: "client-1",
          name: "Test Client",
          logo: null,
          primaryColor: null,
        },
      } as never);

      const result = await getEventPaymentConfig(eventId);

      expect(result?.pricing?.paymentMethods).toContain("BANK_TRANSFER");
      expect(result?.pricing?.paymentMethods).toContain("ONLINE");
      expect(result?.pricing?.onlinePaymentUrl).toBe(
        "https://pay.example.com/checkout",
      );
    });

    it("should return null pricing when event has no pricing configured", async () => {
      const mockEvent = createMockEvent({ id: eventId });

      prismaMock.event.findUnique.mockResolvedValue({
        ...mockEvent,
        pricing: null,
        client: {
          id: "client-1",
          name: "Test Client",
          logo: null,
          primaryColor: null,
        },
      } as never);

      const result = await getEventPaymentConfig(eventId);

      expect(result).not.toBeNull();
      expect(result?.event.id).toBe(eventId);
      expect(result?.pricing).toBeNull();
    });

    it("should return null when event not found", async () => {
      prismaMock.event.findUnique.mockResolvedValue(null);

      const result = await getEventPaymentConfig("non-existent");

      expect(result).toBeNull();
    });

    it("should return null bankDetails when pricing has no bank name", async () => {
      const mockEvent = createMockEvent({ id: eventId });
      const mockPricing = createMockEventPricing({
        eventId,
        bankName: null,
        bankAccountName: null,
        bankAccountNumber: null,
      });

      prismaMock.event.findUnique.mockResolvedValue({
        ...mockEvent,
        pricing: mockPricing,
        client: {
          id: "client-1",
          name: "Test Client",
          logo: null,
          primaryColor: null,
        },
      } as never);

      const result = await getEventPaymentConfig(eventId);

      expect(result?.pricing?.bankDetails).toBeNull();
    });

    it("should not include ONLINE method when URL is missing despite flag enabled", async () => {
      const mockEvent = createMockEvent({ id: eventId });
      const mockPricing = createMockEventPricing({
        eventId,
        onlinePaymentEnabled: true,
        onlinePaymentUrl: null, // Missing URL
      });

      prismaMock.event.findUnique.mockResolvedValue({
        ...mockEvent,
        pricing: mockPricing,
        client: {
          id: "client-1",
          name: "Test Client",
          logo: null,
          primaryColor: null,
        },
      } as never);

      const result = await getEventPaymentConfig(eventId);

      // ONLINE should NOT be in paymentMethods when URL is null
      expect(result?.pricing?.paymentMethods).not.toContain("ONLINE");
      expect(result?.pricing?.paymentMethods).toContain("BANK_TRANSFER");
    });
  });
});
