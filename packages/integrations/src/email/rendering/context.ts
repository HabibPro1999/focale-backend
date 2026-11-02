// =============================================================================
// EMAIL CONTEXT
// Builds EmailContext from registration data (./resolve fills templates from
// it). Ported from the legacy email-context.ts. The DB-enrichment path reads
// through @app/db query functions (the port of the legacy prisma calls).
// =============================================================================

import { calculateSettlement } from "@app/shared";
import type { LanguageCode } from "@app/contracts";
import {
  getEventPricingForEmail,
  getEventAccessByIdsForEmail,
  getSponsorshipByCodeForEmail,
  type EventAccessEmailInfo,
  type EventPricingEmailInfo,
  type RegistrationEmailContext,
} from "@app/db";
import type { EmailContext } from "./types";
import { formatDate } from "./locale";
import {
  BASE_PRICE_ITEM_LABEL,
  bulletListHtml,
  formatCurrency,
  sponsoredItemHtml,
} from "./format";
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

/**
 * Event-level reads of buildEmailContextWithAccess, loaded once for many
 * registrations of one event (3.8: a certificate send builds one context per
 * recipient).
 */
export interface EmailContextLookups {
  eventId: string;
  pricing: EventPricingEmailInfo | null;
  /** Access items by id. An id missing here is read from the DB. */
  accessById: ReadonlyMap<string, EventAccessEmailInfo>;
}

/** Pricing of `eventId` and the access items `accessIds`, in two reads. */
export async function loadEmailContextLookups(
  eventId: string,
  accessIds: Iterable<string>,
): Promise<EmailContextLookups> {
  const [pricing, access] = await Promise.all([
    getEventPricingForEmail(eventId),
    getEventAccessByIdsForEmail([...new Set(accessIds)]),
  ]);
  return { eventId, pricing, accessById: new Map(access.map((a) => [a.id, a])) };
}

/**
 * Access rows for `ids`: from `lookups` (in `ids` order, once each; ids it
 * lacks are read), or one read (DB order) without lookups.
 */
async function readAccessForEmail(
  ids: string[],
  lookups: EmailContextLookups | undefined,
): Promise<EventAccessEmailInfo[]> {
  if (!lookups) return getEventAccessByIdsForEmail(ids);
  const unique = [...new Set(ids)];
  const missing = unique.filter((id) => !lookups.accessById.has(id));
  const read = new Map(
    (missing.length > 0 ? await getEventAccessByIdsForEmail(missing) : []).map(
      (a) => [a.id, a],
    ),
  );
  return unique.flatMap((id) => {
    const access = lookups.accessById.get(id) ?? read.get(id);
    return access ? [access] : [];
  });
}

/**
 * Full email context: buildEmailContext plus bank details, access names and
 * sponsorship details. `lookups` (for the registration's event) replaces the
 * per-call pricing and access reads; lookups for another event are ignored.
 */
export async function buildEmailContextWithAccess(
  registration: RegistrationEmailContext,
  lookups?: EmailContextLookups,
): Promise<EmailContext> {
  const context = buildEmailContext(registration);
  const eventLookups =
    lookups?.eventId === registration.eventId ? lookups : undefined;

  const pricing = eventLookups
    ? eventLookups.pricing
    : await getEventPricingForEmail(registration.eventId);

  if (pricing) {
    context.bankName = pricing.bankName || "";
    context.bankAccountName = pricing.bankAccountName || "";
    context.bankAccountNumber = pricing.bankAccountNumber || "";
  }

  const accessTypeIds = registration.accessTypeIds ?? [];
  if (accessTypeIds.length > 0) {
    const accessTypes = await readAccessForEmail(accessTypeIds, eventLookups);

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
          sponsoredItemHtml(
            BASE_PRICE_ITEM_LABEL,
            pricing.basePrice,
            registration.currency,
          ),
        );
      }

      const coveredIds = sponsorship.coveredAccessIds ?? [];
      if (coveredIds.length > 0) {
        const coveredAccess = await readAccessForEmail(coveredIds, eventLookups);
        for (const access of coveredAccess) {
          sponsoredItems.push(
            sponsoredItemHtml(access.name, access.price, registration.currency),
          );
        }
      }

      context.sponsoredItems = bulletListHtml(sponsoredItems);
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
