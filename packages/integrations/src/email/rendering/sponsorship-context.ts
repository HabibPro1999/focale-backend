// =============================================================================
// SPONSORSHIP EMAIL CONTEXT BUILDERS (pure — inputs pre-fetched by callers)
// =============================================================================

import { calculateSettlement } from "@app/shared";
import type { LanguageCode } from "@app/contracts";
import type { EmailContext } from "./types";
import { buildRegistrationSelfLinks } from "./context";
import {
  BASE_PRICE_ITEM_LABEL,
  bulletListHtml,
  formatCurrency,
  sponsoredItemHtml,
} from "./format";
import { formatDate } from "./locale";
import { sanitizeForHtml } from "./resolve";

// Sponsorship contexts are built inside the sponsorship transactions, which do
// not load a form language yet, so their dates stay in English.
const SPONSORSHIP_EMAIL_LANGUAGE: LanguageCode = "en";

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

    beneficiaryList: bulletListHtml(
      sponsorships.map(
        (s) =>
          `<b>${sanitizeForHtml(s.beneficiaryName)}</b> (${sanitizeForHtml(s.beneficiaryEmail)}) : ${sanitizeForHtml(formatCurrency(s.totalAmount, currency))}`,
      ),
    ),

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
      sponsoredItemHtml(BASE_PRICE_ITEM_LABEL, basePrice, currency),
    );
  }
  for (const accessId of sponsorship.coveredAccessIds) {
    const access = accessItems.find((a) => a.id === accessId);
    if (access) {
      sponsoredItems.push(sponsoredItemHtml(access.name, access.price, currency));
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
    sponsoredItems: bulletListHtml(sponsoredItems),
    remainingAmount: formatCurrency(remainingAmount, currency),
  };
}
