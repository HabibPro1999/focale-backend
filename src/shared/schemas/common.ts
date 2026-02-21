import { z } from "zod";

// ============================================================================
// Shared Schema Primitives
// Used across multiple modules to avoid duplication.
// ============================================================================

// Pagination - used in 8+ list query schemas
export const PaginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

// Currency field - used in events + access (3-letter ISO code, defaults to TND)
export const CurrencySchema = z.string().length(3).default("TND");

// Price field - used in events + access (non-negative integer in minor units)
export const PriceSchema = z.number().int().min(0).default(0);

// Hex color - used in clients (CSS hex color, e.g. #FF5733)
export const HexColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Invalid hex color");

// Slug - used in events (lowercase alphanumeric with dots, hyphens, underscores)
export const SlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    "Slug must be lowercase alphanumeric with dots, hyphens, or underscores",
  );
