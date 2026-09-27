import {
  ErrorCodes, buildFieldOptionIndex, findInvalidOptionConditions,
  conditionSetSignature, findConditionConflicts, type EmbeddedPricingRule,
} from "@app/contracts";
import { findRegistrationFormSchema, type DbExecutor } from "@app/db";
import { AppException } from "../../core/app-exception";

/** Validate only changed condition signatures, preserving legacy rules and error order. */
export async function assertChangedRulesValid(
  tx: DbExecutor,
  eventId: string,
  storedRules: EmbeddedPricingRule[],
  rulesWithIds: EmbeddedPricingRule[],
): Promise<void> {
  // Grandfathering: only validate rules whose canonical condition
  // signature differs from what is already stored. A naive "validate every
  // rule in the array" guard would 400 on deleting a rule, toggling
  // `active`, renaming, or repricing an existing (possibly legacy
  // contradictory) rule — bricking the pricing UI for any event with a
  // pre-existing unsatisfiable rule. Any edit to a rule's conditions or
  // conditionLogic flips it into "must be valid" going forward.
  const storedSignatures = new Map(
    storedRules.map((rule) => [
      rule.id,
      conditionSetSignature(rule.conditions, rule.conditionLogic),
    ]),
  );

  const rulesToValidate = rulesWithIds.filter((rule) => {
    const storedSignature = storedSignatures.get(rule.id);
    const currentSignature = conditionSetSignature(
      rule.conditions,
      rule.conditionLogic,
    );
    // Untouched legacy rules are grandfathered in — excluded here too, not
    // just from the contradiction guard, so a rule with a legacy
    // label-not-id condition value doesn't newly 400 on an unrelated edit
    // (rename, reprice, reorder) elsewhere in the same bulk update.
    return !(
      storedSignature !== undefined && storedSignature === currentSignature
    );
  });

  for (const rule of rulesToValidate) {
    const conflicts = findConditionConflicts(
      rule.conditions,
      rule.conditionLogic,
    );
    if (conflicts.length > 0) {
      throw new AppException(
        ErrorCodes.PRICING_RULE_UNSATISFIABLE,
        `Pricing rule "${rule.name}" has conditions that can never all be true`,
        400,
        { ruleId: rule.id, ruleName: rule.name, conflicts },
      );
    }
  }

  if (rulesToValidate.length > 0) {
    const form = await findRegistrationFormSchema(eventId, tx);
    if (form) {
      const optionIndex = buildFieldOptionIndex(form.schema);
      for (const rule of rulesToValidate) {
        const bad = findInvalidOptionConditions(
          rule.conditions,
          optionIndex,
        );
        if (bad.length > 0) {
          const f = bad[0];
          throw new AppException(
            ErrorCodes.PRICING_CONDITION_INVALID_OPTION,
            `Pricing rule "${rule.name}": value "${String(f.value)}" for field "${f.fieldLabel}" is not one of the field's option ids (e.g. ${f.exampleOptionIds.map((id) => `"${id}"`).join(", ")}). Pick the option in the rule editor.`,
            400,
            {
              ruleId: rule.id,
              ruleName: rule.name,
              fieldId: f.fieldId,
              fieldLabel: f.fieldLabel,
              operator: f.operator,
              value: f.value,
              exampleOptionIds: f.exampleOptionIds,
            },
          );
        }
      }
    }
  }
}
