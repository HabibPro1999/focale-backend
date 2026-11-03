// Formatting shared by the email context builders (not part of the rendering
// barrel). Labels follow the template's language; French and Arabic wording
// follows the registrant-facing form app.

import type { LanguageCode } from "@app/contracts";
import { EMAIL_LOCALES } from "./locale";
import { sanitizeForHtml } from "./resolve";

/** The currency's minor digits (TND 3, EUR 2), 2 for an unknown code. */
function currencyDigits(currency: string, locale: string): number {
  try {
    return (
      new Intl.NumberFormat(locale, { style: "currency", currency })
        .resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * An amount in the language's number format, then the currency code:
 * "1 350,500 TND", "1,350.500 TND", "1.350,500 TND"; a whole amount has no
 * decimals ("250 TND").
 */
export function formatCurrency(
  amount: number,
  currency: string,
  language: LanguageCode,
): string {
  const locale = EMAIL_LOCALES[language];
  const digits = currencyDigits(currency, locale);
  const scale = 10 ** digits;
  const whole = Math.round(amount * scale) % scale === 0;
  const fractionDigits = whole ? 0 : digits;
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
  return `${number} ${currency}`;
}

/** The label of the base registration price in the sponsoredItems list. */
const BASE_PRICE_ITEM_LABELS: Record<LanguageCode, string> = {
  fr: "Inscription de base",
  en: "Base registration",
  ar: "التسجيل الأساسي",
};

export function basePriceItemLabel(language: LanguageCode): string {
  return BASE_PRICE_ITEM_LABELS[language];
}

/** "Label :" in French (space before the colon), "Label:" otherwise. */
export function labelWithColon(label: string, language: LanguageCode): string {
  return language === "fr" ? `${label} :` : `${label}:`;
}

/** One entry of the sponsoredItems list: the item and its amount, escaped. */
export function sponsoredItemHtml(
  label: string,
  amount: number,
  currency: string,
  language: LanguageCode,
): string {
  return `<b>${sanitizeForHtml(labelWithColon(label, language))}</b> ${sanitizeForHtml(formatCurrency(amount, currency, language))}`;
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

/** Several labels in one value: "A, B" (fr/en), "A، B" (ar). */
export function joinLabels(labels: string[], language: LanguageCode): string {
  return labels.join(language === "ar" ? "، " : ", ");
}

const PAYMENT_STATUS_LABELS: Record<string, Record<LanguageCode, string>> = {
  PENDING: { fr: "En attente", en: "Pending", ar: "في انتظار الدفع" },
  VERIFYING: {
    fr: "En cours de vérification",
    en: "Verifying payment",
    ar: "جارٍ التحقّق من الدفع",
  },
  PARTIAL: { fr: "Partiellement payé", en: "Partially paid", ar: "مدفوع جزئيًا" },
  PAID: { fr: "Confirmé", en: "Confirmed", ar: "مؤكَّد" },
  SPONSORED: { fr: "Sponsorisé", en: "Sponsored", ar: "متكفَّل به" },
  WAIVED: { fr: "Exonéré", en: "Waived", ar: "معفى" },
  REFUNDED: { fr: "Remboursé", en: "Refunded", ar: "تم استرجاع المبلغ" },
};

/** A payment status in words; an unknown status passes through. */
export function formatPaymentStatus(status: string, language: LanguageCode): string {
  return PAYMENT_STATUS_LABELS[status]?.[language] || status;
}

// Every value of the PaymentMethod enum (@app/contracts PaymentMethodSchema).
const PAYMENT_METHOD_LABELS: Record<string, Record<LanguageCode, string>> = {
  BANK_TRANSFER: { fr: "Virement bancaire", en: "Bank transfer", ar: "تحويل بنكي" },
  ONLINE: { fr: "Paiement en ligne", en: "Online payment", ar: "الدفع عبر الإنترنت" },
  CASH: { fr: "Espèces", en: "Cash", ar: "نقدًا" },
  LAB_SPONSORSHIP: {
    fr: "Prise en charge laboratoire",
    en: "Lab sponsorship",
    ar: "تكفّل المختبر",
  },
};

/** A payment method in words; an unknown one passes through, none is "". */
export function formatPaymentMethod(
  method: string | null | undefined,
  language: LanguageCode,
): string {
  if (!method) return "";
  return PAYMENT_METHOD_LABELS[method]?.[language] || method;
}

export const YES_NO: Record<LanguageCode, { yes: string; no: string }> = {
  fr: { yes: "Oui", no: "Non" },
  en: { yes: "Yes", no: "No" },
  ar: { yes: "نعم", no: "لا" },
};
