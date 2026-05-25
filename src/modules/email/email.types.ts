// =============================================================================
// PRISMA PAYLOAD TYPES
// =============================================================================

import type { Prisma } from "@/generated/prisma/client.js";

export type RegistrationWithRelations = Prisma.RegistrationGetPayload<{
  include: {
    event: {
      include: { client: true };
    };
    form: true;
  };
}>;

// =============================================================================
// TIPTAP DOCUMENT STRUCTURE
// =============================================================================

export interface TiptapDocument {
  type: "doc";
  content: TiptapNode[];
}

export interface TiptapNode {
  type: string; // 'paragraph', 'heading', 'text', 'mention', etc.
  attrs?: Record<string, unknown>;
  marks?: TiptapMark[];
  content?: TiptapNode[];
  text?: string;
}

export interface TiptapMark {
  type: string; // 'bold', 'italic', 'textStyle', 'link', etc.
  attrs?: Record<string, unknown>;
}

// =============================================================================
// EMAIL CONTEXT (Variables)
// =============================================================================

export interface EmailContext {
  // Base registration fields
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;

  // Payment information
  totalAmount: string; // Formatted: "250 TND"
  paidAmount: string; // Formatted: "250 TND"
  amountDue: string; // Formatted: "0 TND"
  paymentStatus: string; // Human readable: "Confirmed", "Pending"
  paymentMethod: string; // "Bank Transfer", "Online", etc.

  // Event information
  eventName: string;
  eventDate: string; // Formatted date
  eventEndDate: string; // Formatted date
  eventLocation: string;
  eventDescription: string;

  // Registration metadata
  registrationId: string;
  registrationDate: string; // Formatted date
  registrationNumber: string; // Sequential number if applicable

  // Access/workshop selections
  selectedAccess: string; // Comma-separated list
  selectedWorkshops: string; // Filtered to workshops only
  selectedDinners: string; // Filtered to dinners only

  // Dynamic form fields (flattened from formData)
  // e.g., form_specialty, form_institution, form_dietary_requirements
  [key: `form_${string}`]: string;

  // Action links
  registrationLink: string;
  editRegistrationLink: string;
  paymentLink: string;

  // Client/Organization
  organizerName: string;
  organizerEmail: string;
  organizerPhone: string;

  // Bank Details
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;

  // Certificate fields (optional - only present in CERTIFICATE_SENT emails)
  certificateCount?: string;
  certificateList?: string;

  // Sponsorship fields (optional - only present in sponsorship-related emails)
  labName?: string;
  labContactName?: string;
  labEmail?: string;
  sponsorshipCode?: string;
  sponsorshipAmount?: string;
  beneficiaryName?: string;
  beneficiaryCount?: string;
  totalBatchAmount?: string;
  beneficiaryList?: string;
  sponsoredItems?: string;
  remainingAmount?: string;
}

// =============================================================================
// MJML COMPILATION RESULT
// =============================================================================

export interface MjmlCompilationResult {
  html: string;
  errors: Array<{ message: string; line: number }>;
}

// =============================================================================
// VARIABLE DEFINITIONS
// =============================================================================

export interface VariableDefinition {
  id: string;
  label: string;
  category:
    | "registration"
    | "event"
    | "payment"
    | "access"
    | "form"
    | "links"
    | "bank"
    | "sponsorship"
    | "certificate"
    | "abstract";
  description?: string;
  example?: string;
}
