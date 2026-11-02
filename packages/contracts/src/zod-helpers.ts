import { z } from "zod";

/** Keep undefined distinct from an explicitly provided null/false/empty value. */
export const hasUpdateField = (data: Record<string, unknown>) =>
  Object.values(data).some((value) => value !== undefined);

/** Identical min(1) pagination fields; positive() sponsorship messages stay local. */
export function paginationQueryShape(defaultLimit = 20) {
  return {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(defaultLimit),
  };
}
