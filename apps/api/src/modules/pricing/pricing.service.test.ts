import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, type EventPricingWithRules } from "@app/contracts";

// Mock the db query layer + the serializable-txn helper. withSerializableTxn is a
// passthrough that invokes the callback with a dummy tx (query fns are mocked, so
// the tx value is never touched) — the equivalent of the legacy $transaction stub.
vi.mock("@app/db", () => ({
  withSerializableTxn: vi.fn(),
  getEventPricing: vi.fn(),
  getEventPricingGate: vi.fn(),
  countRegistrations: vi.fn(),
  upsertEventPricing: vi.fn(),
  findEventAccessByIds: vi.fn(),
  findPendingSponsorships: vi.fn(),
  getClientModuleState: vi.fn(),
  getEventForOwnership: vi.fn(),
  getFormForPriceQuote: vi.fn(),
}));

import {
  countRegistrations,
  findEventAccessByIds,
  findPendingSponsorships,
  getEventPricing,
  getEventPricingGate,
  upsertEventPricing,
  withSerializableTxn,
} from "@app/db";
import { PricingService } from "./pricing.service";
import { AppException } from "../../core/app-exception";

const eventId = "event-123";
const service = new PricingService();

function mockPricing(
  overrides: Partial<EventPricingWithRules> = {},
): EventPricingWithRules {
  return {
    id: "pricing-1",
    eventId,
    basePrice: 0,
    currency: "TND",
    rules: [],
    onlinePaymentEnabled: false,
    onlinePaymentUrl: null,
    cashPaymentEnabled: false,
    bankName: null,
    bankAccountName: null,
    bankAccountNumber: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function mockAccess(overrides: Record<string, unknown> = {}) {
  return {
    id: "access-1",
    eventId,
    name: "Access",
    price: 0,
    companionPrice: 0,
    includedInBase: false,
    ...overrides,
  } as never;
}

function mockSponsorship(overrides: {
  code: string;
  totalAmount: number;
  coversBasePrice?: boolean;
  coveredAccessIds?: string[];
}) {
  return {
    code: overrides.code,
    totalAmount: overrides.totalAmount,
    coversBasePrice: overrides.coversBasePrice ?? true,
    coveredAccessIds: overrides.coveredAccessIds ?? [],
  };
}

const gate = vi.mocked(getEventPricingGate);
const pricingRead = vi.mocked(getEventPricing);
const upsert = vi.mocked(upsertEventPricing);
const access = vi.mocked(findEventAccessByIds);
const sponsorships = vi.mocked(findPendingSponsorships);
const regCount = vi.mocked(countRegistrations);
const serTxn = vi.mocked(withSerializableTxn);

beforeEach(() => {
  vi.clearAllMocks();
  // passthrough serializable transaction
  serTxn.mockImplementation(async (fn) => fn({} as never));
  // default writable, pricing-enabled event with no existing pricing currency
  gate.mockResolvedValue({
    status: "CLOSED",
    client: { active: true, enabledModules: ["pricing"] },
    currentCurrency: null,
  });
  access.mockResolvedValue([]);
});

describe("getEventPricing", () => {
  it("returns pricing with parsed rules", async () => {
    pricingRead.mockResolvedValue(
      mockPricing({
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
          } as never,
        ],
      }),
    );

    const result = await service.getEventPricing(eventId);
    expect(result).not.toBeNull();
    expect(result?.basePrice).toBe(250);
    expect(result?.rules).toHaveLength(1);
    expect(result?.rules[0].name).toBe("Student Discount");
  });

  it("returns null when pricing not found", async () => {
    pricingRead.mockResolvedValue(null);
    expect(await service.getEventPricing("nope")).toBeNull();
  });
});

