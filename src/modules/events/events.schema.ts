import { z } from "zod";

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateEventSchema = z
  .object({
    clientId: z.string().uuid(),
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
        "Slug must be lowercase alphanumeric with hyphens, dots, or underscores",
      ),
    description: z.string().optional().nullable(),
    maxCapacity: z.number().int().positive().optional().nullable(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    location: z.string().min(1).max(500).optional().nullable(),
    status: z.enum(["CLOSED", "OPEN", "ARCHIVED"]).default("CLOSED"),
    contactPhone: z.string().min(1).max(20).optional().nullable(),
    // Pricing
    basePrice: z.number().int().min(0).default(0),
    currency: z.string().length(3).default("TND"),
  })
  .strict()
  .refine((data) => data.endDate >= data.startDate, {
    message: "End date must be greater than or equal to start date",
    path: ["endDate"],
  });

export const UpdateEventSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
        "Slug must be lowercase alphanumeric with hyphens, dots, or underscores",
      )
      .optional(),
    description: z.string().optional().nullable(),
    maxCapacity: z.number().int().positive().optional().nullable(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    location: z.string().min(1).max(500).optional().nullable(),
    status: z.enum(["CLOSED", "OPEN", "ARCHIVED"]).optional(),
    contactPhone: z.string().min(1).max(20).optional().nullable(),
    accessSectionTitle: z.string().max(200).optional().nullable(),
    accessSectionSubtitle: z.string().max(500).optional().nullable(),
    // Pricing
    basePrice: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return data.endDate >= data.startDate;
      }
      return true;
    },
    {
      message: "End date must be greater than or equal to start date",
      path: ["endDate"],
    },
  );

export const ListEventsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    clientId: z.string().uuid().optional(),
    status: z.enum(["CLOSED", "OPEN", "ARCHIVED"]).optional(),
    search: z.string().optional(),
  })
  .strict();

export const EventIdParamSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const EventSlugParamSchema = z
  .object({
    slug: z.string(),
  })
  .strict();

// ============================================================================
// Types
// ============================================================================

export type CreateEventInput = z.infer<typeof CreateEventSchema>;
export type UpdateEventInput = z.infer<typeof UpdateEventSchema>;
export type ListEventsQuery = z.infer<typeof ListEventsQuerySchema>;
