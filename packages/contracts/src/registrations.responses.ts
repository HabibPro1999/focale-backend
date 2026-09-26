import { z } from "zod";
import {
  PaymentMethodSchema,
  PaymentStatusSchema,
  RegistrantSearchResultSchema,
  RegistrationRoleSchema,
} from "./registrations";

// ============================================================================
// Response contracts (plan 5.5): the `data` payload of each registration
// route. The API projects every response onto its contract, so a field that
// is not listed here never leaves the server. Dates are `Date` objects on the
// server and ISO 8601 strings on the wire. `formData`, `priceBreakdown` and
// the form `schema` are JSON documents the server stores as given; they stay
// opaque until the JSONB typing work (plan 5.2).
// ============================================================================

const PaginationMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
});

/** One selected access line, enriched with the access item's display fields. */
export const RegistrationAccessSelectionResponseSchema = z.object({
  id: z.string(),
  accessId: z.string(),
  unitPrice: z.number(),
  quantity: z.number(),
  subtotal: z.number(),
  access: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    startsAt: z.date().nullable(),
    endsAt: z.date().nullable(),
  }),
});

/** A selection dropped for capacity, with the reason. */
export const RegistrationDroppedAccessSelectionResponseSchema =
  RegistrationAccessSelectionResponseSchema.extend({ reason: z.string() });

// ============================================================================
// Public (registrant) routes
// ============================================================================

/**
 * The registrant-facing registration (0.5's allowlist). `token`, the
 * registrant's own edit token, is present on the create response only.
 */
export const PublicRegistrationResponseSchema = z.object({
  id: z.string(),
  formId: z.string(),
  eventId: z.string(),
  referenceNumber: z.string().nullable(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  formData: z.unknown(),
  networkingOptIn: z.boolean().nullable(),
  paymentStatus: z.string(),
  paymentMethod: z.string().nullable(),
  labName: z.string().nullable(),
  currency: z.string(),
  totalAmount: z.number(),
  paidAmount: z.number(),
  baseAmount: z.number(),
  discountAmount: z.number(),
  accessAmount: z.number(),
  sponsorshipCode: z.string().nullable(),
  sponsorshipAmount: z.number(),
  priceBreakdown: z.unknown(),
  hasPaymentProof: z.boolean(),
  paidAt: z.date().nullable(),
  submittedAt: z.date(),
  lastEditedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  accessSelections: z.array(RegistrationAccessSelectionResponseSchema),
  droppedAccessSelections: z
    .array(RegistrationDroppedAccessSelectionResponseSchema)
    .optional(),
  form: z.object({
    id: z.string(),
    name: z.string(),
    /** GET-for-edit only: the form renders the edit page from it. */
    schema: z.unknown().optional(),
  }),
  event: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string().optional(),
    endDate: z.date().optional(),
  }),
  token: z.string().nullable().optional(),
});

/** POST /api/public/forms/:formId/register (201 created, 200 idempotent replay). */
export const PublicRegistrationCreateResponseSchema = z.object({
  registration: PublicRegistrationResponseSchema,
  priceBreakdown: z.unknown(),
});

/** GET /api/public/registrations/:registrationId (edit token). */
export const PublicRegistrationForEditResponseSchema = z.object({
  registration: PublicRegistrationResponseSchema,
  expectedUpdatedAt: z.string(),
  canEdit: z.boolean(),
  canEditPersonalInfo: z.boolean(),
  canEditAccess: z.boolean(),
  canAddAccess: z.boolean(),
  canRemoveAccess: z.boolean(),
  isFullySponsored: z.boolean(),
  amountDue: z.number(),
  editRestrictions: z.array(z.string()),
});

/** PATCH /api/public/registrations/:registrationId (edit token). */
export const PublicRegistrationEditResponseSchema = z.object({
  registration: PublicRegistrationResponseSchema,
  priceBreakdown: z.unknown(),
});

/** PATCH /api/public/registrations/:registrationId/payment-method. */
export const PaymentMethodSelectedResponseSchema = z.object({
  success: z.boolean(),
});

/** POST /api/public/registrations/:registrationId/payment-proof. */
export const PaymentProofUploadResponseSchema = z.object({
  id: z.string(),
  registrationId: z.string(),
  fileUrl: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  uploadedAt: z.string(),
});

// ============================================================================
// Admin routes
// ============================================================================

/**
 * An admin registration: every column except the self-edit credential and
 * the public-create idempotency key (0.5), plus form/event metadata and the
 * enriched access selections. Check-ins come with the detail route only.
 */
