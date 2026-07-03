import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type CalculatePriceRequest,
  type CreateEmbeddedRuleInput,
  type EmbeddedPricingRule,
  type EventPricingWithRules,
  type PriceBreakdown,
  type SelectedAccessItem,
  type UpdateEmbeddedRuleInput,
  type UpdateEventPricingInput,
} from "@app/contracts";
import {
  countRegistrations,
  findClientModuleState,
  findEventAccessByIds,
  findPendingSponsorships,
  getEventForOwnership,
  getEventPricing,
  getEventPricingGate,
  getFormForPriceQuote,
  upsertEventPricing,
  withSerializableTxn,
  type DbExecutor,
  type PricingEventOwnership,
  type PricingFormQuote,
  type PricingRowInsert,
  type PricingRowUpdate,
} from "@app/db";
import {
  calculateApplicableAmount,
  evaluateConditions,
  newId,
} from "@app/shared";
import { AppException } from "../../core/app-exception";
import { assertEventWritable, assertModuleEnabledForClient } from "./gates";

// Transaction-scoped write path shared by base-pricing PATCH and rule mutations.
// Mirrors legacy updateEventPricingTx: re-fetch event gate, re-assert
// writable/module-enabled inside the transaction, then upsert.
type MutateRules = (rules: EmbeddedPricingRule[]) => EmbeddedPricingRule[];

@Injectable()
export class PricingService {
  /** GET pricing — findUnique with parsed rules (null when absent). */
  getEventPricing(eventId: string): Promise<EventPricingWithRules | null> {
    return getEventPricing(eventId);
  }

  /** Event lookup for route-level ownership/writable checks (legacy getEventById). */
  getEventForOwnership(eventId: string): Promise<PricingEventOwnership | null> {
    return getEventForOwnership(eventId);
  }

