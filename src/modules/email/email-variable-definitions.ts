// =============================================================================
// EMAIL VARIABLE DEFINITIONS
// Base variable list and dynamic form-field variable discovery
// =============================================================================

import { prisma } from "@/database/client.js";
import type { VariableDefinition } from "./email.types.js";

export const BASE_VARIABLES: VariableDefinition[] = [
  // Registration
  {
    id: "firstName",
    label: "First Name",
    category: "registration",
    description: "Registrant first name",
    example: "John",
  },
  {
    id: "lastName",
    label: "Last Name",
    category: "registration",
    description: "Registrant last name",
    example: "Doe",
  },
  {
    id: "fullName",
    label: "Full Name",
    category: "registration",
    description: "First and last name combined",
    example: "John Doe",
  },
  {
    id: "email",
    label: "Email",
    category: "registration",
    description: "Registrant email address",
    example: "john@example.com",
  },
  {
    id: "phone",
    label: "Phone",
    category: "registration",
    description: "Registrant phone number",
    example: "+216 12 345 678",
  },
  {
    id: "registrationDate",
    label: "Registration Date",
    category: "registration",
    description: "Date of registration",
    example: "March 15, 2025",
  },

  // Event
  {
    id: "eventName",
    label: "Event Name",
    category: "event",
    description: "Name of the event",
    example: "Medical Conference 2025",
  },
  {
    id: "eventDate",
    label: "Event Date",
    category: "event",
    description: "Start date of event",
    example: "April 20, 2025",
  },
  {
    id: "eventEndDate",
    label: "Event End Date",
    category: "event",
    description: "End date of event",
    example: "April 22, 2025",
  },
  {
    id: "eventLocation",
    label: "Event Location",
    category: "event",
    description: "Event venue/location",
    example: "Tunis, Tunisia",
  },

  // Payment
  {
    id: "totalAmount",
    label: "Total Amount",
    category: "payment",
    description: "Total registration cost",
    example: "250 TND",
  },
  {
    id: "paidAmount",
    label: "Paid Amount",
    category: "payment",
    description: "Amount already paid",
    example: "250 TND",
  },
  {
    id: "amountDue",
    label: "Amount Due",
    category: "payment",
    description: "Remaining amount to pay",
    example: "0 TND",
  },
  {
    id: "paymentStatus",
    label: "Payment Status",
    category: "payment",
    description: "Current payment status",
    example: "Confirmed",
  },

  // Access
  {
    id: "selectedAccess",
    label: "Selected Access",
    category: "access",
    description: "All selected workshops, dinners, etc.",
    example: "Workshop A, Gala Dinner",
  },

  // Links
  {
    id: "registrationLink",
    label: "Registration Link",
    category: "links",
    description: "Link to view registration",
    example: "https://...",
  },
  {
    id: "editRegistrationLink",
    label: "Edit Registration Link",
    category: "links",
    description: "Link to edit registration",
    example: "https://...",
  },
  {
    id: "paymentLink",
    label: "Payment Link",
    category: "links",
    description: "Link to payment page",
    example: "https://...",
  },

  // Organization
  {
    id: "organizerName",
    label: "Organizer Name",
    category: "event",
    description: "Name of organizing company",
    example: "Medical Events Co.",
  },
  {
    id: "organizerEmail",
    label: "Organizer Email",
    category: "event",
    description: "Contact email",
    example: "contact@events.com",
  },
  {
    id: "organizerPhone",
    label: "Organizer Phone",
    category: "event",
    description: "Contact phone",
    example: "+216 71 123 456",
  },

  // Bank Details
  {
    id: "bankName",
    label: "Bank Name",
    category: "bank",
    description: "Name of the bank",
    example: "Banque de Tunisie",
  },
  {
    id: "bankAccountName",
    label: "Account Holder",
    category: "bank",
    description: "Name on the bank account",
    example: "Medical Events SARL",
  },
  {
    id: "bankAccountNumber",
    label: "Account Number",
    category: "bank",
    description: "Bank account number/IBAN",
    example: "TN59 1234 5678 9012 3456 7890",
  },

  // Sponsorship
  {
    id: "labName",
    label: "Lab Name",
    category: "sponsorship",
    description: "Name of the sponsoring laboratory",
    example: "Roche Diagnostics Tunisia",
  },
  {
    id: "labContactName",
    label: "Lab Contact Name",
    category: "sponsorship",
    description: "Lab contact person name",
    example: "Jean Dupont",
  },
  {
    id: "labEmail",
    label: "Lab Email",
    category: "sponsorship",
    description: "Lab contact email",
    example: "contact@roche.tn",
  },
  {
    id: "sponsorshipCode",
    label: "Sponsorship Code",
    category: "sponsorship",
    description: "Unique sponsorship code",
    example: "SP-A3B9",
  },
  {
    id: "sponsorshipAmount",
    label: "Sponsorship Amount",
    category: "sponsorship",
    description: "Total amount covered by sponsorship",
    example: "450 TND",
  },
  {
    id: "beneficiaryName",
    label: "Beneficiary Name",
    category: "sponsorship",
    description: "Name of the sponsored doctor",
    example: "Dr. Ahmed Salah",
  },
  {
    id: "beneficiaryCount",
    label: "Beneficiary Count",
    category: "sponsorship",
    description: "Number of doctors sponsored in batch",
    example: "3",
  },
  {
    id: "totalBatchAmount",
    label: "Total Batch Amount",
    category: "sponsorship",
    description: "Total amount of all sponsorships in batch",
    example: "1,350 TND",
  },
  {
    id: "beneficiaryList",
    label: "Beneficiary List",
    category: "sponsorship",
    description: "List of all doctors and amounts in batch",
    example: "- Dr. Ahmed: 450 TND\n- Dr. Sarah: 450 TND",
  },
  {
    id: "sponsoredItems",
    label: "Sponsored Items",
    category: "sponsorship",
    description: "List of items covered by sponsorship",
    example: "- Base registration: 200 TND\n- Workshop A: 50 TND",
  },
  {
    id: "remainingAmount",
    label: "Remaining Amount",
    category: "sponsorship",
    description: "Amount remaining after sponsorship",
    example: "150 TND",
  },
];

// =============================================================================
// GET AVAILABLE VARIABLES (includes dynamic form fields)
// =============================================================================

export async function getAvailableVariables(
  eventId: string,
): Promise<VariableDefinition[]> {
  const variables = [...BASE_VARIABLES];

  // Get form schema to extract field-based variables
  const form = await prisma.form.findFirst({
    where: { eventId, type: "REGISTRATION" },
    select: { schema: true },
  });

  if (form?.schema) {
    const schema = form.schema as {
      steps?: Array<{
        fields?: Array<{ id: string; label?: string; type: string }>;
      }>;
    };

    if (schema.steps) {
      for (const step of schema.steps) {
        for (const field of step.fields || []) {
          // Skip non-data fields
          if (["heading", "paragraph", "divider"].includes(field.type))
            continue;

          variables.push({
            id: `form_${field.id}`,
            label: field.label || field.id,
            category: "form",
            description: `Form field: ${field.label || field.id}`,
            example: getExampleForFieldType(field.type),
          });
        }
      }
    }
  }

  return variables;
}

function getExampleForFieldType(type: string): string {
  const examples: Record<string, string> = {
    text: "Sample text",
    email: "user@example.com",
    phone: "+216 12 345 678",
    number: "42",
    date: "March 15, 2025",
    dropdown: "Option A",
    radio: "Selected option",
    checkbox: "Yes",
    textarea: "Long text content...",
    file: "[Uploaded file]",
  };
  return examples[type] || "Value";
}