describe("updateEventPricing", () => {
  it("updates base price (create + update both carry it)", async () => {
    upsert.mockResolvedValue(mockPricing({ basePrice: 300 }));

    const result = await service.updateEventPricing(eventId, { basePrice: 300 });

    expect(result.basePrice).toBe(300);
    expect(upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ basePrice: 300 }),
      expect.objectContaining({ basePrice: 300 }),
    );
  });

  it("updates payment methods", async () => {
    upsert.mockResolvedValue(
      mockPricing({
        onlinePaymentEnabled: true,
        onlinePaymentUrl: "https://pay.example.com",
      }),
    );

    const result = await service.updateEventPricing(eventId, {
      onlinePaymentEnabled: true,
      onlinePaymentUrl: "https://pay.example.com",
    });

    expect(result.onlinePaymentEnabled).toBe(true);
  });

  it("rejects currency change when registrations exist", async () => {
    gate.mockResolvedValue({
      status: "CLOSED",
      client: { active: true, enabledModules: ["pricing"] },
      currentCurrency: "TND",
    });
    regCount.mockResolvedValue(2);

    await expect(
      service.updateEventPricing(eventId, { currency: "EUR" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: "Cannot change currency after registrations exist",
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("defaults current currency to TND when no pricing row exists", async () => {
    gate.mockResolvedValue({
      status: "CLOSED",
      client: { active: true, enabledModules: ["pricing"] },
      currentCurrency: null,
    });
    regCount.mockResolvedValue(1);

    await expect(
      service.updateEventPricing(eventId, { currency: "EUR" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
    });
    expect(regCount).toHaveBeenCalledWith(eventId, expect.anything());
    expect(upsert).not.toHaveBeenCalled();
  });

  it("skips the registration count when currency is unchanged", async () => {
    gate.mockResolvedValue({
      status: "CLOSED",
      client: { active: true, enabledModules: ["pricing"] },
      currentCurrency: "EUR",
    });
    upsert.mockResolvedValue(
      mockPricing({ currency: "EUR", onlinePaymentEnabled: true }),
    );

    const result = await service.updateEventPricing(eventId, {
      currency: "EUR",
      onlinePaymentEnabled: true,
    });

    expect(result.currency).toBe("EUR");
    expect(result.onlinePaymentEnabled).toBe(true);
    expect(regCount).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currency: "EUR", onlinePaymentEnabled: true }),
      expect.objectContaining({ currency: "EUR", onlinePaymentEnabled: true }),
    );
  });

  it("throws when event not found", async () => {
    gate.mockResolvedValue(null);
    await expect(
      service.updateEventPricing(eventId, { basePrice: 300 }),
    ).rejects.toThrow(AppException);
  });
});

describe("addPricingRule", () => {
  it("adds a new rule with a generated id", async () => {
    pricingRead.mockResolvedValue(mockPricing({ rules: [] }));
    upsert.mockResolvedValue(
      mockPricing({
        rules: [
          {
            id: "generated",
            name: "New Rule",
            price: 100,
            conditions: [
              { fieldId: "test", operator: "equals", value: "test" },
            ],
            conditionLogic: "AND",
            priority: 0,
            active: true,
            description: null,
          } as never,
        ],
      }),
    );

    const result = await service.addPricingRule(eventId, {
      name: "New Rule",
      price: 100,
      conditions: [{ fieldId: "test", operator: "equals", value: "test" }],
      conditionLogic: "AND",
      priority: 0,
      active: true,
    });

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].name).toBe("New Rule");
    // the mutated array handed to upsert carries the new rule with a string id
    const updateArg = upsert.mock.calls[0][2] as { rules: Array<{ name: string; id: unknown }> };
    expect(updateArg.rules[0].name).toBe("New Rule");
    expect(typeof updateArg.rules[0].id).toBe("string");
  });

  it("throws when pricing not found", async () => {
    pricingRead.mockResolvedValue(null);
    await expect(
      service.addPricingRule(eventId, {
        name: "Rule",
        price: 100,
        conditions: [{ fieldId: "test", operator: "equals", value: "test" }],
        conditionLogic: "AND",
        priority: 0,
        active: true,
      }),
    ).rejects.toThrow(AppException);
  });
});

describe("updatePricingRule", () => {
  it("updates an existing rule in place (shallow merge)", async () => {
    pricingRead.mockResolvedValue(
      mockPricing({
        rules: [
          {
            id: "rule-1",
            name: "Old Name",
            price: 100,
            conditions: [],
            conditionLogic: "AND",
            priority: 0,
            active: true,
          } as never,
        ],
      }),
    );
    upsert.mockResolvedValue(
      mockPricing({
        rules: [
          {
            id: "rule-1",
            name: "New Name",
            price: 150,
            conditions: [],
            conditionLogic: "AND",
            priority: 0,
            active: true,
          } as never,
        ],
      }),
    );

    const result = await service.updatePricingRule(eventId, "rule-1", {
      name: "New Name",
      price: 150,
    });

    expect(result.rules[0].name).toBe("New Name");
    expect(result.rules[0].price).toBe(150);
    const updateArg = upsert.mock.calls[0][2] as { rules: Array<{ name: string; price: number }> };
    expect(updateArg.rules[0].name).toBe("New Name");
    expect(updateArg.rules[0].price).toBe(150);
  });

  it("throws when rule not found", async () => {
    pricingRead.mockResolvedValue(mockPricing({ rules: [] }));
    await expect(
      service.updatePricingRule(eventId, "nope", { name: "x" }),
    ).rejects.toThrow(AppException);
  });
});

