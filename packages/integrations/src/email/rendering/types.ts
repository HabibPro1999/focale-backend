// =============================================================================
// EMAIL RENDERING TYPES
// =============================================================================

export type { TiptapDocument, TiptapNode, TiptapMark } from "@app/contracts";

export interface EmailContext {
  // Base registration fields
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;

  // Payment information
  totalAmount: string;
  paidAmount: string;
  amountDue: string;
  paymentStatus: string;
  paymentMethod: string;

  // Event information
  eventName: string;
  eventDate: string;
  eventEndDate: string;
  eventLocation: string;
  eventDescription: string;

  // Registration metadata
  registrationId: string;
  registrationDate: string;
  registrationNumber: string;

  // Access/workshop selections
  selectedAccess: string;
  selectedWorkshops: string;
  selectedDinners: string;

  // Dynamic form fields (flattened from formData)
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

  // Certificate fields (optional)
  certificateCount?: string;
  certificateList?: string;

  // Sponsorship fields (optional)
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

export interface MjmlCompilationResult {
  html: string;
  errors: Array<{ message: string; line: number }>;
}

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
