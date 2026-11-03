import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatPaymentMethod,
  formatPaymentStatus,
  sponsoredItemHtml,
  basePriceItemLabel,
} from "./format";
import { formatDate, formatDateRange } from "./locale";

describe("formatCurrency", () => {
  it.each([
    ["fr", "1 350,500 TND"],
    ["en", "1,350.500 TND"],
    ["ar", "1.350,500 TND"],
  ] as const)("uses the language's grouping and the currency's minor digits (%s)", (language, out) => {
    expect(formatCurrency(1350.5, "TND", language)).toBe(out);
  });

  it("drops the decimals of a whole amount", () => {
    for (const language of ["fr", "en", "ar"] as const) {
      expect(formatCurrency(250, "TND", language)).toBe("250 TND");
      expect(formatCurrency(0, "TND", language)).toBe("0 TND");
    }
  });

  it("follows each currency's minor digits, and 2 for an unknown code", () => {
    expect(formatCurrency(12.5, "EUR", "en")).toBe("12.50 EUR");
    expect(formatCurrency(12.5, "XYZ1", "en")).toBe("12.50 XYZ1");
  });
});

describe("formatPaymentMethod", () => {
  it.each([
    ["BANK_TRANSFER", "Virement bancaire", "Bank transfer", "تحويل بنكي"],
    ["CASH", "Espèces", "Cash", "نقدًا"],
    ["LAB_SPONSORSHIP", "Prise en charge laboratoire", "Lab sponsorship", "تكفّل المختبر"],
    ["ONLINE", "Paiement en ligne", "Online payment", "الدفع عبر الإنترنت"],
  ] as const)("labels %s in each language", (method, fr, en, ar) => {
    expect(formatPaymentMethod(method, "fr")).toBe(fr);
    expect(formatPaymentMethod(method, "en")).toBe(en);
    expect(formatPaymentMethod(method, "ar")).toBe(ar);
  });

  it("passes an unknown method through and blanks none", () => {
    expect(formatPaymentMethod("CRYPTO", "fr")).toBe("CRYPTO");
    expect(formatPaymentMethod(null, "fr")).toBe("");
  });
});

describe("formatPaymentStatus", () => {
  it("labels PAID and PENDING in each language", () => {
    expect(formatPaymentStatus("PAID", "fr")).toBe("Confirmé");
    expect(formatPaymentStatus("PAID", "en")).toBe("Confirmed");
    expect(formatPaymentStatus("PENDING", "ar")).toBe("في انتظار الدفع");
  });
});

describe("sponsoredItemHtml", () => {
  it("writes the base price line in the language", () => {
    expect(sponsoredItemHtml(basePriceItemLabel("fr"), 450, "TND", "fr")).toBe(
      "<b>Inscription de base :</b> 450 TND",
    );
    expect(sponsoredItemHtml(basePriceItemLabel("en"), 450, "TND", "en")).toBe(
      "<b>Base registration:</b> 450 TND",
    );
    expect(sponsoredItemHtml(basePriceItemLabel("ar"), 450, "TND", "ar")).toBe(
      "<b>التسجيل الأساسي:</b> 450 TND",
    );
  });

  it("escapes the item label", () => {
    expect(sponsoredItemHtml("<A & B>", 1, "TND", "en")).toBe("<b>&lt;A &amp; B&gt;:</b> 1 TND");
  });
});

describe("formatDateRange", () => {
  const d = (day: string) => `${day}T12:00:00Z`;

  it("gives the long date for a one-day event", () => {
    expect(formatDateRange(d("2026-11-20"), d("2026-11-20"), "fr")).toBe("20 novembre 2026");
    expect(formatDateRange(d("2026-11-20"), d("2026-11-20"), "en")).toBe("November 20, 2026");
  });

  it.each([
    ["fr", "20–22 novembre 2026"],
    ["en", "November 20–22, 2026"],
    ["ar", "20–22 نوفمبر 2026"],
  ] as const)("writes one month's range once (%s)", (language, out) => {
    expect(formatDateRange(d("2026-11-20"), d("2026-11-22"), language)).toBe(out);
  });

  it("writes both long dates across months or years", () => {
    expect(formatDateRange(d("2026-11-30"), d("2026-12-02"), "fr")).toBe(
      "30 novembre 2026 – 2 décembre 2026",
    );
    expect(formatDateRange(d("2026-12-31"), d("2027-01-02"), "en")).toBe(
      "December 31, 2026 – January 2, 2027",
    );
  });

  it("falls back to the date it has", () => {
    expect(formatDateRange(null, d("2026-11-22"), "en")).toBe("November 22, 2026");
    expect(formatDateRange(d("2026-11-20"), null, "en")).toBe("November 20, 2026");
    expect(formatDateRange(null, null, "en")).toBe("");
  });
});

describe("formatDate", () => {
  it("reads a bare YYYY-MM-DD at noon UTC and blanks an invalid date", () => {
    expect(formatDate("2026-11-19", "fr")).toBe("19 novembre 2026");
    expect(formatDate("not a date", "fr")).toBe("");
  });
});
