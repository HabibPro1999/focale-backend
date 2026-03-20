// =============================================================================
// EMAIL CONTEXT
// Builds EmailContext from registration data and resolves template variables
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
// BUILD EMAIL CONTEXT FROM REGISTRATION
// =============================================================================

export function buildEmailContext(
  registration: RegistrationWithRelations,
): EmailContext {
  const formData = (registration.formData as Record<string, unknown>) || {};

  // Use dynamic linkBaseUrl (captured from browser at registration) or fallback to env
  const baseUrl =
    registration.linkBaseUrl ||
    process.env.PUBLIC_FORMS_URL ||
    "https://events.example.com";

  // Get event slug for URL paths
  const slug = registration.event.slug || "";

  // Use actual edit token for secure links
  const token = registration.editToken || "";

  // Build base context
  const context: EmailContext = {
    // Registration
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

    // Event
    eventName: registration.event.name,
    eventDate: formatDate(registration.event.startDate),
    eventEndDate: formatDate(registration.event.endDate),
    eventLocation: registration.event.location || "",
    eventDescription: registration.event.description || "",

    // Payment
    totalAmount: formatCurrency(
      registration.totalAmount,
      registration.currency,
    ),
    paidAmount: formatCurrency(registration.paidAmount, registration.currency),
    amountDue: formatCurrency(
      registration.totalAmount -
        (registration.sponsorshipAmount || 0) -
        registration.paidAmount,
      registration.currency,
    ),
    paymentStatus: formatPaymentStatus(registration.paymentStatus),
    paymentMethod: registration.paymentMethod || "",

    // Access (will be enriched below)
    selectedAccess: "",
    selectedWorkshops: "",
    selectedDinners: "",

    // Links with event slug and secure edit token
    registrationLink: `${baseUrl}/${slug}/registration/${registration.id}/${token}`,
    editRegistrationLink: `${baseUrl}/${slug}/registration/${registration.id}/${token}`,
    paymentLink: `${baseUrl}/${slug}/payment/${registration.id}/${token}`,

    // Organization
    organizerName: registration.event.client.name,
    organizerEmail: registration.event.client.email || "",
    organizerPhone: registration.event.client.phone || "",

    // Bank Details (populated in buildEmailContextWithAccess)
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
  };

  // Add dynamic form fields
  for (const [key, value] of Object.entries(formData)) {
    context[`form_${key}` as keyof EmailContext] = formatFieldValue(value);
  }

  return context;
}

