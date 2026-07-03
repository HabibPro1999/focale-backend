import { z } from "zod";

// Certificates module Zod contracts — ported verbatim from legacy
// certificates.schema.ts. Param schemas are namespaced (Certificate*) to avoid
// collisions with events.ts's EventIdParamSchema (which is `{ id }`, not
// `{ eventId }`) under the contracts barrel's `export *`.

const hasUpdateField = (data: Record<string, unknown>) =>
  Object.values(data).some((value) => value !== undefined);

// Role values for `applicableRoles`. Legacy imported RegistrationRoleSchema from
// the registrations module; that domain's contracts are still a stub, so the enum
// is inlined here with the exact same values (RegistrationRole pgEnum).
export const CertificateRegistrationRoleSchema = z.enum([
  "PARTICIPANT",
  "SPEAKER",
  "MODERATOR",
  "ORGANIZER",
  "INVITED",
]);

// ============================================================================
// Zone Schema
// ============================================================================

export const CertificateZoneSchema = z.strictObject({
  id: z.string(),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(0).max(100),
  height: z.number().min(0).max(100),
  variable: z.string(),
  fontSize: z.number().min(1).nullable(), // null = auto-fit
  fontWeight: z.enum(["normal", "bold"]).default("normal"),
  color: z.string().default("#000000"),
  textAlign: z.enum(["left", "center", "right"]).default("center"),
});

// ============================================================================
// Create / Update Schemas
// ============================================================================

/** Create schema — template image uploaded separately via multipart. */
export const CreateCertificateTemplateSchema = z.strictObject({
  name: z.string().min(1).max(200),
  applicableRoles: z.array(CertificateRegistrationRoleSchema).default([]),
  accessId: z.string().uuid().nullable().optional(),
});

export const UpdateCertificateTemplateSchema = z
  .strictObject({
    name: z.string().min(1).max(200).optional(),
    zones: z.array(CertificateZoneSchema).optional(),
    applicableRoles: z.array(CertificateRegistrationRoleSchema).optional(),
    accessId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(hasUpdateField, {
    message: "At least one field must be provided for update",
  });

// ============================================================================
// Param / Query Schemas
// ============================================================================

export const CertificateEventIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const CertificateIdParamSchema = z.strictObject({
  id: z.string().uuid(),
});

// ============================================================================
// Send Certificates Schema
// ============================================================================

export const SendCertificatesBodySchema = z.strictObject({
  registrationIds: z.array(z.string().uuid()).optional(),
});

// ============================================================================
// Type Exports
// ============================================================================

export type CertificateZone = z.infer<typeof CertificateZoneSchema>;
export type CreateCertificateTemplateInput = z.infer<
  typeof CreateCertificateTemplateSchema
>;
export type UpdateCertificateTemplateInput = z.infer<
  typeof UpdateCertificateTemplateSchema
>;
export type SendCertificatesBody = z.infer<typeof SendCertificatesBodySchema>;
