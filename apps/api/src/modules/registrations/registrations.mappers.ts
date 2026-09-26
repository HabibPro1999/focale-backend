import type { PriceBreakdown } from "@app/contracts";
import type {
  AccessSelectionItem,
  DroppedAccessSelectionItem,
} from "./registrations.enrichment";

// ============================================================================
// Admin responses
// ============================================================================

/**
 * Fields no admin response carries: the registrant's self-edit credential and
 * the public-create idempotency key (a create retry with that key replays the
 * response, edit token included). Admins get a self-edit link only through the
 * audited GET /api/registrations/:id/edit-link.
 */
type AdminHiddenField = "editToken" | "idempotencyKey";

export type AdminView<T> = Omit<T, AdminHiddenField>;

export function toAdminRegistration<T extends object>(registration: T): AdminView<T> {
  const safe = { ...registration } as Record<string, unknown>;
  delete safe.editToken;
  delete safe.idempotencyKey;
  return safe as AdminView<T>;
}

// ============================================================================
// Public (registrant) responses — explicit allowlist
// ============================================================================

export interface PublicRegistrationForm {
  id: string;
  name: string;
  /** Present on GET-for-edit only (the form renders the edit page from it). */
  schema?: unknown;
}

export interface PublicRegistrationEvent {
  id: string;
  name: string;
  slug: string;
  status?: string;
  endDate?: Date;
}

/** Everything the public DTO may read; extra source fields are ignored. */
export interface PublicRegistrationSource {
  id: string;
  formId: string;
  eventId: string;
  referenceNumber: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  formData: unknown;
  networkingOptIn: boolean | null;
  paymentStatus: string;
  paymentMethod: string | null;
  labName: string | null;
  currency: string;
  totalAmount: number;
  paidAmount: number;
  baseAmount: number;
  discountAmount: number;
  accessAmount: number;
  sponsorshipCode: string | null;
  sponsorshipAmount: number;
  priceBreakdown: PriceBreakdown;
  paymentProofUrl: string | null;
  paidAt: Date | null;
  submittedAt: Date;
  lastEditedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  accessSelections: AccessSelectionItem[];
  droppedAccessSelections?: DroppedAccessSelectionItem[];
  form: PublicRegistrationForm;
  event: PublicRegistrationEvent;
}

/**
 * The registrant-facing registration. Never carries admin/internal fields
 * (note, role, check-in data, payment reference, idempotency key, link base
 * URL, stored proof location, access-id arrays, tenant id). `token` (the
 * registrant's own edit token) is present only on the create response.
 */
export interface PublicRegistration {
  id: string;
  formId: string;
  eventId: string;
  referenceNumber: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  formData: unknown;
  networkingOptIn: boolean | null;
  paymentStatus: string;
  paymentMethod: string | null;
  labName: string | null;
  currency: string;
  totalAmount: number;
  paidAmount: number;
  baseAmount: number;
  discountAmount: number;
  accessAmount: number;
  sponsorshipCode: string | null;
  sponsorshipAmount: number;
  priceBreakdown: PriceBreakdown;
  hasPaymentProof: boolean;
  paidAt: Date | null;
  submittedAt: Date;
  lastEditedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  accessSelections: AccessSelectionItem[];
  droppedAccessSelections?: DroppedAccessSelectionItem[];
  form: PublicRegistrationForm;
  event: PublicRegistrationEvent;
  token?: string | null;
}

export function toPublicRegistration(
  registration: PublicRegistrationSource,
  options: { token?: string | null } = {},
): PublicRegistration {
  const { form, event } = registration;
  const dto: PublicRegistration = {
    id: registration.id,
    formId: registration.formId,
    eventId: registration.eventId,
    referenceNumber: registration.referenceNumber,
    email: registration.email,
    firstName: registration.firstName,
    lastName: registration.lastName,
    phone: registration.phone,
    formData: registration.formData,
    networkingOptIn: registration.networkingOptIn,
    paymentStatus: registration.paymentStatus,
    paymentMethod: registration.paymentMethod,
    labName: registration.labName,
    currency: registration.currency,
    totalAmount: registration.totalAmount,
    paidAmount: registration.paidAmount,
    baseAmount: registration.baseAmount,
    discountAmount: registration.discountAmount,
    accessAmount: registration.accessAmount,
    sponsorshipCode: registration.sponsorshipCode,
    sponsorshipAmount: registration.sponsorshipAmount,
    priceBreakdown: registration.priceBreakdown,
    hasPaymentProof: Boolean(registration.paymentProofUrl),
    paidAt: registration.paidAt,
    submittedAt: registration.submittedAt,
    lastEditedAt: registration.lastEditedAt,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
    accessSelections: registration.accessSelections,
    form: {
      id: form.id,
      name: form.name,
      ...(form.schema !== undefined ? { schema: form.schema } : {}),
    },
    event: {
      id: event.id,
      name: event.name,
      slug: event.slug,
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.endDate !== undefined ? { endDate: event.endDate } : {}),
    },
  };
  if (registration.droppedAccessSelections !== undefined) {
    dto.droppedAccessSelections = registration.droppedAccessSelections;
  }
  if (options.token !== undefined) dto.token = options.token;
  return dto;
}
