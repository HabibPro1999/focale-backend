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
  getRegistrationFormSchema,
  getSponsorshipByCodeForEmail,
  type EventAccessEmailInfo,
  type EventPricingEmailInfo,
  type RegistrationEmailContext,
} from "@app/db";
import type { EmailContext } from "./types";
import { formatDate, formatDateRange } from "./locale";
import {
  basePriceItemLabel,
  bulletListHtml,
  formatCurrency,
  formatPaymentMethod,
  formatPaymentStatus,
  sponsoredItemHtml,
} from "./format";
import {
  formatFormData,
  indexFormFields,
  type FormFieldIndex,
} from "./form-values";
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

/** The short registration number shown to registrants: the id's first 8 characters, upper-cased. */
export function formatRegistrationNumber(registrationId: string): string {
  return registrationId.slice(0, 8).toUpperCase();
}

// =============================================================================
// BUILD EMAIL CONTEXT FROM REGISTRATION (sync, no DB)
// =============================================================================

/**
 * `formFields`: the event's registration form fields, so `form_*` answers read
 * as labels, names and dates. Without them, answers are formatted as stored
 * (objects blank).
 */
export function buildEmailContext(
  registration: RegistrationEmailContext,
  formFields?: FormFieldIndex | null,
): EmailContext {
  const { language, currency } = registration;
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
    registrationNumber: formatRegistrationNumber(registration.id),

    eventName: registration.event.name,
    eventDate: formatDate(registration.event.startDate, language),
    eventEndDate: formatDate(registration.event.endDate, language),
    eventDateRange: formatDateRange(
      registration.event.startDate,
      registration.event.endDate,
      language,
    ),
    eventLocation: registration.event.location || "",
    eventDescription: registration.event.description || "",

    totalAmount: formatCurrency(registration.totalAmount, currency, language),
    paidAmount: formatCurrency(registration.paidAmount, currency, language),
    amountDue: formatCurrency(
      calculateSettlement({
        totalAmount: registration.totalAmount,
        paidAmount: registration.paidAmount,
        sponsorshipAmount: registration.sponsorshipAmount ?? 0,
      }).amountDue,
      currency,
      language,
    ),
    paymentStatus: formatPaymentStatus(registration.paymentStatus, language),
    paymentMethod: formatPaymentMethod(registration.paymentMethod, language),

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

  return Object.assign(context, formatFormData(formData, formFields, language));
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
  /** The event's registration form fields (form_* formatting). */
  formFields: FormFieldIndex;
  /** Access items by id. An id missing here is read from the DB. */
  accessById: ReadonlyMap<string, EventAccessEmailInfo>;
}

/**
 * Pricing of `eventId`, its registration form fields and the access items
 * `accessIds`, in three reads.
 */
export async function loadEmailContextLookups(
  eventId: string,
  accessIds: Iterable<string>,
): Promise<EmailContextLookups> {
  const [pricing, schema, access] = await Promise.all([
    getEventPricingForEmail(eventId),
    getRegistrationFormSchema(eventId),
    getEventAccessByIdsForEmail([...new Set(accessIds)]),
  ]);
  return {
    eventId,
    pricing,
    formFields: indexFormFields(schema),
    accessById: new Map(access.map((a) => [a.id, a])),
  };
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
  const eventLookups =
    lookups?.eventId === registration.eventId ? lookups : undefined;

  const [pricing, formFields] = eventLookups
    ? [eventLookups.pricing, eventLookups.formFields]
    : await Promise.all([
        getEventPricingForEmail(registration.eventId),
        getRegistrationFormSchema(registration.eventId).then(indexFormFields),
      ]);
  const context = buildEmailContext(registration, formFields);
  const { language, currency } = registration;

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
        currency,
        language,
      );
      context.labName = sponsorship.batch.labName;
      context.labContactName = sponsorship.batch.contactName;
      context.labEmail = sponsorship.batch.email;
      context.beneficiaryName = sponsorship.beneficiaryName;

      const sponsoredItems: string[] = [];
      if (sponsorship.coversBasePrice && pricing) {
        sponsoredItems.push(
          sponsoredItemHtml(
            basePriceItemLabel(language),
            pricing.basePrice,
            currency,
            language,
          ),
        );
      }

      const coveredIds = sponsorship.coveredAccessIds ?? [];
      if (coveredIds.length > 0) {
        const coveredAccess = await readAccessForEmail(coveredIds, eventLookups);
        for (const access of coveredAccess) {
          sponsoredItems.push(
            sponsoredItemHtml(access.name, access.price, currency, language),
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
        currency,
        language,
      );
    }
  }

  return context;
}

