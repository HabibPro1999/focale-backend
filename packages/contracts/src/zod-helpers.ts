import { z } from "zod";

export const hasUpdateField = (data: Record<string, unknown>) =>
  Object.values(data).some((value) => value !== undefined);

export const PaginationLimitSchema = z.coerce.number().int().min(1).max(100);
export const PaginationQueryShape = {
  page: z.coerce.number().int().min(1).default(1),
  limit: PaginationLimitSchema.default(20),
};

// .positive() carries distinct issue metadata/messages from .min(1).
export const PositivePaginationQueryShape = {
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
};
