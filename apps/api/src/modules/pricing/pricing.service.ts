import { validateChangedPricingRules } from "./pricing-rule-validation";
import { priceOptionModifiers, type OptionPricingContext } from "./option-modifiers";
import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  MAX_PRICING_RULES,
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
  findEventAccessByIds,
  findPendingSponsorshipsByCodes,
  getEventPricing,
  getEventPricingGate,
  getFormForPriceQuote,
  upsertEventPricing,
  withSerializableTxn,
  type DbExecutor,
  type PricingFormQuote,
  type PricingRowInsert,
  type PricingRowUpdate,
} from "@app/db";
import {
  calculateApplicableAmount,
  evaluateRuleConditions,
  newId,
  pickDefined,
  sumMoney,
  subtractMoney,
  multiplyMoney,
  withBreakdownMoney,
} from "@app/shared";
import { AppException, badRequest, notFound } from "../../core/app-exception";
import { assertEventWritable } from "../events";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { assertMoneyPrecision } from "../../core/money-input";

// Transaction-scoped write path shared by base-pricing PATCH and rule mutations.
// Mirrors legacy updateEventPricingTx: re-fetch event gate, re-assert
// writable/module-enabled inside the transaction, then upsert.
type MutateRules = (rules: EmbeddedPricingRule[]) => EmbeddedPricingRule[];

/**
 * The free-event flags after a PATCH: the input merged over the stored row
 * (an omitted flag keeps its stored value). Auto-accept needs a free event:
 * asking for it on a paid one is PRC_6009, and making the event paid again
 * clears it.
 */
function resolveFreeEventFlags(
  input: Pick<UpdateEventPricingInput, "isFree" | "autoAccept">,
  stored: Pick<EventPricingWithRules, "isFree" | "autoAccept"> | null,
): { isFree: boolean; autoAccept: boolean } {
  const isFree = input.isFree ?? stored?.isFree ?? false;
  if (input.autoAccept === true && !isFree) {
    throw new AppException(
      ErrorCodes.AUTO_ACCEPT_REQUIRES_FREE_EVENT,
      "Auto-accept can only be enabled on a free event",
      400,
    );
  }
  return { isFree, autoAccept: isFree && (input.autoAccept ?? stored?.autoAccept ?? false) };
}

