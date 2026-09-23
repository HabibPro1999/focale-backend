import { BadRequestException } from "@nestjs/common";
import type { NetworkingConfig } from "@app/contracts";
export function networkingPair(a: string, b: string) {
  return a < b ? ([a, b] as const) : ([b, a] as const);
}
export function resourceQuanta(startsAt: Date, endsAt: Date) {
  const result: Date[] = [];
  for (
    let t = Math.floor(startsAt.getTime() / 300_000) * 300_000;
    t < endsAt.getTime();
    t += 300_000
  )
    result.push(new Date(t));
  return result;
}
/** Resolve local wall time to a UTC instant, rejecting nonexistent DST wall times. */
export function zonedInstant(date: string, time: string, timezone: string) {
  const desired = `${date}T${time}`;
  let stamp = Date.parse(`${desired}:00Z`);
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 4; i++) {
    const actual = formatter.format(new Date(stamp)).replace(" ", "T");
    if (actual === desired) return new Date(stamp);
    stamp += Date.parse(`${desired}:00Z`) - Date.parse(`${actual}:00Z`);
  }
  throw new BadRequestException({
    code: "NETWORKING_SLOT_INVALID",
    message: `Nonexistent local time ${desired} in ${timezone}`,
  });
}
export function networkingSlots(
  config: NetworkingConfig,
  event: { startDate: Date; endDate: Date },
) {
  const slots: string[] = [];
  const blocked = new Set(
    config.blackoutSlots.map((v) => new Date(v).toISOString()),
  );
  const duration = config.slotDurationMinutes * 60_000;
  const lower = Math.max(
    event.startDate.getTime(),
    config.opensAt ? Date.parse(config.opensAt) : 0,
  );
  const upper = Math.min(
    event.endDate.getTime(),
    config.closesAt ? Date.parse(config.closesAt) : Infinity,
  );
  if (!config.openingHours.length) return slots;
  for (const window of config.openingHours) {
    const start = zonedInstant(
      window.date,
      window.start,
      config.timezone,
    ).getTime();
    const end = zonedInstant(
      window.date,
      window.end,
      config.timezone,
    ).getTime();
    for (let t = start; t + duration <= end; t += duration) {
      const iso = new Date(t).toISOString();
      if (t >= lower && t + duration <= upper && !blocked.has(iso))
        slots.push(iso);
    }
  }
  return [...new Set(slots)].sort();
}
export function networkingPublicProfile<T extends Record<string, unknown>>(
  profile: T,
) {
  const {
    email,
    registrationId,
    overrides,
    consentAt,
    withdrawnAt,
    emailPreference,
    language,
    status,
    availabilitySet,
    ...safe
  } = profile;
  return safe;
}
export function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export { normalizeNetworkingSearch, networkingSearchMatches } from "@app/db";
