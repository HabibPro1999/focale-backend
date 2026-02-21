import { z } from "zod";
import {
  PaginationSchema,
  CurrencySchema,
  PriceSchema,
  SlugSchema,
} from "@shared/schemas/common.js";

// ============================================================================
// Enums
// ============================================================================

export const EventStatusEnum = z.enum(["CLOSED", "OPEN", "ARCHIVED"]);

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateEventSchema = z
  .object({
    clientId: z.string().uuid(),
    name: z.string().min(1).max(200),
    slug: SlugSchema,
    description: z.string().optional().nullable(),
    maxCapacity: z.number().int().positive().optional().nullable(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    location: z.string().min(1).max(500).optional().nullable(),
    status: EventStatusEnum.default("CLOSED"),
    // Pricing
    basePrice: PriceSchema,
    currency: CurrencySchema,
  })
  .strict()
  .refine((data) => data.endDate >= data.startDate, {
    message: "End date must be greater than or equal to start date",
    path: ["endDate"],
  });

export const UpdateEventSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slug: SlugSchema.optional(),
    description: z.string().optional().nullable(),
    maxCapacity: z.number().int().positive().optional().nullable(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    location: z.string().min(1).max(500).optional().nullable(),
    status: EventStatusEnum.optional(),
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
    ...PaginationSchema.shape,
    clientId: z.string().uuid().optional(),
    status: EventStatusEnum.optional(),
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
