// =============================================================================
// EMAIL CONTEXT
// Builds EmailContext from registration data and resolves template variables.
// Ported from the legacy email-context.ts. The DB-enrichment path reads through
// @app/db query functions (the port of the legacy prisma calls).
// =============================================================================

import { calculateSettlement } from "@app/shared";
import type { LanguageCode } from "@app/contracts";
import {
  getEventPricingForEmail,
  getEventAccessByIdsForEmail,
  getSponsorshipByCodeForEmail,
  type RegistrationEmailContext,
} from "@app/db";
import type { EmailContext } from "./types";
import { formatDate } from "./locale";
import { decodeEntities, escapeHtml } from "@app/shared";
import { integrationsConfig } from "../../config";

// =============================================================================
// REGISTRANT SELF-SERVICE LINKS
// =============================================================================

export interface RegistrationSelfLinks {
  registrationLink: string;
  editRegistrationLink: string;
  paymentLink: string;
}

/**
 * Registrant self-service links (view/edit and payment). Base URL: the
 * registration's stored `linkBaseUrl`, else PUBLIC_FORMS_URL (required in
 * production). The single builder for emails and the admin edit-link endpoint.
 */
export function buildRegistrationSelfLinks(input: {
  registrationId: string;
  eventSlug: string;
  editToken: string | null;
  linkBaseUrl: string | null;
}): RegistrationSelfLinks {
  const baseUrl = input.linkBaseUrl || integrationsConfig().publicFormsUrl;
  const slug = input.eventSlug || "";
  const token = input.editToken || "";
  const selfLink = `${baseUrl}/${slug}/registration/${input.registrationId}/${token}`;
  return {
    registrationLink: selfLink,
    editRegistrationLink: selfLink,
    paymentLink: `${baseUrl}/${slug}/payment/${input.registrationId}/${token}`,
  };
}

// =============================================================================
// BUILD EMAIL CONTEXT FROM REGISTRATION (sync, no DB)
// =============================================================================

export function buildEmailContext(
  registration: RegistrationEmailContext,
): EmailContext {
  const { language } = registration;
  const formData =
    (registration.formData as Record<string, unknown>) || {};

  const selfLinks = buildRegistrationSelfLinks({
    registrationId: registration.id,
    eventSlug: registration.event.slug,
    editToken: registration.editToken,
    linkBaseUrl: registration.linkBaseUrl,
  });

  const context: EmailContext = {
    firstName: registration.firstName || String(formData.firstName || ""),
    lastName: registration.lastName || String(formData.lastName || ""),
    fullName:
      [registration.firstName, registration.lastName]
        .filter(Boolean)
        .join(" ") || UNNAMED_REGISTRANT[language],
    email: registration.email,
    phone: registration.phone || String(formData.phone || ""),
    registrationDate: formatDate(registration.submittedAt, language),
    registrationId: registration.id,
    registrationNumber: registration.id.slice(0, 8).toUpperCase(),

    eventName: registration.event.name,
    eventDate: formatDate(registration.event.startDate, language),
    eventEndDate: formatDate(registration.event.endDate, language),
    eventLocation: registration.event.location || "",
    eventDescription: registration.event.description || "",

    totalAmount: formatCurrency(
      registration.totalAmount,
      registration.currency,
    ),
    paidAmount: formatCurrency(registration.paidAmount, registration.currency),
    amountDue: formatCurrency(
      calculateSettlement({
        totalAmount: registration.totalAmount,
        paidAmount: registration.paidAmount,
        sponsorshipAmount: registration.sponsorshipAmount ?? 0,
      }).amountDue,
      registration.currency,
    ),
    paymentStatus: formatPaymentStatus(registration.paymentStatus, language),
    paymentMethod: registration.paymentMethod || "",

    selectedAccess: "",
    selectedWorkshops: "",
    selectedDinners: "",

    ...selfLinks,

    organizerName: registration.event.client.name,
    organizerEmail: registration.event.client.email || "",
    organizerPhone: registration.event.client.phone || "",

    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
  };

  for (const [key, value] of Object.entries(formData)) {
    context[`form_${key}` as keyof EmailContext] = formatFieldValue(
      value,
      language,
    );
  }

  return context;
}

// =============================================================================
// BUILD EMAIL CONTEXT WITH ACCESS (async, DB reads)
// =============================================================================

