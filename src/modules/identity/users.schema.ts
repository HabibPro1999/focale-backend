import { z } from "zod";
import { UserRole } from "./permissions.js";

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateUserSchema = z
  .object({
    email: z.string().email(),
    password: z
      .string()
      .min(12, "Password must be at least 12 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[0-9]/, "Password must contain at least one number")
      .regex(
        /[!@#$%^&*(),.?":{}|<>]/,
        "Password must contain at least one special character",
      ),
    name: z.string().min(1).max(100),
    role: z
      .union([
        z.literal(UserRole.SUPER_ADMIN),
        z.literal(UserRole.CLIENT_ADMIN),
      ])
      .default(UserRole.CLIENT_ADMIN),
    clientId: z.string().uuid().optional().nullable(),
  })
  .strict();

export const UpdateUserSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    role: z
      .union([
        z.literal(UserRole.SUPER_ADMIN),
        z.literal(UserRole.CLIENT_ADMIN),
      ])
      .optional(),
    clientId: z.string().uuid().optional().nullable(),
    active: z.boolean().optional(),
  })
  .strict();

export const ListUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    role: z.coerce
      .number()
      .int()
      .refine(
        (val) => val === UserRole.SUPER_ADMIN || val === UserRole.CLIENT_ADMIN,
        "Invalid role value",
      )
      .optional(),
    clientId: z.string().uuid().optional(),
    active: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    search: z.string().optional(),
  })
  .strict();

export const UserIdParamSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

// ============================================================================
// Response Schemas
// ============================================================================

export const UserResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: z.number(),
  clientId: z.string().nullable(),
  active: z.boolean(),
});

// ============================================================================
// Types
// ============================================================================

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;
