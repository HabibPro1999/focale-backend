import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", () => ({
  getEventPricingForEmail: vi.fn(),
  getEventAccessByIdsForEmail: vi.fn(),
  getSponsorshipByCodeForEmail: vi.fn(),
}));

import {
  getEventPricingForEmail,
  getEventAccessByIdsForEmail,
  getSponsorshipByCodeForEmail,
} from "@app/db";
import {
  buildEmailContext,
  buildEmailContextWithAccess,
  resolveVariables,
  sanitizeForHtml,
  getSampleEmailContext,
  buildBatchEmailContext,
} from "./context";

function reg(overrides: Record<string, unknown> = {}) {
  return {
    id: "reg-abcdef12-3456",
    formData: {},
    linkBaseUrl: null,
    editToken: "tok",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "123",
    submittedAt: new Date("2025-03-15T00:00:00Z"),
    totalAmount: 250,
    paidAmount: 100,
    currency: "TND",
    sponsorshipAmount: 0,
    paymentStatus: "PARTIAL",
    paymentMethod: null,
    accessTypeIds: [],
    sponsorshipCode: null,
    eventId: "evt-1",
    event: {
      slug: "conf",
      name: "Conf 2025",
      startDate: new Date("2025-04-20T00:00:00Z"),
      endDate: new Date("2025-04-22T00:00:00Z"),
      location: "Tunis",
      description: "desc",
      client: { name: "Org Co", email: "org@x.com", phone: "555" },
    },
    ...overrides,
  } as never;
}

describe("buildEmailContext (sync)", () => {
  it("builds full fields from a complete registration", () => {
    const ctx = buildEmailContext(reg());
    expect(ctx.fullName).toBe("Jane Doe");
    expect(ctx.email).toBe("jane@example.com");
    expect(ctx.eventName).toBe("Conf 2025");
    expect(ctx.registrationNumber).toBe("REG-ABCD"); // first 8 chars uppercased
    expect(ctx.organizerName).toBe("Org Co");
    expect(ctx.paymentStatus).toBe("Partially paid");
    expect(ctx.eventDate).toBe("April 20, 2025");
  });

  it("falls back to formData for names and defaults fullName to Registrant", () => {
    const ctx = buildEmailContext(
      reg({
        firstName: null,
        lastName: null,
        formData: { firstName: "F", specialty: "cardio" },
      }),
    );
    expect(ctx.firstName).toBe("F");
    expect(ctx.fullName).toBe("Registrant");
    expect(ctx["form_specialty"]).toBe("cardio");
  });

  it("formats amountDue via settlement math", () => {
    const ctx = buildEmailContext(reg({ totalAmount: 250, paidAmount: 100 }));
    // 250 - (100 + 0) = 150
    expect(ctx.amountDue).toBe("150 TND");
  });

  it("formats boolean and array form fields", () => {
    const ctx = buildEmailContext(
      reg({ formData: { attending: true, tags: ["a", "b"] } }),
    );
    expect(ctx["form_attending"]).toBe("Yes");
    expect(ctx["form_tags"]).toBe("a, b");
  });
});

describe("buildEmailContextWithAccess (async, DB)", () => {
  beforeEach(() => {
    vi.mocked(getEventPricingForEmail).mockResolvedValue(null);
    vi.mocked(getEventAccessByIdsForEmail).mockResolvedValue([]);
    vi.mocked(getSponsorshipByCodeForEmail).mockResolvedValue(null);
  });

  it("populates bank details from pricing", async () => {
    vi.mocked(getEventPricingForEmail).mockResolvedValue({
      bankName: "BT",
      bankAccountName: "Acc",
      bankAccountNumber: "TN123",
      basePrice: 200,
    });
    const ctx = await buildEmailContextWithAccess(reg());
    expect(ctx.bankName).toBe("BT");
    expect(ctx.bankAccountNumber).toBe("TN123");
  });

  it("resolves access type ids into names, workshops and dinners", async () => {
    vi.mocked(getEventAccessByIdsForEmail).mockResolvedValue([
      { id: "a1", name: "Workshop A", type: "WORKSHOP", price: 50 },
      { id: "a2", name: "Gala", type: "DINNER", price: 80 },
    ]);
    const ctx = await buildEmailContextWithAccess(
      reg({ accessTypeIds: ["a1", "a2"] }),
    );
    expect(ctx.selectedAccess).toBe("Workshop A, Gala");
    expect(ctx.selectedWorkshops).toBe("Workshop A");
    expect(ctx.selectedDinners).toBe("Gala");
  });

  it("handles a missing pricing row without throwing (bank fields stay empty)", async () => {
    const ctx = await buildEmailContextWithAccess(reg());
    expect(ctx.bankName).toBe("");
  });

  it("builds sponsorship context + HTML-safe sponsoredItems", async () => {
    vi.mocked(getEventPricingForEmail).mockResolvedValue({
      bankName: null,
      bankAccountName: null,
      bankAccountNumber: null,
      basePrice: 200,
    });
    vi.mocked(getSponsorshipByCodeForEmail).mockResolvedValue({
      code: "SP1",
      totalAmount: 150,
      coversBasePrice: true,
      coveredAccessIds: [],
      beneficiaryName: "Dr X",
      batch: { labName: "Lab", contactName: "Contact", email: "lab@x.com" },
    });
    const ctx = await buildEmailContextWithAccess(
      reg({ sponsorshipCode: "SP1", totalAmount: 250 }),
    );
    expect(ctx.sponsorshipCode).toBe("SP1");
    expect(ctx.labName).toBe("Lab");
    expect(ctx.sponsoredItems).toContain("Inscription de base");
    expect(ctx.remainingAmount).toBe("100 TND"); // 250 - 150
  });
});