describe("deletePricingRule", () => {
  it("removes an existing rule", async () => {
    pricingRead.mockResolvedValue(
      mockPricing({
        rules: [
          {
            id: "rule-1",
            name: "Rule to Delete",
            price: 100,
            conditions: [],
            conditionLogic: "AND",
            priority: 0,
            active: true,
          } as never,
        ],
      }),
    );
    upsert.mockResolvedValue(mockPricing({ rules: [] }));

    const result = await service.deletePricingRule(eventId, "rule-1");
    expect(result.rules).toHaveLength(0);
    const updateArg = upsert.mock.calls[0][2] as { rules: unknown[] };
    expect(updateArg.rules).toHaveLength(0);
  });

  it("throws when rule not found", async () => {
    pricingRead.mockResolvedValue(mockPricing({ rules: [] }));
    await expect(
      service.deletePricingRule(eventId, "nope"),
    ).rejects.toThrow(AppException);
  });
});

describe("calculatePrice", () => {
  it("uses base price when no rules match", async () => {
    pricingRead.mockResolvedValue(mockPricing({ basePrice: 300, currency: "TND" }));

    const result = await service.calculatePrice(eventId, {
      formData: {},
      selectedAccessItems: [],
      sponsorshipCodes: [],
    });

    expect(result.basePrice).toBe(300);
    expect(result.calculatedBasePrice).toBe(300);
    expect(result.total).toBe(300);
    expect(result.currency).toBe("TND");
    expect(result.droppedAccessItems).toEqual([]);
  });

  it("applies a matching pricing rule", async () => {
    pricingRead.mockResolvedValue(
      mockPricing({
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
          } as never,
        ],
      }),
    );

    const result = await service.calculatePrice(eventId, {
      formData: { status: "student" },
      selectedAccessItems: [],
      sponsorshipCodes: [],
    });

    expect(result.calculatedBasePrice).toBe(150);
    expect(result.appliedRules).toHaveLength(1);
    expect(result.appliedRules[0].ruleName).toBe("Student Price");
    expect(result.total).toBe(150);
  });

  it("applies numeric rules to numeric-string form values", async () => {
    pricingRead.mockResolvedValue(
      mockPricing({
        basePrice: 300,
        rules: [
          {
            id: "adult-rule",
            name: "Adult Price",
            price: 500,
            conditions: [
              { fieldId: "age", operator: "greater_than", value: 18 },
            ],
            conditionLogic: "AND",
            priority: 1,
            active: true,
            description: null,
          } as never,
        ],
      }),
    );

    const result = await service.calculatePrice(eventId, {
      formData: { age: "25" },
      selectedAccessItems: [],
      sponsorshipCodes: [],
    });

    expect(result.calculatedBasePrice).toBe(500);
  });

  it("calculates access items total (registrant + companion)", async () => {
    pricingRead.mockResolvedValue(mockPricing({ basePrice: 200 }));
    access.mockResolvedValue([
      mockAccess({
        id: "workshop-1",
        name: "Advanced Workshop",
        price: 50,
        companionPrice: 50,
      }),
    ]);

    const result = await service.calculatePrice(eventId, {
      formData: {},
      selectedAccessItems: [{ accessId: "workshop-1", quantity: 2 }],
      sponsorshipCodes: [],
    });

    expect(result.accessTotal).toBe(100);
    expect(result.accessItems).toHaveLength(1);
    expect(result.accessItems[0].subtotal).toBe(100);
    expect(result.total).toBe(300);
  });

  it("ignores selected access items from another event", async () => {
    pricingRead.mockResolvedValue(mockPricing({ basePrice: 200 }));
    access.mockResolvedValue([]);

    const result = await service.calculatePrice(eventId, {
      formData: {},
      selectedAccessItems: [{ accessId: "foreign-access", quantity: 1 }],
      sponsorshipCodes: [],
    });

    expect(access).toHaveBeenCalledWith(eventId, ["foreign-access"], undefined);
    expect(result.accessItems).toHaveLength(0);
    expect(result.accessTotal).toBe(0);
    expect(result.total).toBe(200);
  });

  it("applies a sponsorship discount", async () => {
    pricingRead.mockResolvedValue(mockPricing({ basePrice: 300 }));
    sponsorships.mockResolvedValue([
      mockSponsorship({ code: "SPONSOR123", totalAmount: 150 }),
    ]);

    const result = await service.calculatePrice(eventId, {
      formData: {},
      selectedAccessItems: [],
      sponsorshipCodes: ["SPONSOR123"],
    });

    expect(result.sponsorshipTotal).toBe(150);
    expect(result.sponsorships[0].valid).toBe(true);
    expect(result.total).toBe(150);
  });

  it("collapses duplicate sponsorship codes to one", async () => {
    pricingRead.mockResolvedValue(mockPricing({ basePrice: 300 }));
    sponsorships.mockResolvedValue([
      mockSponsorship({ code: "SPONSOR123", totalAmount: 150 }),
    ]);

    const result = await service.calculatePrice(eventId, {
      formData: {},
      selectedAccessItems: [],
      sponsorshipCodes: ["SPONSOR123", "sponsor123"],
    });

    expect(result.sponsorships).toHaveLength(1);
    expect(result.sponsorshipTotal).toBe(150);
    expect(result.total).toBe(150);
  });

  it("caps cumulative sponsorship amounts to the subtotal", async () => {
    pricingRead.mockResolvedValue(mockPricing({ basePrice: 300 }));
    sponsorships.mockResolvedValue([
      mockSponsorship({ code: "CODE1", totalAmount: 300 }),
      mockSponsorship({ code: "CODE2", totalAmount: 300 }),
    ]);

    const result = await service.calculatePrice(eventId, {
      formData: {},
      selectedAccessItems: [],
      sponsorshipCodes: ["CODE1", "CODE2"],
    });

    expect(result.sponsorshipTotal).toBe(300);
    expect(result.sponsorships.map((s) => s.amount)).toEqual([300, 0]);
    expect(result.total).toBe(0);
  });

  it("never goes below zero", async () => {
    pricingRead.mockResolvedValue(mockPricing({ basePrice: 100 }));
    sponsorships.mockResolvedValue([
      mockSponsorship({ code: "BIGCODE", totalAmount: 200 }),
    ]);

    const result = await service.calculatePrice(eventId, {
      formData: {},
      selectedAccessItems: [],
      sponsorshipCodes: ["BIGCODE"],
    });

    expect(result.total).toBe(0);
  });

  it("treats missing pricing as a free event without writing", async () => {
    pricingRead.mockResolvedValue(null);

    const result = await service.calculatePrice(eventId, {
      formData: {},
      selectedAccessItems: [],
      sponsorshipCodes: [],
    });

    expect(result.total).toBe(0);
    expect(result.currency).toBe("TND");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("applies the highest-priority rule first", async () => {
    pricingRead.mockResolvedValue(
      mockPricing({
        basePrice: 300,
        rules: [
          {
            id: "low-priority",
            name: "Low Priority Rule",
            price: 200,
            conditions: [{ fieldId: "type", operator: "equals", value: "member" }],
            conditionLogic: "AND",
            priority: 1,
            active: true,
            description: null,
          } as never,
          {
            id: "high-priority",
            name: "High Priority Rule",
            price: 100,
            conditions: [{ fieldId: "type", operator: "equals", value: "member" }],
            conditionLogic: "AND",
            priority: 10,
            active: true,
            description: null,
          } as never,
        ],
      }),
    );

    const result = await service.calculatePrice(eventId, {
      formData: { type: "member" },
      selectedAccessItems: [],
      sponsorshipCodes: [],
    });

    expect(result.calculatedBasePrice).toBe(100);
    expect(result.appliedRules[0].ruleName).toBe("High Priority Rule");
  });

  it("skips inactive rules", async () => {
    pricingRead.mockResolvedValue(
      mockPricing({
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
            active: false,
            description: null,
          } as never,
        ],
      }),
    );

    const result = await service.calculatePrice(eventId, {
      formData: { status: "student" },
      selectedAccessItems: [],
      sponsorshipCodes: [],
    });

    expect(result.calculatedBasePrice).toBe(300);
    expect(result.appliedRules).toHaveLength(0);
  });
});
