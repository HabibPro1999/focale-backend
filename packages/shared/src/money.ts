/** Money as integer minor units (cents/millimes). NEVER floats stored. */
export type Money = { amount: number; currency: string };

/** Currency exponents (minor-unit digits). Default 2; add exceptions here. */
const CURRENCY_EXPONENT: Record<string, number> = {
  TND: 3,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JPY: 0,
  KRW: 0,
};

export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENT[currency.toUpperCase()] ?? 2;
}

export function money(amount: number, currency: string): Money {
  if (!Number.isInteger(amount)) {
    throw new Error(`Money.amount must be an integer (minor units), got ${amount}`);
  }
  return { amount, currency };
}

/**
 * Round-half-up (toward +Inf) for a scaled value. toPrecision(15) first collapses
 * binary float error (e.g. 100.49999999999999 -> 100.5) so 1.005 * 100 rounds to 101.
 */
function roundHalfUp(value: number): number {
  return Math.floor(Number(value.toPrecision(15)) + 0.5);
}

/** Build Money from a decimal major-unit amount, rounding half-up per currency. */
export function fromDecimal(dec: number, currency: string): Money {
  const factor = 10 ** currencyExponent(currency);
  return money(roundHalfUp(dec * factor), currency);
}

export function toDecimal(m: Money): number {
  return m.amount / 10 ** currencyExponent(m.currency);
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function multiplyMoney(m: Money, factor: number): Money {
  return money(roundHalfUp(m.amount * factor), m.currency);
}