// Build context with access type names resolved
export async function buildEmailContextWithAccess(
  registration: RegistrationWithRelations,
): Promise<EmailContext> {
  const context = buildEmailContext(registration);

  // Fetch pricing for bank details and base price (used for sponsorship items)
  const pricing = await prisma.eventPricing.findUnique({
    where: { eventId: registration.eventId },
    select: {
      bankName: true,
      bankAccountName: true,
      bankAccountNumber: true,
      basePrice: true,
    },
  });

  if (pricing) {
    context.bankName = pricing.bankName || "";
    context.bankAccountName = pricing.bankAccountName || "";
    context.bankAccountNumber = pricing.bankAccountNumber || "";
  }

  // Resolve access type IDs to names
  if (registration.accessTypeIds && registration.accessTypeIds.length > 0) {
    const accessTypes = await prisma.eventAccess.findMany({
      where: { id: { in: registration.accessTypeIds } },
      select: { id: true, name: true, type: true },
    });

    const accessMap = new Map(accessTypes.map((a) => [a.id, a]));
    const selectedNames = registration.accessTypeIds
      .map((id) => accessMap.get(id)?.name)
      .filter(Boolean) as string[];

    context.selectedAccess = selectedNames.join(", ");

    // Filter by type
    context.selectedWorkshops = accessTypes
      .filter((a) => a.type === "WORKSHOP")
      .map((a) => a.name)
      .join(", ");

    context.selectedDinners = accessTypes
      .filter((a) => a.type === "DINNER")
      .map((a) => a.name)
      .join(", ");
  }

  // Resolve sponsorship data if this registration is linked to a sponsorship
  if (registration.sponsorshipCode) {
    const sponsorship = await prisma.sponsorship.findFirst({
      where: {
        code: registration.sponsorshipCode,
        eventId: registration.eventId,
      },
      include: {
        batch: {
          select: {
            labName: true,
            contactName: true,
            email: true,
          },
        },
      },
    });

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

      // Build sponsored items list (HTML — variable is in HTML_SAFE_VARIABLES)
      const sponsoredItems: string[] = [];
      if (sponsorship.coversBasePrice && pricing) {
        sponsoredItems.push(
          `<b>Inscription de base :</b> ${sanitizeForHtml(formatCurrency(pricing.basePrice, registration.currency))}`,
        );
      }

      if (
        sponsorship.coveredAccessIds &&
        sponsorship.coveredAccessIds.length > 0
      ) {
        const coveredAccess = await prisma.eventAccess.findMany({
          where: { id: { in: sponsorship.coveredAccessIds } },
          select: { name: true, price: true },
        });
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

// Variables that contain server-generated HTML (not user input) and skip sanitization
const HTML_SAFE_VARIABLES = new Set(["sponsoredItems", "beneficiaryList"]);

export function resolveVariables(
  template: string,
  context: EmailContext,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, varId) => {
    const value = context[varId as keyof EmailContext];

    if (value !== undefined && value !== null && value !== "") {
      // Server-generated HTML variables skip sanitization
      if (HTML_SAFE_VARIABLES.has(varId)) {
        return String(value);
      }
      return sanitizeForHtml(String(value));
    }

    // Return empty string for undefined variables
    return "";
  });
}

// =============================================================================
// XSS SANITIZATION
// =============================================================================

export function sanitizeForHtml(value: unknown): string {
  if (value === null || value === undefined) return "";

  const str = String(value);

  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function sanitizeUrl(url: string): string {
  const trimmed = url.trim().toLowerCase();

  // Block dangerous protocols
  if (
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("vbscript:")
  ) {
    return "#blocked";
  }

  return url;
}

// =============================================================================
// FORMATTING HELPERS
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
  return `${amount.toLocaleString("fr-TN")} ${currency}`;
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

// =============================================================================
// SAMPLE DATA FOR PREVIEW
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
  };
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

/**
 * Build email context for lab confirmation email (SPONSORSHIP_BATCH_SUBMITTED)
 */
export function buildBatchEmailContext(
  input: BatchEmailContextInput,
): Partial<EmailContext> {
  const { batch, sponsorships, event, currency } = input;
  const totalAmount = sponsorships.reduce((sum, s) => sum + s.totalAmount, 0);

  return {
    // Event info
    eventName: event.name,
    eventDate: formatDate(event.startDate),
    eventLocation: event.location || "",
    organizerName: event.client.name,

    // Lab info
    labName: batch.labName,
    labContactName: batch.contactName,
    labEmail: batch.email,

    // Batch summary
    beneficiaryCount: String(sponsorships.length),
    totalBatchAmount: formatCurrency(totalAmount, currency),

    // Beneficiary list (for lab email)
    beneficiaryList: sponsorships
      .map(
        (s) =>
          `<div style="padding: 4px 0;">• <b>${sanitizeForHtml(s.beneficiaryName)}</b> (${sanitizeForHtml(s.beneficiaryEmail)}) : ${sanitizeForHtml(formatCurrency(s.totalAmount, currency))}</div>`,
      )
      .join(""),

    // Default placeholders for required fields
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

/**
 * Build email context for doctor notification (SPONSORSHIP_LINKED or SPONSORSHIP_APPLIED)
 */
export function buildLinkedSponsorshipContext(
  input: LinkedSponsorshipContextInput,
): Partial<EmailContext> {
  const { sponsorship, registration, event, pricing, accessItems, currency } =
    input;

  // Build sponsored items list (HTML — variable is in HTML_SAFE_VARIABLES)
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

  // Calculate remaining
  const remainingAmount =
    registration.totalAmount - registration.sponsorshipAmount;

  // Build links
  const baseUrl =
    registration.linkBaseUrl ||
    process.env.PUBLIC_FORMS_URL ||
    "https://events.example.com";
  const token = registration.editToken || "";

  const isFullySponsored =
    registration.sponsorshipAmount >= registration.totalAmount;

  return {
    // Registration info
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

    // Event info
    eventName: event.name,
    eventDate: formatDate(event.startDate),
    eventEndDate: "",
    eventLocation: event.location || "",
    eventDescription: "",
    organizerName: event.client.name,
    organizerEmail: "",
    organizerPhone: "",

    // Payment info
    totalAmount: formatCurrency(registration.totalAmount, currency),
    paidAmount: isFullySponsored
      ? formatCurrency(registration.totalAmount, currency)
      : "0 " + currency,
    amountDue: formatCurrency(remainingAmount, currency),
    paymentStatus: isFullySponsored ? "Paid" : "Pending",
    paymentMethod: "",

    // Access
    selectedAccess: "",
    selectedWorkshops: "",
    selectedDinners: "",

    // Links
    registrationLink: `${baseUrl}/${event.slug}/registration/${registration.id}/${token}`,
    editRegistrationLink: `${baseUrl}/${event.slug}/registration/${registration.id}/${token}`,
    paymentLink: `${baseUrl}/${event.slug}/payment/${registration.id}/${token}`,

    // Bank details (empty - can be filled in if needed)
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",

    // Sponsorship info
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
