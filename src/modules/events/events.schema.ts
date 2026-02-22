import { z } from "zod";

export const EventStatusEnum = z.enum(["CLOSED", "OPEN", "ARCHIVED"]);

/** Base entity — mirrors the events table (mutable fields only). */
export const Event = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
        "Slug must be lowercase alphanumeric with dots, hyphens, or underscores",
      ),
    description: z.string().optional().nullable(),
    maxCapacity: z.number().int().positive().optional().nullable(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    location: z.string().min(1).max(500).optional().nullable(),
    status: EventStatusEnum.default("CLOSED"),
  })
  .strict();

/** Slug param — used by public routes in forms + sponsorships. */
export const EventSlugParamSchema = z.object({ slug: z.string() }).strict();