// fullName when the registration carries no name at all.
const UNNAMED_REGISTRANT: Record<LanguageCode, string> = {
  fr: "Participant",
  en: "Registrant",
  ar: "المشارك",
};

// =============================================================================
// SAMPLE DATA FOR PREVIEW / TEST-SEND
// =============================================================================

/**
 * The sample registration's id: a valid UUID, so a test send can attach a
 * real check-in QR code built from it.
 */
export const SAMPLE_REGISTRATION_ID = "5a7c3e91-2b4d-4f6a-8c1e-9d0b2a4c6e8f";

/** Sample values, with dates and labels in the event's form language. */
export function getSampleEmailContext(language: LanguageCode): EmailContext {
  // Noon UTC keeps the sample's calendar day in any server timezone.
  const money = (amount: number) => formatCurrency(amount, "TND", language);
  return {
    firstName: "John",
    lastName: "Doe",
    fullName: "John Doe",
    email: "john.doe@example.com",
    phone: "+216 12 345 678",
    registrationDate: formatDate("2025-03-15T12:00:00Z", language),
    registrationId: SAMPLE_REGISTRATION_ID,
    registrationNumber: formatRegistrationNumber(SAMPLE_REGISTRATION_ID),

    eventName: "Medical Conference 2025",
    eventDate: formatDate("2025-04-20T12:00:00Z", language),
    eventEndDate: formatDate("2025-04-22T12:00:00Z", language),
    eventDateRange: formatDateRange(
      "2025-04-20T12:00:00Z",
      "2025-04-22T12:00:00Z",
      language,
    ),
    eventLocation: "Tunis, Tunisia",
    eventDescription: "Annual medical conference",

    totalAmount: money(250),
    paidAmount: money(250),
    amountDue: money(0),
    paymentStatus: formatPaymentStatus("PAID", language),
    paymentMethod: formatPaymentMethod("BANK_TRANSFER", language),

    selectedAccess: "Workshop A, Gala Dinner",
    selectedWorkshops: "Workshop A",
    selectedDinners: "Gala Dinner",

    registrationLink: `https://events.example.com/registration/${SAMPLE_REGISTRATION_ID}/sample-token`,
    editRegistrationLink: `https://events.example.com/registration/${SAMPLE_REGISTRATION_ID}/sample-token`,
    paymentLink: `https://events.example.com/payment/${SAMPLE_REGISTRATION_ID}/sample-token`,

    organizerName: "Medical Events Co.",
    organizerEmail: "contact@medicalevents.com",
    organizerPhone: "+216 71 123 456",

    bankName: "Banque de Tunisie",
    bankAccountName: "Medical Events SARL",
    bankAccountNumber: "TN59 1234 5678 9012 3456 7890",

    sponsorshipCode: "SAMPLE-CODE",
    sponsorshipAmount: money(150),
    labName: "Laboratoire Exemple",
    sponsoredItems: bulletListHtml([
      sponsoredItemHtml(basePriceItemLabel(language), 100, "TND", language),
      sponsoredItemHtml("Workshop A", 50, "TND", language),
    ]),

    certificateCount: "2",
    certificateList: "Attendance Certificate, Speaker Certificate",
  };
}