@Injectable()
export class PricingService {
  /** GET pricing — findUnique with parsed rules (null when absent). */
  getEventPricing(eventId: string): Promise<EventPricingWithRules | null> {
    return getEventPricing(eventId);
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

  /** Append under the serializable transaction, enforcing the same cap as replacement. */
  addPricingRule(
    eventId: string,
    rule: CreateEmbeddedRuleInput,
  ): Promise<EventPricingWithRules> {
    return this.mutatePricingRules(eventId, (rules) => {
      if (rules.length >= MAX_PRICING_RULES) {
        throw badRequest(`An event can have at most ${MAX_PRICING_RULES} pricing rules`);
      }
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
        throw notFound("Pricing rule not found");
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
        throw notFound("Pricing rule not found");
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
      return this.updatePricingCore(tx, eventId, { rules: mutate(pricing.rules) }, pricing.rules);
    });
  }

  private async updatePricingCore(
    tx: DbExecutor,
    eventId: string,
    input: UpdateEventPricingInput,
    knownStoredRules?: EmbeddedPricingRule[],
  ): Promise<EventPricingWithRules> {
    const gate = await getEventPricingGate(eventId, tx);
    if (!gate) {
      throw notFound("Event not found");
    }
    assertEventWritable({ status: gate.status });
    assertModuleEnabledForClient(gate.client, "pricing");
    assertMoneyPrecision(input.currency ?? gate.currentCurrency ?? "TND", input.basePrice,
      ...(input.rules ?? []).map((rule) => rule.price));

    const createData: PricingRowInsert = {
      eventId,
      basePrice: input.basePrice ?? 0,
      currency: input.currency ?? "TND",
    };
    const updateData: PricingRowUpdate = {};

    if (input.basePrice !== undefined) {
      updateData.basePrice = input.basePrice ?? 0;
    }
    if (input.isFree !== undefined || input.autoAccept !== undefined || input.basePrice !== undefined) {
      const stored = await getEventPricing(eventId, tx);
      const flags = resolveFreeEventFlags(input, stored);
      if (flags.isFree) {
        // A free event holds its base price at 0, whatever price is sent.
        createData.basePrice = 0;
        updateData.basePrice = 0;
      }
      if (input.isFree !== undefined || input.autoAccept !== undefined) {
        Object.assign(createData, flags);
        Object.assign(updateData, flags);
      }
    }
    if (input.currency !== undefined) {
      const currentCurrency = gate.currentCurrency ?? "TND";
      if (input.currency !== currentCurrency) {
        const registrationCount = await countRegistrations(eventId, tx);
        if (registrationCount > 0) {
          throw new AppException(ErrorCodes.CURRENCY_LOCKED, "Cannot change currency after registrations exist", 400);
        }
        const stored = await getEventPricing(eventId, tx);
        assertMoneyPrecision(input.currency, input.basePrice ?? stored?.basePrice,
          ...(input.rules ?? stored?.rules ?? []).map((rule) => rule.price));
      }
      updateData.currency = input.currency;
    }
    if (input.rules !== undefined) {
      const rulesWithIds = input.rules.map((rule) => ({
        ...rule,
        id: rule.id ?? newId(),
      }));
      const storedRules = knownStoredRules ?? (await getEventPricing(eventId, tx))?.rules ?? [];
      await validateChangedPricingRules(tx, eventId, rulesWithIds, storedRules);

      updateData.rules = rulesWithIds;
      createData.rules = rulesWithIds;
    }
    const paymentFields = pickDefined(input, [
      "onlinePaymentEnabled", "onlinePaymentUrl", "cashPaymentEnabled",
      "bankName", "bankAccountName", "bankAccountNumber",
    ]);
    Object.assign(updateData, paymentFields);
    Object.assign(createData, paymentFields);

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
    optionContext?: OptionPricingContext,
  ): Promise<PriceBreakdown> {
    const { formData, selectedAccessItems, sponsorshipCodes } = input;

    const gate = await getEventPricingGate(eventId, db);
    if (!gate) {
      throw notFound("Event not found");
    }
    assertModuleEnabledForClient(gate.client, "pricing");

    const pricing =
      (await getEventPricing(eventId, db)) ??
      { basePrice: 0, currency: "TND", rules: [] };

    const { basePrice, currency, rules } = pricing;

    // Active rules, highest priority first; first match wins.
    const activeRules = rules
      .filter((r) => r.active)
      .sort((a, b) => b.priority - a.priority);

    const appliedRules: PriceBreakdown["appliedRules"] = [];
    let calculatedBasePrice = basePrice;
    for (const rule of activeRules) {
      if (evaluateRuleConditions(rule.conditions, rule.conditionLogic, formData)) {
        calculatedBasePrice = rule.price;
        appliedRules.push({
          ruleId: rule.id,
          ruleName: rule.name,
          effect: subtractMoney(rule.price, basePrice),
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
    const accessTotal = sumMoney(...accessItemsDetails.map((e) => e.subtotal));
    const optionModifiers = priceOptionModifiers(optionContext, formData, currency);
    const optionModifiersTotal = sumMoney(...optionModifiers.map((line) => line.amount));

    const subtotal = Math.max(0, sumMoney(calculatedBasePrice, accessTotal, optionModifiersTotal));

    const sponsorships = await this.validateSponsorshipCodes(
      sponsorshipCodes,
      eventId,
      { calculatedBasePrice, accessItemsDetails, subtotal },
      db,
    );
    const sponsorshipTotal = sumMoney(...sponsorships.filter((s) => s.valid).map((s) => s.amount));

    const total = Math.max(0, subtractMoney(subtotal, sponsorshipTotal));

    return withBreakdownMoney({
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
      optionModifiers,
      optionModifiersTotal,
    });
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
            subtotal: multiplyMoney(access.companionPrice, companionCount),
          };
        }
        // Non-included: registrant pays price, companions pay companionPrice.
        return {
          accessId: access.id,
          name: access.name,
          unitPrice: access.price,
          quantity: selected.quantity,
          subtotal: sumMoney(access.price, multiplyMoney(access.companionPrice, companionCount)),
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
    const sponsorships = await findPendingSponsorshipsByCodes(eventId, upperCodes, db);
    const sponsorshipMap = new Map(sponsorships.map((s) => [s.code, s]));

    let remainingAmount = Math.min(context.subtotal,
      sumMoney(context.calculatedBasePrice, ...context.accessItemsDetails.map((line) => line.subtotal)));

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
      remainingAmount = Math.max(0, subtractMoney(remainingAmount, amount));

      return { code: displayCode, amount, valid: true };
    });
  }
}
