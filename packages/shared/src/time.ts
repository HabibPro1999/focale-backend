/** UTC-only time helpers over native Date. */

export function nowUtc(): Date {
  return new Date();
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function isPast(d: Date, now: Date = nowUtc()): boolean {
  return d.getTime() < now.getTime();
}

export function toIso(d: Date): string {
  return d.toISOString();
}
