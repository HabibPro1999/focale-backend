import { z } from "zod";
import { hasUpdateField, paginationQueryShape } from "./zod-helpers";

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
  "certificates",
  "abstracts",
  "networking",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export const DEFAULT_ENABLED_MODULES: ModuleId[] = [...MODULE_IDS];

export function normalizeEnabledModules(modules: ModuleId[]): ModuleId[] {
  return [...new Set(modules)];
}

const EnabledModulesSchema = z
  .array(z.enum(MODULE_IDS))
  .transform(normalizeEnabledModules);


// ============================================================================
// Request Schemas
// ============================================================================

const ClientDetailsShape = {
  name: z.string().min(1).max(100),
  logo: z.string().url().optional().nullable(),
  primaryColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Primary color must be a valid hex color")
    .optional()
    .nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(1).max(20).optional().nullable(),
};

export const CreateClientSchema = z.strictObject({
  ...ClientDetailsShape,
  enabledModules: EnabledModulesSchema.optional(),
});

export const UpdateClientSchema = z
  .strictObject({
    ...ClientDetailsShape,
    name: ClientDetailsShape.name.optional(),
    active: z.boolean().optional(),
    enabledModules: EnabledModulesSchema.optional(),
  })
  .refine(hasUpdateField, {
    message: "At least one field must be provided for update",
  });

export const ListClientsQuerySchema = z.strictObject({
  ...paginationQueryShape(),
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  search: z.string().optional(),
});

export const ClientIdParamSchema = z.strictObject({
  id: z.string().uuid(),
});

// ============================================================================
// Types
// ============================================================================

export type CreateClientInput = z.infer<typeof CreateClientSchema>;
export type UpdateClientInput = z.infer<typeof UpdateClientSchema>;
export type ListClientsQuery = z.infer<typeof ListClientsQuerySchema>;

/** Raw client resource shape returned by every client route (envelope-wrapped upstream). */
export interface ClientResponse {
  id: string;
  name: string;
  logo: string | null;
  primaryColor: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  enabledModules: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}
