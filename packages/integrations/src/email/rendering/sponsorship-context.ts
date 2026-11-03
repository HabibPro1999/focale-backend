// =============================================================================
// SPONSORSHIP EMAIL CONTEXT BUILDERS (pure — inputs pre-fetched by callers)
// =============================================================================

import { calculateSettlement } from "@app/shared";
import type { LanguageCode } from "@app/contracts";
import type { EmailContext } from "./types";
import { buildRegistrationSelfLinks } from "./context";
import {
  basePriceItemLabel,
  bulletListHtml,
  formatCurrency,
  formatPaymentStatus,
  labelWithColon,
  sponsoredItemHtml,
} from "./format";
import { formatDate, formatDateRange } from "./locale";
import { sanitizeForHtml } from "./resolve";

// Both builders take `language`: the primary language of the event's
// registration form, read by their callers (getRegistrationFormLanguage).

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
    endDate: Date;
    location: string | null;
    client: { name: string };
  };
  currency: string;
  language: LanguageCode;
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
    endDate: Date;
    location: string | null;
    client: { name: string };
  };
  pricing: { basePrice: number } | null;
  accessItems: Array<{ id: string; name: string; price: number }>;
  currency: string;
  language: LanguageCode;
}

/** Lab-confirmation email context (SPONSORSHIP_BATCH_SUBMITTED). */
export function buildBatchEmailContext(
  input: BatchEmailContextInput,
): Partial<EmailContext> {
  const { batch, sponsorships, event, currency, language } = input;
  const totalAmount = sponsorships.reduce((sum, s) => sum + s.totalAmount, 0);
  const money = (amount: number) => formatCurrency(amount, currency, language);

  return {
    eventName: event.name,
    eventDate: formatDate(event.startDate, language),
    eventEndDate: formatDate(event.endDate, language),
    eventDateRange: formatDateRange(event.startDate, event.endDate, language),
    eventLocation: event.location || "",
    organizerName: event.client.name,

    labName: batch.labName,
    labContactName: batch.contactName,
    labEmail: batch.email,

    beneficiaryCount: String(sponsorships.length),
    totalBatchAmount: money(totalAmount),

    beneficiaryList: bulletListHtml(
      sponsorships.map(
        (s) =>
          `<b>${sanitizeForHtml(s.beneficiaryName)}</b> ${sanitizeForHtml(labelWithColon(`(${s.beneficiaryEmail})`, language))} ${sanitizeForHtml(money(s.totalAmount))}`,
      ),
    ),

    firstName: batch.contactName.split(" ")[0] || batch.contactName,
    lastName: batch.contactName.split(" ").slice(1).join(" ") || "",
    fullName: batch.contactName,
    email: batch.email,
    phone: batch.phone || "",
    registrationDate: formatDate(new Date(), language),
    registrationId: "",
    registrationNumber: "",
    eventDescription: "",
    totalAmount: money(totalAmount),
    paidAmount: money(0),
    amountDue: money(totalAmount),
    paymentStatus: "",
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
  const {
    sponsorship,
    registration,
    event,
    pricing,
    accessItems,
    currency,
    language,
  } = input;
  const money = (amount: number) => formatCurrency(amount, currency, language);

  const sponsoredItems: string[] = [];
  if (sponsorship.coversBasePrice) {
    const basePrice = registration.baseAmount ?? pricing?.basePrice ?? 0;
    sponsoredItems.push(
      sponsoredItemHtml(basePriceItemLabel(language), basePrice, currency, language),
    );
  }
  for (const accessId of sponsorship.coveredAccessIds) {
    const access = accessItems.find((a) => a.id === accessId);
    if (access) {
      sponsoredItems.push(
        sponsoredItemHtml(access.name, access.price, currency, language),
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
    registrationDate: formatDate(new Date(), language),
    registrationId: registration.id,
    registrationNumber: registration.id.slice(0, 8).toUpperCase(),

    eventName: event.name,
    eventDate: formatDate(event.startDate, language),
    eventEndDate: formatDate(event.endDate, language),
    eventDateRange: formatDateRange(event.startDate, event.endDate, language),
    eventLocation: event.location || "",
    eventDescription: "",
    organizerName: event.client.name,
    organizerEmail: "",
    organizerPhone: "",

    totalAmount: money(registration.totalAmount),
    paidAmount: money(isFullySponsored ? registration.totalAmount : 0),
    amountDue: money(remainingAmount),
    paymentStatus: formatPaymentStatus(
      isFullySponsored ? "PAID" : "PENDING",
      language,
    ),
    paymentMethod: "",

    selectedAccess: "",
    selectedWorkshops: "",
    selectedDinners: "",

    ...selfLinks,

    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",

    sponsorshipCode: sponsorship.code,
    sponsorshipAmount: money(input.amountApplied),
    labName: sponsorship.batch.labName,
    labContactName: sponsorship.batch.contactName,
    labEmail: sponsorship.batch.email,
    beneficiaryName: sponsorship.beneficiaryName,
    sponsoredItems: bulletListHtml(sponsoredItems),
    remainingAmount: money(remainingAmount),
  };
}
