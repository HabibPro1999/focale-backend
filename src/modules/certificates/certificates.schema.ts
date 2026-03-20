import { z } from "zod";

// ============================================================================
// Zone Schema
// ============================================================================

export const CertificateZoneSchema = z
  .strictObject({
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

// Imported from registrations module — single source of truth for role values
import { RegistrationRoleSchema } from "@registrations";
export { RegistrationRoleSchema };

// ============================================================================
// Create / Update Schemas
// ============================================================================

/** Create schema — template image uploaded separately via multipart. */
export const CreateCertificateTemplateSchema = z
  .strictObject({
    name: z.string().min(1).max(200),
    applicableRoles: z.array(RegistrationRoleSchema).default([]),
    accessId: z.string().uuid().nullable().optional(),
  });

export const UpdateCertificateTemplateSchema = z
  .strictObject({
    name: z.string().min(1).max(200).optional(),
    zones: z.array(CertificateZoneSchema).optional(),
    applicableRoles: z.array(RegistrationRoleSchema).optional(),
    accessId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  });

// ============================================================================
// Param / Query Schemas
// ============================================================================

export const EventIdParamSchema = z
  .strictObject({
    eventId: z.string().uuid(),
  });

export const TemplateIdParamSchema = z
  .strictObject({
    id: z.string().uuid(),
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
