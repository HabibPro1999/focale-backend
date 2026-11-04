import type { MoneySnapshot, PriceBreakdown } from "@app/contracts";

const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/** ISO currency precision from the runtime's ICU data (TND=3, EUR=2, JPY=0). */
function currencyScale(currency: string): number {
  const scale = new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() })
    .resolvedOptions().maximumFractionDigits!;
  if (scale > 4) throw new RangeError("Unsupported currency precision");
  return scale;
}

function scaledInteger(amount: number, scale: number): bigint {
  if (!Number.isFinite(amount) || amount !== Number(amount.toFixed(scale))) {
    throw new RangeError(`Amount must have at most ${scale} decimal places`);
  }
  const fixed = amount.toFixed(scale);
  if (fixed.includes("e")) throw new RangeError("Amount exceeds the safe money range");
  const minor = BigInt(fixed.replace(".", ""));
  if (minor > MAX_MINOR || minor < -MAX_MINOR) throw new RangeError("Amount exceeds the safe money range");
  return minor;
}

export function toMinorUnits(amount: number, currency: string): number {
  return Number(scaledInteger(amount, currencyScale(currency)));
}

/** All arithmetic uses integer units at the maximum supported scale, never float addition. */
export function sumMoney(...amounts: number[]): number {
  const result = amounts.reduce((sum, amount) => sum + scaledInteger(amount, 4), 0n);
  if (result > MAX_MINOR || result < -MAX_MINOR) throw new RangeError("Amount exceeds the safe money range");
  return Number(result) / 10_000;
}

export function subtractMoney(amount: number, deduction: number): number {
  return sumMoney(amount, -deduction);
}

export function multiplyMoney(amount: number, quantity: number): number {
  if (!Number.isSafeInteger(quantity)) throw new RangeError("Quantity must be a safe integer");
  const result = scaledInteger(amount, 4) * BigInt(quantity);
  if (result > MAX_MINOR || result < -MAX_MINOR) throw new RangeError("Amount exceeds the safe money range");
  return Number(result) / 10_000;
}

export function moneySnapshot(currency: string, amounts: Record<string, number>): MoneySnapshot {
  return { currency, scale: currencyScale(currency),
    amountsMinor: Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, toMinorUnits(value, currency)])) };
}

/** Refresh after settlement, access removal or repricing so the additive fields never go stale. */
export function withBreakdownMoney<T extends Pick<PriceBreakdown, "currency" | "basePrice" | "calculatedBasePrice" | "accessTotal" | "subtotal" | "sponsorshipTotal" | "total"> & Partial<Pick<PriceBreakdown, "optionModifiersTotal">>>(breakdown: T): T & { money: MoneySnapshot } {
  return { ...breakdown, money: moneySnapshot(breakdown.currency, {
    basePrice: breakdown.basePrice, calculatedBasePrice: breakdown.calculatedBasePrice,
    accessTotal: breakdown.accessTotal, optionModifiersTotal: breakdown.optionModifiersTotal ?? 0,
    subtotal: breakdown.subtotal, sponsorshipTotal: breakdown.sponsorshipTotal, total: breakdown.total,
  }) };
}