describe("resolveVariables", () => {
  const ctx = { firstName: "Jane", empty: "", missing: undefined } as never;

  it("replaces present variables and escapes values", () => {
    expect(resolveVariables("Hi {{firstName}}", ctx)).toBe("Hi Jane");
  });

  it("HTML-escapes variable values (XSS protection)", () => {
    const out = resolveVariables("{{x}}", {
      x: "<script>alert(1)</script>",
    } as never);
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("passes through HTML_SAFE variables verbatim (sponsoredItems)", () => {
    const out = resolveVariables("{{sponsoredItems}}", {
      sponsoredItems: "<div>x</div>",
    } as never);
    expect(out).toBe("<div>x</div>");
  });

  it("replaces missing/empty/null with empty string", () => {
    expect(resolveVariables("[{{missing}}][{{empty}}][{{nope}}]", ctx)).toBe(
      "[][][]",
    );
  });

  it("supports ids with underscores, hyphens and dots", () => {
    const out = resolveVariables("{{form_a}}-{{a-b}}-{{a.b}}", {
      form_a: "1",
      "a-b": "2",
      "a.b": "3",
    } as never);
    expect(out).toBe("1-2-3");
  });

  it("passes through templates with no placeholders", () => {
    expect(resolveVariables("plain text", ctx)).toBe("plain text");
  });
});

describe("sanitizeForHtml", () => {
  it("escapes angle brackets, ampersands and quotes", () => {
    expect(sanitizeForHtml('<a href="x">&')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;",
    );
  });
  it("returns empty string for null/undefined", () => {
    expect(sanitizeForHtml(null)).toBe("");
    expect(sanitizeForHtml(undefined)).toBe("");
  });
  it("stringifies numbers before escaping", () => {
    expect(sanitizeForHtml(42)).toBe("42");
  });
});

describe("getSampleEmailContext", () => {
  it("returns a complete context with realistic values", () => {
    const ctx = getSampleEmailContext();
    expect(ctx.firstName).toBe("John");
    expect(ctx.eventName).toBe("Medical Conference 2025");
    expect(ctx.totalAmount).toBe("250 TND");
    for (const key of [
      "email",
      "eventDate",
      "registrationLink",
      "organizerName",
      "bankName",
    ]) {
      expect((ctx as unknown as Record<string, unknown>)[key]).toBeTruthy();
    }
  });
});

describe("buildBatchEmailContext", () => {
  it("sums sponsorship totals and builds an HTML-safe beneficiary list", () => {
    const ctx = buildBatchEmailContext({
      batch: {
        labName: "Lab",
        contactName: "Jean Dupont",
        email: "lab@x.com",
        phone: null,
      },
      sponsorships: [
        {
          beneficiaryName: "Dr A",
          beneficiaryEmail: "a@x.com",
          totalAmount: 100,
        },
        {
          beneficiaryName: "Dr B",
          beneficiaryEmail: "b@x.com",
          totalAmount: 50,
        },
      ],
      event: {
        name: "Conf",
        startDate: new Date("2025-04-20T00:00:00Z"),
        location: "Tunis",
        client: { name: "Org" },
      },
      currency: "TND",
    });
    expect(ctx.beneficiaryCount).toBe("2");
    expect(ctx.totalBatchAmount).toBe("150 TND");
    expect(ctx.firstName).toBe("Jean");
    expect(ctx.lastName).toBe("Dupont");
    expect(ctx.beneficiaryList).toContain("Dr A");
  });
});
