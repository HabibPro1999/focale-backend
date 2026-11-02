import { toMinorUnits } from "@app/shared";
import { badRequest } from "./app-exception";

/** Reject unsupported fractions before persisting; never silently round a charge. */
export function assertMoneyPrecision(currency: string, ...amounts: Array<number | null | undefined>): void {
  try {
    for (const amount of amounts) if (amount != null) toMinorUnits(amount, currency);
  } catch {
    throw badRequest(`Invalid monetary amount or precision for ${currency}`);
  }
}
