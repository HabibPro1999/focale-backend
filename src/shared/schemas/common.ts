import { z } from "zod";

/** Build a paginated list query schema with module-specific filters. */
export function listQuery<T extends z.ZodRawShape>(filters: T) {
  return z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().max(200).optional(),
      ...filters,
    })
    .strict();
}
