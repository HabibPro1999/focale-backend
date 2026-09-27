import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", () => ({
  getEventPricingForEmail: vi.fn(),
  getEventAccessByIdsForEmail: vi.fn(),
  getSponsorshipByCodeForEmail: vi.fn(),
}));

import {
  getEventAccessByIdsForEmail,
  getEventPricingForEmail,
  getSponsorshipByCodeForEmail,
} from "@app/db";
import {
  buildBatchEmailContext,
  buildEmailContextWithAccess,
  buildLinkedSponsorshipContext,
} from "./index";

// Exact sponsorship email contexts: they are persisted as the email log's
// context snapshot, so their keys, values and HTML are part of the output.

type LinkedInput = Parameters<typeof buildLinkedSponsorshipContext>[0];

function linkedInput(overrides: Partial<LinkedInput> = {}): LinkedInput {
  return {
    amountApplied: 120,
    sponsorship: {
      code: "SP-1",
      beneficiaryName: "Dr <Beneficiary>",
      coversBasePrice: true,
      coveredAccessIds: ["acc-2", "acc-missing", "acc-1"],
      totalAmount: 300,
      batch: { labName: "Lab & Co", contactName: "Jean Dupont", email: "lab@x.test" },
    },
    registration: {
      id: "abcdef12-3456-7890",
      email: "reg@x.test",
      firstName: "Amel",
      lastName: null,
      phone: null,
      totalAmount: 400,
      baseAmount: 150,
      sponsorshipAmount: 120,
      linkBaseUrl: "https://forms.x.test",
      editToken: "tok",
    },
    event: {
      name: "Conf",
      slug: "conf",
      startDate: new Date("2026-04-20T12:00:00Z"),
      location: null,
      client: { name: "Org" },
    },
    pricing: { basePrice: 200 },
    accessItems: [
      { id: "acc-1", name: "Atelier <A> & B", price: 50 },
      { id: "acc-2", name: "Dîner", price: 80 },
    ],
    currency: "TND",
    ...overrides,
  };
}

const bullet = (html: string) => `<div style="padding: 4px 0;">• ${html}</div>`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildLinkedSponsorshipContext", () => {
  it("builds the partially sponsored doctor context", () => {
    const ctx = buildLinkedSponsorshipContext(linkedInput());

    expect(ctx).toStrictEqual({
      firstName: "Amel",
      lastName: "",
      fullName: "Amel",
      email: "reg@x.test",
      phone: "",
      registrationDate: "September 24, 2026",
      registrationId: "abcdef12-3456-7890",
      registrationNumber: "ABCDEF12",
      eventName: "Conf",
      eventDate: "April 20, 2026",
      eventEndDate: "",
      eventLocation: "",
      eventDescription: "",
      organizerName: "Org",
      organizerEmail: "",
      organizerPhone: "",
      totalAmount: "400 TND",
      paidAmount: "0 TND",
      amountDue: "280 TND",
      paymentStatus: "Pending",
      paymentMethod: "",
      selectedAccess: "",
      selectedWorkshops: "",
      selectedDinners: "",
      registrationLink: "https://forms.x.test/conf/registration/abcdef12-3456-7890/tok",
      editRegistrationLink:
        "https://forms.x.test/conf/registration/abcdef12-3456-7890/tok",
      paymentLink: "https://forms.x.test/conf/payment/abcdef12-3456-7890/tok",
      bankName: "",
      bankAccountName: "",
      bankAccountNumber: "",
      sponsorshipCode: "SP-1",
      sponsorshipAmount: "120 TND",
      labName: "Lab & Co",
      labContactName: "Jean Dupont",
      labEmail: "lab@x.test",
      beneficiaryName: "Dr <Beneficiary>",
      // Base price from the registration, then the covered access items in
      // the sponsorship's order (an unknown id is left out).
      sponsoredItems:
        bullet("<b>Inscription de base :</b> 150 TND") +
        bullet("<b>Dîner :</b> 80 TND") +
        bullet("<b>Atelier &lt;A&gt; &amp; B :</b> 50 TND"),
      remainingAmount: "280 TND",
    });
    expect(Object.keys(ctx)).toEqual([
      "firstName",
      "lastName",
      "fullName",
      "email",
      "phone",
      "registrationDate",
      "registrationId",
      "registrationNumber",
      "eventName",
      "eventDate",
      "eventEndDate",
      "eventLocation",
      "eventDescription",
      "organizerName",
      "organizerEmail",
      "organizerPhone",
      "totalAmount",
      "paidAmount",
      "amountDue",
      "paymentStatus",
      "paymentMethod",
      "selectedAccess",
      "selectedWorkshops",
      "selectedDinners",
      "registrationLink",
      "editRegistrationLink",
      "paymentLink",
      "bankName",
      "bankAccountName",
      "bankAccountNumber",
      "sponsorshipCode",
      "sponsorshipAmount",
      "labName",
      "labContactName",
      "labEmail",
      "beneficiaryName",
      "sponsoredItems",
      "remainingAmount",
    ]);
  });

  it("marks a fully sponsored registration paid", () => {
    const input = linkedInput();
    const ctx = buildLinkedSponsorshipContext({
      ...input,
      amountApplied: 400,
      registration: { ...input.registration, sponsorshipAmount: 400 },
    });

    expect(ctx).toMatchObject({
      totalAmount: "400 TND",
      paidAmount: "400 TND",
      amountDue: "0 TND",
      paymentStatus: "Paid",
      sponsorshipAmount: "400 TND",
      remainingAmount: "0 TND",
    });
  });

  it("falls back to the event base price, then 0, for the base price line", () => {
    const input = linkedInput();
    const withoutBaseAmount = {
      ...input,
      registration: { ...input.registration, baseAmount: null as never },
      sponsorship: { ...input.sponsorship, coveredAccessIds: [] },
    };

    expect(buildLinkedSponsorshipContext(withoutBaseAmount).sponsoredItems).toBe(
      bullet("<b>Inscription de base :</b> 200 TND"),
    );
    expect(
      buildLinkedSponsorshipContext({ ...withoutBaseAmount, pricing: null })
        .sponsoredItems,
    ).toBe(bullet("<b>Inscription de base :</b> 0 TND"));
  });

  it("uses the beneficiary name without a registrant name, and blanks sponsoredItems when nothing is covered", () => {
    const input = linkedInput();
    const ctx = buildLinkedSponsorshipContext({
      ...input,
      registration: { ...input.registration, firstName: null, lastName: null },
      sponsorship: {
        ...input.sponsorship,
        coversBasePrice: false,
        coveredAccessIds: [],
      },
    });

    expect(ctx.fullName).toBe("Dr <Beneficiary>");
    expect(ctx.firstName).toBe("");
    expect(ctx.sponsoredItems).toBe("");
  });
});

