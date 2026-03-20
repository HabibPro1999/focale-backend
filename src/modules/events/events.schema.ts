import { z } from "zod";

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateEventSchema = z
  .strictObject({
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
    // Pricing
    basePrice: z.number().int().min(0).default(0),
    currency: z.string().length(3).default("TND"),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: "End date must be greater than or equal to start date",
    path: ["endDate"],
  });

export const UpdateEventSchema = z
  .strictObject({
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
    // Pricing
    basePrice: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
  })
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
  .strictObject({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    clientId: z.string().uuid().optional(),
    status: z.enum(["CLOSED", "OPEN", "ARCHIVED"]).optional(),
    search: z.string().optional(),
  });

export const EventIdParamSchema = z
  .strictObject({
    id: z.string().uuid(),
  });

export const EventSlugParamSchema = z
  .strictObject({
    slug: z.string(),
  });

// ============================================================================
// Types
// ============================================================================

export type CreateEventInput = z.infer<typeof CreateEventSchema>;
export type UpdateEventInput = z.infer<typeof UpdateEventSchema>;
export type ListEventsQuery = z.infer<typeof ListEventsQuerySchema>;
