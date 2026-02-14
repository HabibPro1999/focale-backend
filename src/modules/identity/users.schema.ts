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
    role: z.number().int().min(0).max(1).default(UserRole.CLIENT_ADMIN),
    clientId: z.string().uuid().optional().nullable(),
  })
  .strict();

export const UpdateUserSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    role: z.number().int().min(0).max(1).optional(),
    clientId: z.string().uuid().optional().nullable(),
    active: z.boolean().optional(),
  })
  .strict();

export const ListUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    role: z.coerce.number().int().min(0).max(1).optional(),
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

export const UsersListResponseSchema = z.object({
  data: z.array(UserResponseSchema),
  meta: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

// ============================================================================
// Types
// ============================================================================

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type UsersListResponse = z.infer<typeof UsersListResponseSchema>;
