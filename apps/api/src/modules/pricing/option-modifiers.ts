import type { OptionModifierLine } from "@app/contracts";
import { toMinorUnits, validateFormData } from "@app/shared";
import { badRequest } from "../../core/app-exception";

export interface OptionPricingContext {
  /** Server-loaded schema, never accepted from a quote request. */
  formSchema: unknown;
  previous?: { formData: Record<string, unknown>; optionModifiers: OptionModifierLine[] };
}

function selections(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string"))].sort();
}

/** Price each visible selected option once, preserving unchanged selections' saved prices. */
export function priceOptionModifiers(context: OptionPricingContext | undefined, data: Record<string, unknown>, currency: string): OptionModifierLine[] {
  if (!context?.formSchema) return [];
  const validated = validateFormData(context.formSchema, data, { enforceRequired: false });
  if (!validated.valid) throw badRequest("Invalid form options");
  const answers = validated.data ?? {};
  const schema = context.formSchema as { steps?: { fields?: { id: string; type: string; options?: { id: string; label?: string; priceModifier?: number }[] }[] }[] };
  const lines: OptionModifierLine[] = [];
  for (const step of schema.steps ?? []) for (const field of step.fields ?? []) {
    if (!["radio", "dropdown", "checkbox"].includes(field.type)) continue;
    const selected = selections(answers[field.id]);
    const previous = context.previous;
    if (previous && JSON.stringify(selected) === JSON.stringify(selections(previous.formData[field.id]))) {
      lines.push(...previous.optionModifiers.filter((line) => line.fieldId === field.id && selected.includes(line.optionId)));
      continue;
    }
    const seen = new Set<string>();
    for (const option of field.options ?? []) {
      if (!selected.includes(option.id) || seen.has(option.id) || !option.priceModifier) continue;
      seen.add(option.id);
      try { toMinorUnits(option.priceModifier, currency); }
      catch { throw badRequest(`Invalid option price precision for ${currency}`); }
      lines.push({ fieldId: field.id, optionId: option.id, label: option.label ?? option.id, amount: option.priceModifier });
    }
  }
  return lines;
}
