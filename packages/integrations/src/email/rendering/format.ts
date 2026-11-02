// Formatting shared by the email context builders (not part of the rendering
// barrel).

import { sanitizeForHtml } from "./resolve";

export function formatCurrency(amount: number, currency = "TND"): string {
  return `${amount.toLocaleString("fr-TN")} ${currency}`;
}

/** The label of the base registration price in the sponsoredItems list. */
export const BASE_PRICE_ITEM_LABEL = "Inscription de base";

/** One entry of the sponsoredItems list: the item and its amount, escaped. */
export function sponsoredItemHtml(
  label: string,
  amount: number,
  currency: string,
): string {
  return `<b>${sanitizeForHtml(label)} :</b> ${sanitizeForHtml(formatCurrency(amount, currency))}`;
}

/**
 * A server-built HTML list (the sponsoredItems and beneficiaryList
 * variables): one line per entry. The entries are escaped by their builders.
 */
export function bulletListHtml(entries: string[]): string {
  return entries
    .map((entry) => `<div style="padding: 4px 0;">• ${entry}</div>`)
    .join("");
}