export const AdminRegistrationResponseSchema = z.object({
  id: z.string(),
  formId: z.string(),
  eventId: z.string(),
  formData: z.unknown(),
  networkingOptIn: z.boolean().nullable(),
  submittedAt: z.date(),
  formSchemaVersion: z.number(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  referenceNumber: z.string().nullable(),
  paymentStatus: PaymentStatusSchema,
  totalAmount: z.number(),
  paidAmount: z.number(),
  currency: z.string(),
  paymentMethod: PaymentMethodSchema.nullable(),
  paymentReference: z.string().nullable(),
  paymentProofUrl: z.string().nullable(),
  priceBreakdown: z.unknown(),
  baseAmount: z.number(),
  discountAmount: z.number(),
  accessAmount: z.number(),
  sponsorshipCode: z.string().nullable(),
  sponsorshipAmount: z.number(),
  labName: z.string().nullable(),
  paidAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastEditedAt: z.date().nullable(),
  linkBaseUrl: z.string().nullable(),
  note: z.string().nullable(),
  role: RegistrationRoleSchema,
  accessTypeIds: z.array(z.string()).nullable(),
  droppedAccessIds: z.array(z.string()).nullable(),
  checkedInAt: z.date().nullable(),
  checkedInBy: z.string().nullable(),
  form: z.object({ id: z.string(), name: z.string() }),
  event: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    clientId: z.string(),
  }),
  accessCheckIns: z
    .array(z.object({ accessId: z.string(), checkedInAt: z.date() }))
    .optional(),
  accessSelections: z.array(RegistrationAccessSelectionResponseSchema),
  droppedAccessSelections: z.array(
    RegistrationDroppedAccessSelectionResponseSchema,
  ),
});

const AmountBucketSchema = z.object({ count: z.number(), amount: z.number() });

/** GET /api/events/:eventId/registrations. */
export const AdminRegistrationListResponseSchema = z.object({
  data: z.array(AdminRegistrationResponseSchema),
  meta: PaginationMetaSchema,
  stats: z.object({
    total: z.number(),
    totalAmount: z.number(),
    collected: z.number(),
    paid: AmountBucketSchema,
    pending: AmountBucketSchema,
    sponsored: AmountBucketSchema,
  }),
});

const TableColumnOptionResponseSchema = z.object({
  id: z.string(),
  label: z.string(),
});

/**
 * GET /api/events/:eventId/registrations/columns. Form columns carry the
 * field's own type and, for a "specify other" pair, the child field folded
 * into the column (`mergeWith`).
 */
export const RegistrationTableColumnsResponseSchema = z.object({
  formColumns: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      type: z.string(),
      options: z.array(TableColumnOptionResponseSchema).optional(),
      mergeWith: z
        .object({ fieldId: z.string(), triggerValue: z.string() })
        .optional(),
    }),
  ),
  fixedColumns: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      type: z.string(),
      options: z.array(TableColumnOptionResponseSchema).optional(),
    }),
  ),
});

/** GET /api/events/:eventId/registrants/search (admin: unmasked email). */
export const AdminRegistrantSearchResponseSchema = z.array(
  RegistrantSearchResultSchema,
);

/**
 * GET /api/events/registrations/:id/audit-logs. Wider than
 * `RegistrationAuditLogSchema` on purpose: stored entries also carry actions
 * written by other modules (check-in, sponsorship linking), and `changes` is
 * the stored JSON document.
 */
export const RegistrationAuditLogListResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      changes: z.unknown(),
      performedBy: z.string().nullable(),
      performedByName: z.string().nullable(),
      performedAt: z.string(),
      ipAddress: z.string().nullable(),
    }),
  ),
  meta: PaginationMetaSchema,
});

/**
 * GET /api/events/registrations/:id/email-logs. Every email sent about the
 * registration (sponsorship and certificate emails included), so `trigger` is
 * any stored trigger, not only the three registration ones.
 */
export const RegistrationEmailLogListResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      status: z.string(),
      trigger: z.string().nullable(),
      templateName: z.string().nullable(),
      errorMessage: z.string().nullable(),
      queuedAt: z.string(),
      sentAt: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      openedAt: z.string().nullable(),
      clickedAt: z.string().nullable(),
      bouncedAt: z.string().nullable(),
      failedAt: z.string().nullable(),
    }),
  ),
  meta: PaginationMetaSchema,
});

/** GET /api/registrations/:id/edit-link. */
export const RegistrationEditLinkResponseSchema = z.object({ url: z.string() });

// ============================================================================
// Types
// ============================================================================

export type PublicRegistrationResponse = z.infer<
  typeof PublicRegistrationResponseSchema
>;
export type AdminRegistrationResponse = z.infer<
  typeof AdminRegistrationResponseSchema
>;