  /**
   * Fresh client module-gate lookup (legacy assertClientModuleEnabled): 404 when
   * the client is missing, else 403 variants for inactive / module-disabled.
   */
  async assertClientModuleEnabled(clientId: string): Promise<void> {
    const client = await findClientModuleState(clientId);
    if (!client) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Client not found", 404);
    }
    assertModuleEnabledForClient(client, "pricing");
  }

  /** PATCH pricing (base price / currency / full rules replace / payment). */
  updateEventPricing(
    eventId: string,
    input: UpdateEventPricingInput,
  ): Promise<EventPricingWithRules> {
    return withSerializableTxn((tx) =>
      this.updatePricingCore(tx, eventId, input),
    );
  }

  /** POST a single rule — appends; does NOT enforce the 10-rule cap (legacy gotcha kept). */
  addPricingRule(
    eventId: string,
    rule: CreateEmbeddedRuleInput,
  ): Promise<EventPricingWithRules> {
    return this.mutatePricingRules(eventId, (rules) => {
      const newRule: EmbeddedPricingRule = {
        ...rule,
        id: newId(),
        description: rule.description ?? null,
        priority: rule.priority ?? 0,
        conditionLogic: rule.conditionLogic ?? "AND",
        active: rule.active ?? true,
      };
      return [...rules, newRule];
    });
  }

  /** PATCH a single rule by id — shallow merge. */
  updatePricingRule(
    eventId: string,
    ruleId: string,
    updates: UpdateEmbeddedRuleInput,
  ): Promise<EventPricingWithRules> {
    return this.mutatePricingRules(eventId, (rules) => {
      const idx = rules.findIndex((r) => r.id === ruleId);
      if (idx === -1) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          "Pricing rule not found",
          404,
        );
      }
      const next = [...rules];
      next[idx] = { ...next[idx], ...updates };
      return next;
    });
  }

  /** DELETE a single rule by id. */
  deletePricingRule(
    eventId: string,
    ruleId: string,
  ): Promise<EventPricingWithRules> {
    return this.mutatePricingRules(eventId, (rules) => {
      if (!rules.some((r) => r.id === ruleId)) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          "Pricing rule not found",
          404,
        );
      }
      return rules.filter((r) => r.id !== ruleId);
    });
  }

  // --- private write helpers ------------------------------------------------

  private mutatePricingRules(
    eventId: string,
    mutate: MutateRules,
  ): Promise<EventPricingWithRules> {
    return withSerializableTxn(async (tx) => {
      const pricing = await getEventPricing(eventId, tx);
      if (!pricing) {
        // Distinct code: cannot add/edit rules before base pricing exists.
        throw new AppException(
          ErrorCodes.PRICING_NOT_FOUND,
          "Event pricing not found",
          404,
        );
      }
      return this.updatePricingCore(tx, eventId, { rules: mutate(pricing.rules) });
    });
  }

  private async updatePricingCore(
    tx: DbExecutor,
    eventId: string,
    input: UpdateEventPricingInput,
  ): Promise<EventPricingWithRules> {
    const gate = await getEventPricingGate(eventId, tx);
    if (!gate) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertEventWritable({ status: gate.status });
    assertModuleEnabledForClient(gate.client, "pricing");

    const createData: PricingRowInsert = {
      eventId,
      basePrice: input.basePrice ?? 0,
      currency: input.currency ?? "TND",
    };
    const updateData: PricingRowUpdate = {};

    if (input.basePrice !== undefined) {
      updateData.basePrice = input.basePrice ?? 0;
    }
    if (input.currency !== undefined) {
      const currentCurrency = gate.currentCurrency ?? "TND";
      if (input.currency !== currentCurrency) {
        const registrationCount = await countRegistrations(eventId, tx);
        if (registrationCount > 0) {
          throw new AppException(
            ErrorCodes.VALIDATION_ERROR,
            "Cannot change currency after registrations exist",
            400,
          );
        }
      }
      updateData.currency = input.currency;
    }
    if (input.rules !== undefined) {
      const rulesWithIds = input.rules.map((rule) => ({
        ...rule,
        id: rule.id ?? newId(),
      }));
      updateData.rules = rulesWithIds;
      createData.rules = rulesWithIds;
    }
    if (input.onlinePaymentEnabled !== undefined) {
      updateData.onlinePaymentEnabled = input.onlinePaymentEnabled;
      createData.onlinePaymentEnabled = input.onlinePaymentEnabled;
    }
    if (input.onlinePaymentUrl !== undefined) {
      updateData.onlinePaymentUrl = input.onlinePaymentUrl;
      createData.onlinePaymentUrl = input.onlinePaymentUrl;
    }
    if (input.cashPaymentEnabled !== undefined) {
      updateData.cashPaymentEnabled = input.cashPaymentEnabled;
      createData.cashPaymentEnabled = input.cashPaymentEnabled;
    }
    if (input.bankName !== undefined) {
      updateData.bankName = input.bankName;
      createData.bankName = input.bankName;
    }
    if (input.bankAccountName !== undefined) {
      updateData.bankAccountName = input.bankAccountName;
      createData.bankAccountName = input.bankAccountName;
    }
    if (input.bankAccountNumber !== undefined) {
      updateData.bankAccountNumber = input.bankAccountNumber;
      createData.bankAccountNumber = input.bankAccountNumber;
    }

    return upsertEventPricing(tx, createData, updateData);
  }

  // ==========================================================================
  // Public-quote orchestration + price calculation
  // ==========================================================================

  /** Load the registration form + gate for the public calculate-price route. */
  getFormForPriceQuote(formId: string): Promise<PricingFormQuote | null> {
    return getFormForPriceQuote(formId);
  }

  /**
   * Pure READ price breakdown. Exported for the registrations module, which
   * passes its own transaction executor via `db`. Missing EventPricing is a
   * synthetic free default — NEVER writes.
   */
  async calculatePrice(
    eventId: string,
    input: CalculatePriceRequest,
    db?: DbExecutor,
  ): Promise<PriceBreakdown> {
    const { formData, selectedAccessItems, sponsorshipCodes } = input;

    const gate = await getEventPricingGate(eventId, db);
    if (!gate) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertModuleEnabledForClient(gate.client, "pricing");

    const pricing =
      (await getEventPricing(eventId, db)) ??
      ({
        id: "",
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
      } satisfies EventPricingWithRules);

    const { basePrice, currency, rules } = pricing;

    // Active rules, highest priority first; first match wins.
    const activeRules = rules
      .filter((r) => r.active)
      .sort((a, b) => b.priority - a.priority);

    const appliedRules: PriceBreakdown["appliedRules"] = [];
    let calculatedBasePrice = basePrice;
    for (const rule of activeRules) {
      if (evaluateConditions(rule.conditions, rule.conditionLogic, formData)) {
        calculatedBasePrice = rule.price;
        appliedRules.push({
          ruleId: rule.id,
          ruleName: rule.name,
          effect: rule.price - basePrice,
          reason: `Base price set to ${rule.price}`,
        });
        break;
      }
    }

    const accessItemsDetails = await this.calculateAccessItemsTotal(
      eventId,
      selectedAccessItems,
      db,
    );
    const accessTotal = accessItemsDetails.reduce((s, e) => s + e.subtotal, 0);

    const subtotal = calculatedBasePrice + accessTotal;

    const sponsorships = await this.validateSponsorshipCodes(
      sponsorshipCodes,
      eventId,
      { calculatedBasePrice, accessItemsDetails, subtotal },
      db,
    );
    const sponsorshipTotal = sponsorships
      .filter((s) => s.valid)
      .reduce((s, x) => s + x.amount, 0);

    const total = Math.max(0, subtotal - sponsorshipTotal);

    return {
      basePrice,
      appliedRules,
      calculatedBasePrice,
      accessItems: accessItemsDetails,
      accessTotal,
      subtotal,
      sponsorships,
      sponsorshipTotal,
      total,
      currency,
      droppedAccessItems: [],
    };
  }

  private async calculateAccessItemsTotal(
    eventId: string,
    selectedAccessItems: SelectedAccessItem[],
    db?: DbExecutor,
  ): Promise<PriceBreakdown["accessItems"]> {
    if (!selectedAccessItems.length) return [];

    const accessIds = selectedAccessItems.map((e) => e.accessId);
    const accessItems = await findEventAccessByIds(eventId, accessIds, db);
    const accessMap = new Map(accessItems.map((a) => [a.id, a]));

    return selectedAccessItems
      .map((selected) => {
        const access = accessMap.get(selected.accessId);
        if (!access) return null;

        const companionCount =
          selected.quantity > 1 ? selected.quantity - 1 : 0;

        if (access.includedInBase) {
          // Included: free for registrant, companions pay companionPrice.
          return {
            accessId: access.id,
            name: access.name,
            unitPrice: access.companionPrice,
            quantity: selected.quantity,
            subtotal: access.companionPrice * companionCount,
          };
        }
        // Non-included: registrant pays price, companions pay companionPrice.
        return {
          accessId: access.id,
          name: access.name,
          unitPrice: access.price,
          quantity: selected.quantity,
          subtotal: access.price + access.companionPrice * companionCount,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
  }

  private async validateSponsorshipCodes(
    codes: string[],
    eventId: string,
    context: {
      calculatedBasePrice: number;
      accessItemsDetails: Array<{ accessId: string; subtotal: number }>;
      subtotal: number;
    },
    db?: DbExecutor,
  ): Promise<PriceBreakdown["sponsorships"]> {
    if (!codes.length) return [];

    const normalizedCodes = [
      ...new Map(
        codes.map((code) => [code.trim().toUpperCase(), code.trim()]),
      ).entries(),
    ].filter(([upperCode]) => upperCode.length > 0);
    if (!normalizedCodes.length) return [];

    const upperCodes = normalizedCodes.map(([upperCode]) => upperCode);
    const sponsorships = await findPendingSponsorships(eventId, upperCodes, db);
    const sponsorshipMap = new Map(sponsorships.map((s) => [s.code, s]));

    let remainingAmount = context.subtotal;

    return normalizedCodes.map(([upperCode, displayCode]) => {
      const sponsorship = sponsorshipMap.get(upperCode);
      if (!sponsorship) {
        return { code: displayCode, amount: 0, valid: false };
      }

      const applicableAmount = calculateApplicableAmount(
        {
          totalAmount: sponsorship.totalAmount,
          coversBasePrice: sponsorship.coversBasePrice,
          coveredAccessIds: sponsorship.coveredAccessIds,
        },
        {
          baseAmount: context.calculatedBasePrice,
          totalAmount: context.subtotal,
          accessTypeIds: context.accessItemsDetails.map((e) => e.accessId),
          priceBreakdown: {
            calculatedBasePrice: context.calculatedBasePrice,
            accessItems: context.accessItemsDetails.map((e) => ({
              accessId: e.accessId,
              subtotal: e.subtotal,
            })),
          },
        },
      );
      const amount = Math.min(applicableAmount, remainingAmount);
      remainingAmount = Math.max(0, remainingAmount - amount);

      return { code: displayCode, amount, valid: true };
    });
  }
}