export async function buildEmailContextWithAccess(
  registration: RegistrationEmailContext,
): Promise<EmailContext> {
  const context = buildEmailContext(registration);

  const pricing = await getEventPricingForEmail(registration.eventId);

  if (pricing) {
    context.bankName = pricing.bankName || "";
    context.bankAccountName = pricing.bankAccountName || "";
    context.bankAccountNumber = pricing.bankAccountNumber || "";
  }

  const accessTypeIds = registration.accessTypeIds ?? [];
  if (accessTypeIds.length > 0) {
    const accessTypes = await getEventAccessByIdsForEmail(accessTypeIds);

    const accessMap = new Map(accessTypes.map((a) => [a.id, a]));
    const selectedNames = accessTypeIds
      .map((id) => accessMap.get(id)?.name)
      .filter(Boolean) as string[];

    context.selectedAccess = selectedNames.join(", ");

    context.selectedWorkshops = accessTypes
      .filter((a) => a.type === "WORKSHOP")
      .map((a) => a.name)
      .join(", ");

    context.selectedDinners = accessTypes
      .filter((a) => a.type === "DINNER")
      .map((a) => a.name)
      .join(", ");
  }

  if (registration.sponsorshipCode) {
    const sponsorship = await getSponsorshipByCodeForEmail(
      registration.sponsorshipCode,
      registration.eventId,
    );

    if (sponsorship) {
      context.sponsorshipCode = sponsorship.code;
      context.sponsorshipAmount = formatCurrency(
        sponsorship.totalAmount,
        registration.currency,
      );
      context.labName = sponsorship.batch.labName;
      context.labContactName = sponsorship.batch.contactName;
      context.labEmail = sponsorship.batch.email;
      context.beneficiaryName = sponsorship.beneficiaryName;

      const sponsoredItems: string[] = [];
      if (sponsorship.coversBasePrice && pricing) {
        sponsoredItems.push(
          `<b>Inscription de base :</b> ${sanitizeForHtml(formatCurrency(pricing.basePrice, registration.currency))}`,
        );
      }

      const coveredIds = sponsorship.coveredAccessIds ?? [];
      if (coveredIds.length > 0) {
        const coveredAccess = await getEventAccessByIdsForEmail(coveredIds);
        for (const access of coveredAccess) {
          sponsoredItems.push(
            `<b>${sanitizeForHtml(access.name)} :</b> ${sanitizeForHtml(formatCurrency(access.price, registration.currency))}`,
          );
        }
      }

      context.sponsoredItems = sponsoredItems
        .map((item) => `<div style="padding: 4px 0;">• ${item}</div>`)
        .join("");
      // Use the clamped applied amount (registration.sponsorshipAmount), not
      // the sponsorship's face value, which may exceed the registration total.
      context.remainingAmount = formatCurrency(
        calculateSettlement({
          totalAmount: registration.totalAmount,
          paidAmount: 0,
          sponsorshipAmount:
            registration.sponsorshipAmount ?? sponsorship.totalAmount,
        }).amountDue,
        registration.currency,
      );
    }
  }

  return context;
}

// =============================================================================
// RESOLVE VARIABLES IN TEMPLATE
// =============================================================================

// Variables that hold server-built HTML (their user parts are escaped when they
// are built) — inserted as-is into HTML, converted to text in text mode.
const HTML_SAFE_VARIABLES = new Set(["sponsoredItems", "beneficiaryList"]);

export interface ResolveVariablesOptions {
  /**
   * `html` (default): values are HTML-escaped, for HTML bodies.
   * `text`: for subjects and plain-text bodies. Values are inserted unescaped
   * (so "Dupont & Fils" is not sent as "Dupont &amp; Fils"), server-built HTML
   * values become text, and CR/LF in values becomes a space (no header
   * injection through a subject).
   */
  mode?: "html" | "text";
}

export function resolveVariables(
  template: string,
  context: EmailContext | Record<string, unknown>,
  options: ResolveVariablesOptions = {},
): string {
  const mode = options.mode ?? "html";
  return template.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_match, varId) => {
    const value = (context as Record<string, unknown>)[varId];

    if (value !== undefined && value !== null && value !== "") {
      if (mode === "text") {
        const text = HTML_SAFE_VARIABLES.has(varId)
          ? serverHtmlToText(String(value))
          : String(value);
        return text.replace(/[\r\n]+/g, " ");
      }
      if (HTML_SAFE_VARIABLES.has(varId)) {
        return String(value);
      }
      return sanitizeForHtml(String(value));
    }

    return "";
  });
}

/** Server-built HTML list (`<div>• …</div>…`) → text, one item per line. */
function serverHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*(div|p|li)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

// =============================================================================
// XSS SANITIZATION
// =============================================================================

