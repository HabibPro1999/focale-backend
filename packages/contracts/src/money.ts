import { z } from "zod";

/** Legacy wire amounts remain major units. Up to four decimal places are exact. */
export const MoneyAmountSchema = z.number().min(0).max(900_000_000_000)
  .refine((value) => value === Number(value.toFixed(4)), "Money supports at most four decimal places");

/** Additive representation for consumers that calculate/display in minor units. */
export const MoneySnapshotSchema = z.object({
  currency: z.string(),
  scale: z.number().int().min(0).max(4),
  amountsMinor: z.record(z.string(), z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)),
});

export type MoneySnapshot = z.infer<typeof MoneySnapshotSchema>;
