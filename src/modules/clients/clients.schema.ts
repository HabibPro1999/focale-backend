import { z } from "zod";
import { PaginationSchema, HexColorSchema } from "@shared/schemas/common.js";

// ============================================================================
// Module Configuration
// ============================================================================

/**
 * Available event modules that can be enabled per client.
 * These control which features are visible in the event sidebar.
 */
export const MODULE_IDS = [
  "pricing",
  "registrations",
  "sponsorships",
  "emails",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

const EnabledModulesSchema = z
  .array(z.enum(MODULE_IDS))
  .default([...MODULE_IDS]);

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateClientSchema = z
  .object({
    name: z.string().min(1).max(100),
    logo: z.string().url().optional().nullable(),
    primaryColor: HexColorSchema.optional().nullable(),
    email: z.string().email().optional().nullable(),
    phone: z.string().min(1).max(20).optional().nullable(),
    enabledModules: EnabledModulesSchema.optional(),
  })
  .strict();

export const UpdateClientSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    logo: z.string().url().optional().nullable(),
    primaryColor: HexColorSchema.optional().nullable(),
    email: z.string().email().optional().nullable(),
    phone: z.string().min(1).max(20).optional().nullable(),
    active: z.boolean().optional(),
    enabledModules: z.array(z.enum(MODULE_IDS)).optional(),
  })
  .strict();

export const ListClientsQuerySchema = z
  .object({
    ...PaginationSchema.shape,
    active: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    search: z.string().max(200).optional(),
  })
  .strict();

export const ClientIdParamSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

// ============================================================================
// Types
// ============================================================================

export type CreateClientInput = z.infer<typeof CreateClientSchema>;
export type UpdateClientInput = z.infer<typeof UpdateClientSchema>;
export type ListClientsQuery = z.infer<typeof ListClientsQuerySchema>;
