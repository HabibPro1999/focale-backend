// =============================================================================
// EMAIL CONTEXT
// Builds EmailContext from registration data and resolves template variables.
// Ported from the legacy email-context.ts. The DB-enrichment path reads through
// @app/db query functions (the port of the legacy prisma calls).
// =============================================================================

import { calculateSettlement } from "@app/shared";
import {
  getEventPricingForEmail,
  getEventAccessByIdsForEmail,
  getSponsorshipByCodeForEmail,
  type RegistrationEmailContext,
} from "@app/db";
import type { EmailContext } from "./types";
import { escapeHtml } from "@app/shared";

// =============================================================================
// BUILD EMAIL CONTEXT FROM REGISTRATION (sync, no DB)
// =============================================================================

export function buildEmailContext(
  registration: RegistrationEmailContext,
): EmailContext {
  const formData =
    (registration.formData as Record<string, unknown>) || {};

  const baseUrl =
    registration.linkBaseUrl ||
    process.env.PUBLIC_FORMS_URL ||
    "https://events.example.com";

  const slug = registration.event.slug || "";
  const token = registration.editToken || "";

  const context: EmailContext = {
    firstName: registration.firstName || String(formData.firstName || ""),
    lastName: registration.lastName || String(formData.lastName || ""),
    fullName:
      [registration.firstName, registration.lastName]
        .filter(Boolean)
        .join(" ") || "Registrant",
    email: registration.email,
    phone: registration.phone || String(formData.phone || ""),
    registrationDate: formatDate(registration.submittedAt),
    registrationId: registration.id,
    registrationNumber: registration.id.slice(0, 8).toUpperCase(),

    eventName: registration.event.name,
    eventDate: formatDate(registration.event.startDate),
    eventEndDate: formatDate(registration.event.endDate),
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
    paymentStatus: formatPaymentStatus(registration.paymentStatus),
    paymentMethod: registration.paymentMethod || "",

    selectedAccess: "",
    selectedWorkshops: "",
    selectedDinners: "",

    registrationLink: `${baseUrl}/${slug}/registration/${registration.id}/${token}`,
    editRegistrationLink: `${baseUrl}/${slug}/registration/${registration.id}/${token}`,
    paymentLink: `${baseUrl}/${slug}/payment/${registration.id}/${token}`,

    organizerName: registration.event.client.name,
    organizerEmail: registration.event.client.email || "",
    organizerPhone: registration.event.client.phone || "",

    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
  };

  for (const [key, value] of Object.entries(formData)) {
    context[`form_${key}` as keyof EmailContext] = formatFieldValue(value);
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
      context.remainingAmount = formatCurrency(
        registration.totalAmount - sponsorship.totalAmount,
        registration.currency,
      );
    }
  }

  return context;
}

// =============================================================================
// RESOLVE VARIABLES IN TEMPLATE
// =============================================================================

// Variables that contain server-generated HTML (not user input) — skip escaping.
const HTML_SAFE_VARIABLES = new Set([
  "sponsoredItems",
  "beneficiaryList",
  "certificateList",
]);

export function resolveVariables(
  template: string,
  context: EmailContext | Record<string, unknown>,
): string {
  return template.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_match, varId) => {
    const value = (context as Record<string, unknown>)[varId];

    if (value !== undefined && value !== null && value !== "") {
      if (HTML_SAFE_VARIABLES.has(varId)) {
        return String(value);
      }
      return sanitizeForHtml(String(value));
    }

    return "";
  });
}

// =============================================================================
// XSS SANITIZATION
// =============================================================================

export function sanitizeForHtml(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

// =============================================================================
// FORMATTING HELPERS
// =============================================================================

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatCurrency(amount: number, currency = "TND"): string {
  return `${amount.toLocaleString("fr-TN")} ${currency}`;
}

function formatPaymentStatus(status: string): string {
  const statusMap: Record<string, string> = {
    PENDING: "Pending",
    VERIFYING: "Verifying payment",
    PARTIAL: "Partially paid",
    PAID: "Confirmed",
    SPONSORED: "Sponsored",
    WAIVED: "Waived",
    REFUNDED: "Refunded",
  };
  return statusMap[status] || status;
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (value instanceof Date) return formatDate(value);
  return String(value);
}

// =============================================================================
// SAMPLE DATA FOR PREVIEW / TEST-SEND
// =============================================================================

export function getSampleEmailContext(): EmailContext {
  return {
    firstName: "John",
    lastName: "Doe",
    fullName: "John Doe",
    email: "john.doe@example.com",
    phone: "+216 12 345 678",
    registrationDate: "March 15, 2025",
    registrationId: "abc123",
    registrationNumber: "ABC123",

    eventName: "Medical Conference 2025",
    eventDate: "April 20, 2025",
    eventEndDate: "April 22, 2025",
    eventLocation: "Tunis, Tunisia",
    eventDescription: "Annual medical conference",

    totalAmount: "250 TND",
    paidAmount: "250 TND",
    amountDue: "0 TND",
    paymentStatus: "Confirmed",
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
    eventDate: formatDate(event.startDate),
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
    registrationDate: formatDate(new Date()),
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

  const baseUrl =
    registration.linkBaseUrl ||
    process.env.PUBLIC_FORMS_URL ||
    "https://events.example.com";
  const token = registration.editToken || "";

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
    registrationDate: formatDate(new Date()),
    registrationId: registration.id,
    registrationNumber: registration.id.slice(0, 8).toUpperCase(),

    eventName: event.name,
    eventDate: formatDate(event.startDate),
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

    registrationLink: `${baseUrl}/${event.slug}/registration/${registration.id}/${token}`,
    editRegistrationLink: `${baseUrl}/${event.slug}/registration/${registration.id}/${token}`,
    paymentLink: `${baseUrl}/${event.slug}/payment/${registration.id}/${token}`,

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