export function sanitizeForHtml(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

// =============================================================================
// FORMATTING HELPERS
// Labels follow the registration form's primary language (dates: ./locale).
// French and Arabic wording follows the registrant-facing form app.
// =============================================================================

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

const YES_NO: Record<LanguageCode, { yes: string; no: string }> = {
  fr: { yes: "Oui", no: "Non" },
  en: { yes: "Yes", no: "No" },
  ar: { yes: "نعم", no: "لا" },
};

// fullName when the registration carries no name at all.
const UNNAMED_REGISTRANT: Record<LanguageCode, string> = {
  fr: "Participant",
  en: "Registrant",
  ar: "المشارك",
};

// Sponsorship contexts are built inside the sponsorship transactions, which do
// not load a form language yet, so their dates stay in English.
const SPONSORSHIP_EMAIL_LANGUAGE: LanguageCode = "en";

function formatCurrency(amount: number, currency = "TND"): string {
  return `${amount.toLocaleString("fr-TN")} ${currency}`;
}

function formatPaymentStatus(status: string, language: LanguageCode): string {
  return PAYMENT_STATUS_LABELS[status]?.[language] || status;
}

function formatFieldValue(value: unknown, language: LanguageCode): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") {
    return value ? YES_NO[language].yes : YES_NO[language].no;
  }
  if (Array.isArray(value)) return value.join(", ");
  if (value instanceof Date) return formatDate(value, language);
  return String(value);
}

// =============================================================================
// SAMPLE DATA FOR PREVIEW / TEST-SEND
// =============================================================================

/** Sample values, with dates and labels in the event's form language. */
export function getSampleEmailContext(language: LanguageCode): EmailContext {
  // Noon UTC keeps the sample's calendar day in any server timezone.
  return {
    firstName: "John",
    lastName: "Doe",
    fullName: "John Doe",
    email: "john.doe@example.com",
    phone: "+216 12 345 678",
    registrationDate: formatDate("2025-03-15T12:00:00Z", language),
    registrationId: "abc123",
    registrationNumber: "ABC123",

    eventName: "Medical Conference 2025",
    eventDate: formatDate("2025-04-20T12:00:00Z", language),
    eventEndDate: formatDate("2025-04-22T12:00:00Z", language),
    eventLocation: "Tunis, Tunisia",
    eventDescription: "Annual medical conference",

    totalAmount: "250 TND",
    paidAmount: "250 TND",
    amountDue: "0 TND",
    paymentStatus: formatPaymentStatus("PAID", language),
    paymentMethod: "Bank Transfer",

    selectedAccess: "Workshop A, Gala Dinner",
    selectedWorkshops: "Workshop A",
    selectedDinners: "Gala Dinner",

    registrationLink: "https://events.example.com/registration/abc123/abc123",
    editRegistrationLink:
      "https://events.example.com/registration/abc123/abc123",
    paymentLink: "https://events.example.com/payment/abc123/abc123",

    organizerName: "Medical Events Co.",
    organizerEmail: "contact@medicalevents.com",
    organizerPhone: "+216 71 123 456",

    bankName: "Banque de Tunisie",
    bankAccountName: "Medical Events SARL",
    bankAccountNumber: "TN59 1234 5678 9012 3456 7890",

    sponsorshipCode: "SAMPLE-CODE",
    sponsorshipAmount: "150 TND",
    labName: "Laboratoire Exemple",
    sponsoredItems: "Atelier A - 01/06/2025 (150 TND)",

    certificateCount: "2",
    certificateList: "Attendance Certificate, Speaker Certificate",
  };
}

// =============================================================================
// SPONSORSHIP EMAIL CONTEXT BUILDERS (pure — inputs pre-fetched by callers)
// =============================================================================

export interface BatchEmailContextInput {
  batch: {
    labName: string;
    contactName: string;
    email: string;
    phone: string | null;
  };
  sponsorships: Array<{
    beneficiaryName: string;
    beneficiaryEmail: string;
    totalAmount: number;
  }>;
  event: {
    name: string;
    startDate: Date;
    location: string | null;
    client: { name: string };
  };
  currency: string;
}

export interface LinkedSponsorshipContextInput {
  amountApplied: number;
  sponsorship: {
    code: string;
    beneficiaryName: string;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    totalAmount: number;
    batch: {
      labName: string;
      contactName: string;
      email: string;
    };
  };
  registration: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    totalAmount: number;
    baseAmount: number;
    sponsorshipAmount: number;
    linkBaseUrl: string | null;
    editToken: string | null;
  };
  event: {
    name: string;
    slug: string;
    startDate: Date;
    location: string | null;
    client: { name: string };
  };
  pricing: { basePrice: number } | null;
  accessItems: Array<{ id: string; name: string; price: number }>;
  currency: string;
}

