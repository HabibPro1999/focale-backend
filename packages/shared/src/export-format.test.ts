import { describe, expect, it } from "vitest";
import {
  asciiSlug,
  csvCell,
  DEFAULT_EVENT_TIME_ZONE,
  formatDate,
  formatDateTime,
  formatFileDate,
  formatTime,
  CSV_BOM,
  toCsv,
  toCsvLine,
  uniqueFileName,
  uniqueSheetName,
} from "./export-format";

describe("dates in the event time zone", () => {
  // 23:30 UTC on 31 Dec is already 00:30 on 1 Jan in Tunis (UTC+1).
  const lateUtc = new Date("2025-12-31T23:30:00Z");

  it("defaults to Africa/Tunis whatever the server time zone", () => {
    expect(DEFAULT_EVENT_TIME_ZONE).toBe("Africa/Tunis");
    expect(formatDateTime(lateUtc)).toBe("01/01/2026 00:30");
    expect(formatDate(lateUtc)).toBe("01/01/2026");
    expect(formatTime(lateUtc)).toBe("00:30");
    expect(formatFileDate(lateUtc)).toBe("2026-01-01");
  });

  it("formats per language and accepts another zone", () => {
    expect(formatDateTime(lateUtc, "en")).toBe("01/01/2026, 12:30 AM");
    expect(formatDateTime(lateUtc, "fr", "UTC")).toBe("31/12/2025 23:30");
    expect(formatFileDate(lateUtc, "UTC")).toBe("2025-12-31");
  });

  it("matches Date#toLocale*String with the same fields (cached formatters, 3.7)", () => {
    const locales = { fr: "fr-FR", en: "en-US", ar: "ar-TN" } as const;
    const zones = ["Africa/Tunis", "UTC", "Europe/Paris", "America/New_York"];
    const dates = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2020, i % 12, 1 + i, i % 24, (i * 7) % 60)));
    for (const [lang, locale] of Object.entries(locales) as ["fr" | "en" | "ar", string][]) {
      for (const timeZone of zones) {
        for (const date of dates) {
          const fields = { timeZone, day: "2-digit", month: "2-digit", year: "numeric" } as const;
          const time = { timeZone, hour: "2-digit", minute: "2-digit" } as const;
          expect(formatDateTime(date, lang, timeZone)).toBe(date.toLocaleString(locale, { ...fields, ...time }));
          expect(formatDate(date, lang, timeZone)).toBe(date.toLocaleDateString(locale, fields));
          expect(formatTime(date, lang, timeZone)).toBe(date.toLocaleTimeString(locale, time));
        }
      }
    }
    const invalid = new Date("not a date");
    expect(formatDateTime(invalid)).toBe("Invalid Date");
    expect(formatDate(invalid)).toBe("Invalid Date");
    expect(formatTime(invalid)).toBe("Invalid Date");
  });
});

describe("csvCell / toCsv", () => {
  it("quotes every cell and doubles quotes", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it("neutralises formulas, including after leading spaces or control characters", () => {
    for (const payload of ["=SUM(A1)", "+1", "-1+cmd", "@cmd", " =1", "\u0000=1", "\t=1", "\r=1", "\n=1"]) {
      expect(csvCell(payload).startsWith(`"'`), JSON.stringify(payload)).toBe(true);
    }
    expect(csvCell('=HYPERLINK("https://evil.example")')).toBe('"\'=HYPERLINK(""https://evil.example"")"');
  });

  it("keeps numbers as numbers (a negative amount is not a formula)", () => {
    expect(csvCell(-12.5)).toBe('"-12.5"');
    expect(csvCell(0)).toBe('"0"');
  });

  it("writes CRLF rows with a UTF-8 BOM", () => {
    expect(toCsv([["Nom", "Montant"], ["Zoë", 10]])).toBe('\uFEFF"Nom","Montant"\r\n"Zoë","10"\r\n');
  });

  it("streams the same bytes: CSV_BOM then one toCsvLine per record (3.7)", () => {
    const rows = [["Nom", "Montant"], ["=1", -3], ["Zoë", null]];
    expect(CSV_BOM + rows.map(toCsvLine).join("")).toBe(toCsv(rows));
    expect(toCsv([])).toBe("\uFEFF\r\n");
  });
});

describe("uniqueSheetName", () => {
  it("strips forbidden characters and truncates to 31 characters", () => {
    const used = new Set<string>();
    expect(uniqueSheetName("Atelier [A]: 1/2 ?*", used)).toBe("Atelier A 1 2");
    expect(uniqueSheetName("'quoted'", used)).toBe("quoted");
    expect(uniqueSheetName("x".repeat(40), used)).toBe("x".repeat(31));
  });

  it("suffixes duplicates, including after truncation and case-insensitively", () => {
    const used = new Set<string>();
    const long = "Workshop on cardiology, session one";
    const long2 = "Workshop on cardiology, session two";
    const first = uniqueSheetName(long, used);
    const second = uniqueSheetName(long2, used);
    expect(first).toBe("Workshop on cardiology, session");
    expect(second).toBe("Workshop on cardiology, ses (2)");
    expect(second.length).toBeLessThanOrEqual(31);
    expect(uniqueSheetName("déjeuner", used)).toBe("déjeuner");
    expect(uniqueSheetName("DÉJEUNER", used)).toBe("DÉJEUNER (2)");
  });

  it("keeps non-ASCII names and falls back when nothing is left", () => {
    const used = new Set<string>();
    expect(uniqueSheetName("ورشة عمل", used)).toBe("ورشة عمل");
    expect(uniqueSheetName("[]:", used, "Accès")).toBe("Accès");
    expect(uniqueSheetName("", used, "Accès")).toBe("Accès (2)");
    expect(uniqueSheetName("History", used)).toBe("Sheet");
  });
});

describe("uniqueFileName / asciiSlug", () => {
  it("folds accents and drops other characters", () => {
    expect(asciiSlug("Déjeuner — Gala 2026!")).toBe("dejeuner-gala-2026");
    expect(asciiSlug("ورشة")).toBe("");
  });

  it("falls back for non-ASCII names and suffixes collisions", () => {
    const used = new Set(["event-global-checkin.xlsx"]);
    expect(uniqueFileName("Atelier A", "-checkin.xlsx", used, "access")).toBe("atelier-a-checkin.xlsx");
    expect(uniqueFileName("Atelier: A", "-checkin.xlsx", used, "access")).toBe("atelier-a-2-checkin.xlsx");
    expect(uniqueFileName("ورشة", "-checkin.xlsx", used, "access")).toBe("access-checkin.xlsx");
    expect(uniqueFileName("غداء", "-checkin.xlsx", used, "access")).toBe("access-2-checkin.xlsx");
    expect(uniqueFileName("Event global", "-checkin.xlsx", used, "access")).toBe("event-global-2-checkin.xlsx");
  });
});
