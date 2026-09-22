import { BadRequestException } from "@nestjs/common";
import { NetworkingCalendarQuerySchema } from "@app/contracts";

/** Start-day calendar: [first instant of date, first instant of next local date).
 * Search local dates rather than adding 24h: DST can shorten/lengthen the day,
 * and some IANA zones skip midnight itself. An entirely skipped date is invalid.
 */
export function networkingCalendarDay(date: string, timezone: string) {
  const invalid = () => new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Invalid calendar date or timezone" });
  if (!NetworkingCalendarQuerySchema.safeParse({ date }).success) throw invalid();
  try {
    const formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    });
    const midnight = Date.parse(`${date}T00:00:00Z`);
    const nextDate = new Date(midnight + 86400000).toISOString().slice(0, 10);
    const boundary = (day: string, nominal: number) => {
      let low = nominal - 2 * 86400000, high = nominal + 2 * 86400000;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (formatter.format(new Date(middle)) < day) low = middle + 1;
        else high = middle;
      }
      return new Date(low);
    };
    const start = boundary(date, midnight);
    const end = boundary(nextDate, midnight + 86400000);
    if (formatter.format(start) !== date || end <= start) throw invalid();
    return { start, end };
  } catch {
    throw invalid();
  }
}