/** Lab-confirmation email context (SPONSORSHIP_BATCH_SUBMITTED). */
export function buildBatchEmailContext(
  input: BatchEmailContextInput,
): Partial<EmailContext> {
  const { batch, sponsorships, event, currency } = input;
  const totalAmount = sponsorships.reduce((sum, s) => sum + s.totalAmount, 0);

  return {
    eventName: event.name,
    eventDate: formatDate(event.startDate, SPONSORSHIP_EMAIL_LANGUAGE),
    eventLocation: event.location || "",
    organizerName: event.client.name,

    labName: batch.labName,
    labContactName: batch.contactName,
    labEmail: batch.email,

    beneficiaryCount: String(sponsorships.length),
    totalBatchAmount: formatCurrency(totalAmount, currency),

    beneficiaryList: sponsorships
      .map(
        (s) =>
          `<div style="padding: 4px 0;">• <b>${sanitizeForHtml(s.beneficiaryName)}</b> (${sanitizeForHtml(s.beneficiaryEmail)}) : ${sanitizeForHtml(formatCurrency(s.totalAmount, currency))}</div>`,
      )
      .join(""),

    firstName: batch.contactName.split(" ")[0] || batch.contactName,
    lastName: batch.contactName.split(" ").slice(1).join(" ") || "",
    fullName: batch.contactName,
    email: batch.email,
    phone: batch.phone || "",
    registrationDate: formatDate(new Date(), SPONSORSHIP_EMAIL_LANGUAGE),
    registrationId: "",
    registrationNumber: "",
    eventEndDate: "",
    eventDescription: "",
    totalAmount: formatCurrency(totalAmount, currency),
    paidAmount: "0 " + currency,
    amountDue: formatCurrency(totalAmount, currency),
    paymentStatus: "N/A",
    paymentMethod: "",
    selectedAccess: "",
    selectedWorkshops: "",
    selectedDinners: "",
    registrationLink: "",
    editRegistrationLink: "",
    paymentLink: "",
    organizerEmail: "",
    organizerPhone: "",
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
  };
}

/** Doctor-notification context (SPONSORSHIP_LINKED / SPONSORSHIP_APPLIED). */
export function buildLinkedSponsorshipContext(
  input: LinkedSponsorshipContextInput,
): Partial<EmailContext> {
  const { sponsorship, registration, event, pricing, accessItems, currency } =
    input;

  const sponsoredItems: string[] = [];
  if (sponsorship.coversBasePrice) {
    const basePrice = registration.baseAmount ?? pricing?.basePrice ?? 0;
    sponsoredItems.push(
      `<b>Inscription de base :</b> ${sanitizeForHtml(formatCurrency(basePrice, currency))}`,
    );
  }
  for (const accessId of sponsorship.coveredAccessIds) {
    const access = accessItems.find((a) => a.id === accessId);
    if (access) {
      sponsoredItems.push(
        `<b>${sanitizeForHtml(access.name)} :</b> ${sanitizeForHtml(formatCurrency(access.price, currency))}`,
      );
    }
  }

  const { amountDue: remainingAmount } = calculateSettlement({
    totalAmount: registration.totalAmount,
    paidAmount: 0,
    sponsorshipAmount: registration.sponsorshipAmount,
  });

  const selfLinks = buildRegistrationSelfLinks({
    registrationId: registration.id,
    eventSlug: event.slug,
    editToken: registration.editToken,
    linkBaseUrl: registration.linkBaseUrl,
  });

  const isFullySponsored =
    registration.sponsorshipAmount >= registration.totalAmount;

  return {
    firstName: registration.firstName || "",
    lastName: registration.lastName || "",
    fullName:
      [registration.firstName, registration.lastName]
        .filter(Boolean)
        .join(" ") || sponsorship.beneficiaryName,
    email: registration.email,
    phone: registration.phone || "",
    registrationDate: formatDate(new Date(), SPONSORSHIP_EMAIL_LANGUAGE),
    registrationId: registration.id,
    registrationNumber: registration.id.slice(0, 8).toUpperCase(),

    eventName: event.name,
    eventDate: formatDate(event.startDate, SPONSORSHIP_EMAIL_LANGUAGE),
    eventEndDate: "",
    eventLocation: event.location || "",
    eventDescription: "",
    organizerName: event.client.name,
    organizerEmail: "",
    organizerPhone: "",

    totalAmount: formatCurrency(registration.totalAmount, currency),
    paidAmount: isFullySponsored
      ? formatCurrency(registration.totalAmount, currency)
      : "0 " + currency,
    amountDue: formatCurrency(remainingAmount, currency),
    paymentStatus: isFullySponsored ? "Paid" : "Pending",
    paymentMethod: "",

    selectedAccess: "",
    selectedWorkshops: "",
    selectedDinners: "",

    ...selfLinks,

    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",

    sponsorshipCode: sponsorship.code,
    sponsorshipAmount: formatCurrency(input.amountApplied, currency),
    labName: sponsorship.batch.labName,
    labContactName: sponsorship.batch.contactName,
    labEmail: sponsorship.batch.email,
    beneficiaryName: sponsorship.beneficiaryName,
    sponsoredItems: sponsoredItems
      .map((item) => `<div style="padding: 4px 0;">• ${item}</div>`)
      .join(""),
    remainingAmount: formatCurrency(remainingAmount, currency),
  };
}
