// =============================================================================
// EMAIL CONTEXT SERVICE
// Builds EmailContext objects from registration and sponsorship data
// =============================================================================

import { prisma } from "@/database/client.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type { EmailContext } from "./email.types.js";

// Type for registration with all needed relations
type RegistrationWithRelations = Prisma.RegistrationGetPayload<{
  include: {
    event: {
      include: { client: true };
    };
    form: true;
  };
}>;

// =============================================================================
// FORMATTING HELPERS (private)
// =============================================================================

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatCurrency(amount: number, currency = "TND"): string {
  return `${amount.toLocaleString()} ${currency}`;
}

function formatPaymentStatus(status: string): string {
  const statusMap: Record<string, string> = {
    PENDING: "Pending",
    PAID: "Confirmed",
    REFUNDED: "Refunded",
    WAIVED: "Waived",
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

// Empty context baseline -- sponsorship builders spread from this
export const EMPTY_EMAIL_CONTEXT: EmailContext = {
  firstName: "", lastName: "", fullName: "", email: "", phone: "",
  registrationDate: "", registrationId: "", registrationNumber: "",
  eventName: "", eventDate: "", eventEndDate: "", eventLocation: "",
  eventDescription: "", totalAmount: "", paidAmount: "", amountDue: "",
  paymentStatus: "", paymentMethod: "", selectedAccess: "",
  selectedWorkshops: "", selectedDinners: "", registrationLink: "",
  editRegistrationLink: "", paymentLink: "", organizerName: "",
  organizerEmail: "", organizerPhone: "", bankName: "",
  bankAccountName: "", bankAccountNumber: "",
};

// =============================================================================
// BUILD EMAIL CONTEXT FROM REGISTRATION
// =============================================================================

function buildRegistrationLinks(
  registration: RegistrationWithRelations,
): { registrationLink: string; editRegistrationLink: string; paymentLink: string } {
  const baseUrl =
    registration.linkBaseUrl ||
    process.env.PUBLIC_FORMS_URL ||
    "https://events.example.com";
  const slug = registration.event.slug || "";
  const token = registration.editToken || "";
  return {
    registrationLink: `${baseUrl}/${slug}/registration/${registration.id}/${token}`,
    editRegistrationLink: `${baseUrl}/${slug}/registration/${registration.id}/${token}`,
    paymentLink: `${baseUrl}/${slug}/payment/${registration.id}/${token}`,
  };
}

export function buildEmailContext(
  registration: RegistrationWithRelations,
): EmailContext {
  const formData = (registration.formData as Record<string, unknown>) || {};
  const links = buildRegistrationLinks(registration);

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
    totalAmount: formatCurrency(registration.totalAmount, registration.currency),
    paidAmount: formatCurrency(registration.paidAmount, registration.currency),
    amountDue: formatCurrency(
      registration.totalAmount -
        (registration.sponsorshipAmount || 0) -
        registration.paidAmount,
      registration.currency,
    ),
    paymentStatus: formatPaymentStatus(registration.paymentStatus),
    paymentMethod: registration.paymentMethod || "",
    selectedAccess: "",
    selectedWorkshops: "",
    selectedDinners: "",
    ...links,
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

async function resolveAccessTypes(
  accessTypeIds: string[],
  context: EmailContext,
): Promise<void> {
  const accessTypes = await prisma.eventAccess.findMany({
    where: { id: { in: accessTypeIds } },
    select: { id: true, name: true, type: true },
  });

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

async function buildSponsoredItemsList(
  sponsorship: {
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    totalAmount: number;
  },
  pricing: { basePrice: number } | null,
  currency: string,
): Promise<string[]> {
  const sponsoredItems: string[] = [];
  if (sponsorship.coversBasePrice && pricing) {
    sponsoredItems.push(
      `- Base registration: ${formatCurrency(pricing.basePrice, currency)}`,
    );
  }
  if (sponsorship.coveredAccessIds && sponsorship.coveredAccessIds.length > 0) {
    const coveredAccess = await prisma.eventAccess.findMany({
      where: { id: { in: sponsorship.coveredAccessIds } },
      select: { name: true, price: true },
    });
    for (const access of coveredAccess) {
      sponsoredItems.push(
        `- ${access.name}: ${formatCurrency(access.price, currency)}`,
      );
    }
  }
  return sponsoredItems;
}

type PricingResult = {
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  basePrice: number;
} | null;

async function resolveSponsorshipData(
  registration: RegistrationWithRelations,
  pricing: PricingResult,
  context: EmailContext,
): Promise<void> {
  const sponsorship = await prisma.sponsorship.findFirst({
    where: { code: registration.sponsorshipCode!, eventId: registration.eventId },
    include: {
      batch: { select: { labName: true, contactName: true, email: true } },
    },
  });
  if (!sponsorship) return;

  context.sponsorshipCode = sponsorship.code;
  context.sponsorshipAmount = formatCurrency(sponsorship.totalAmount, registration.currency);
  context.labName = sponsorship.batch.labName;
  context.labContactName = sponsorship.batch.contactName;
  context.labEmail = sponsorship.batch.email;
  context.beneficiaryName = sponsorship.beneficiaryName;

  const sponsoredItems = await buildSponsoredItemsList(
    sponsorship,
    pricing,
    registration.currency,
  );
  context.sponsoredItems = sponsoredItems.join("\n");
  context.remainingAmount = formatCurrency(
    registration.totalAmount - sponsorship.totalAmount,
    registration.currency,
  );
}

// Build context with access type names and bank details resolved
export async function buildEmailContextWithAccess(
  registration: RegistrationWithRelations,
): Promise<EmailContext> {
  const context = buildEmailContext(registration);

  const pricing = await prisma.eventPricing.findUnique({
    where: { eventId: registration.eventId },
    select: { bankName: true, bankAccountName: true, bankAccountNumber: true, basePrice: true },
  });

  if (pricing) {
    context.bankName = pricing.bankName || "";
    context.bankAccountName = pricing.bankAccountName || "";
    context.bankAccountNumber = pricing.bankAccountNumber || "";
  }

  if (registration.accessTypeIds && registration.accessTypeIds.length > 0) {
    await resolveAccessTypes(registration.accessTypeIds, context);
  }

  if (registration.sponsorshipCode) {
    await resolveSponsorshipData(registration, pricing, context);
  }

  return context;
}

// =============================================================================
// SPONSORSHIP EMAIL CONTEXT BUILDERS
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

// Build email context for lab confirmation email (SPONSORSHIP_BATCH_SUBMITTED)
export function buildBatchEmailContext(
  input: BatchEmailContextInput,
): Partial<EmailContext> {
  const { batch, sponsorships, event, currency } = input;
  const totalAmount = sponsorships.reduce((sum, s) => sum + s.totalAmount, 0);

  return {
    ...EMPTY_EMAIL_CONTEXT,
    firstName: batch.contactName.split(" ")[0] || batch.contactName,
    lastName: batch.contactName.split(" ").slice(1).join(" ") || "",
    fullName: batch.contactName,
    email: batch.email,
    phone: batch.phone || "",
    registrationDate: formatDate(new Date()),
    eventName: event.name,
    eventDate: formatDate(event.startDate),
    eventLocation: event.location || "",
    organizerName: event.client.name,
    totalAmount: formatCurrency(totalAmount, currency),
    paidAmount: "0 " + currency,
    amountDue: formatCurrency(totalAmount, currency),
    paymentStatus: "N/A",
    labName: batch.labName,
    labContactName: batch.contactName,
    labEmail: batch.email,
    beneficiaryCount: String(sponsorships.length),
    totalBatchAmount: formatCurrency(totalAmount, currency),
    beneficiaryList: sponsorships
      .map(
        (s) =>
          `- ${s.beneficiaryName} (${s.beneficiaryEmail}): ${formatCurrency(s.totalAmount, currency)}`,
      )
      .join("\n"),
  };
}

function buildLinkedSponsoredItems(
  input: LinkedSponsorshipContextInput,
): string {
  const { sponsorship, pricing, accessItems, currency } = input;
  const sponsoredItems: string[] = [];
  if (sponsorship.coversBasePrice && pricing) {
    sponsoredItems.push(
      `- Base registration: ${formatCurrency(pricing.basePrice, currency)}`,
    );
  }
  for (const accessId of sponsorship.coveredAccessIds) {
    const access = accessItems.find((a) => a.id === accessId);
    if (access) {
      sponsoredItems.push(
        `- ${access.name}: ${formatCurrency(access.price, currency)}`,
      );
    }
  }
  return sponsoredItems.join("\n");
}

// Build email context for doctor notification (SPONSORSHIP_LINKED or SPONSORSHIP_APPLIED)
export function buildLinkedSponsorshipContext(
  input: LinkedSponsorshipContextInput,
): Partial<EmailContext> {
  const { sponsorship, registration, event, currency } = input;
  const remainingAmount = registration.totalAmount - registration.sponsorshipAmount;
  const baseUrl =
    registration.linkBaseUrl ||
    process.env.PUBLIC_FORMS_URL ||
    "https://events.example.com";
  const token = registration.editToken || "";

  return {
    ...EMPTY_EMAIL_CONTEXT,
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
    eventLocation: event.location || "",
    organizerName: event.client.name,
    totalAmount: formatCurrency(registration.totalAmount, currency),
    paidAmount: "0 " + currency,
    amountDue: formatCurrency(remainingAmount, currency),
    paymentStatus: "Pending",
    registrationLink: `${baseUrl}/${event.slug}/registration/${registration.id}/${token}`,
    editRegistrationLink: `${baseUrl}/${event.slug}/registration/${registration.id}/${token}`,
    paymentLink: `${baseUrl}/${event.slug}/payment/${registration.id}/${token}`,
    sponsorshipCode: sponsorship.code,
    sponsorshipAmount: formatCurrency(sponsorship.totalAmount, currency),
    labName: sponsorship.batch.labName,
    labContactName: sponsorship.batch.contactName,
    labEmail: sponsorship.batch.email,
    beneficiaryName: sponsorship.beneficiaryName,
    sponsoredItems: buildLinkedSponsoredItems(input),
    remainingAmount: formatCurrency(remainingAmount, currency),
  };
}