describe("buildEmailContextWithAccess — sponsored items", () => {
  function registration(overrides: Record<string, unknown> = {}) {
    return {
      id: "reg-abcdef12",
      eventId: "evt-1",
      formData: {},
      linkBaseUrl: null,
      editToken: "tok",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@x.test",
      phone: null,
      submittedAt: new Date("2026-03-15T12:00:00Z"),
      totalAmount: 400,
      paidAmount: 0,
      currency: "TND",
      sponsorshipAmount: 130,
      paymentStatus: "PENDING",
      paymentMethod: null,
      accessTypeIds: [],
      sponsorshipCode: "SP-1",
      language: "en",
      event: {
        slug: "conf",
        name: "Conf",
        startDate: new Date("2026-04-20T12:00:00Z"),
        endDate: null,
        location: null,
        description: null,
        client: { name: "Org", email: null, phone: null },
      },
      ...overrides,
    } as never;
  }

  beforeEach(() => {
    vi.mocked(getSponsorshipByCodeForEmail).mockReset().mockResolvedValue({
      code: "SP-1",
      totalAmount: 300,
      coversBasePrice: true,
      coveredAccessIds: ["acc-2", "acc-1"],
      beneficiaryName: "Dr X",
      batch: { labName: "Lab", contactName: "Contact", email: "lab@x.test" },
    });
    vi.mocked(getEventAccessByIdsForEmail)
      .mockReset()
      .mockResolvedValue([
        { id: "acc-1", name: "Atelier <A> & B", type: "WORKSHOP", price: 50 },
        { id: "acc-2", name: "Dîner", type: "DINNER", price: 80 },
      ]);
  });

  it("lists the event base price, then the covered access items in read order", async () => {
    vi.mocked(getEventPricingForEmail).mockReset().mockResolvedValue({
      bankName: null,
      bankAccountName: null,
      bankAccountNumber: null,
      basePrice: 200,
    });

    const ctx = await buildEmailContextWithAccess(registration());

    expect(ctx.sponsoredItems).toBe(
      bullet("<b>Inscription de base :</b> 200 TND") +
        bullet("<b>Atelier &lt;A&gt; &amp; B :</b> 50 TND") +
        bullet("<b>Dîner :</b> 80 TND"),
    );
    expect(ctx.remainingAmount).toBe("270 TND");
  });

  it("leaves the base price out without a pricing row", async () => {
    vi.mocked(getEventPricingForEmail).mockReset().mockResolvedValue(null);

    const ctx = await buildEmailContextWithAccess(registration());

    expect(ctx.sponsoredItems).toBe(
      bullet("<b>Atelier &lt;A&gt; &amp; B :</b> 50 TND") +
        bullet("<b>Dîner :</b> 80 TND"),
    );
  });
});

describe("buildBatchEmailContext — beneficiary list", () => {
  it("lists each sponsored beneficiary, escaped", () => {
    const ctx = buildBatchEmailContext({
      batch: { labName: "Lab", contactName: "Jean", email: "lab@x.test", phone: null },
      sponsorships: [
        { beneficiaryName: "Dr <A>", beneficiaryEmail: "a&b@x.test", totalAmount: 100 },
        { beneficiaryName: "Dr B", beneficiaryEmail: "b@x.test", totalAmount: 50 },
      ],
      event: {
        name: "Conf",
        startDate: new Date("2026-04-20T12:00:00Z"),
        location: null,
        client: { name: "Org" },
      },
      currency: "EUR",
    });

    expect(ctx.beneficiaryList).toBe(
      bullet("<b>Dr &lt;A&gt;</b> (a&amp;b@x.test) : 100 EUR") +
        bullet("<b>Dr B</b> (b@x.test) : 50 EUR"),
    );
    expect(ctx).toMatchObject({
      paidAmount: "0 EUR",
      paymentStatus: "N/A",
      registrationDate: "September 24, 2026",
      lastName: "",
    });
  });
});
