import { describe, it, expect } from "vitest";
import { buildLinkedSponsorshipContext } from "@modules/email/email-context.js";

// ============================================================================
// Fix 4 — code must NOT appear in doctor-facing email context
// ============================================================================

describe("buildLinkedSponsorshipContext — code not in output", () => {
  const baseInput = {
    amountApplied: 200,
    sponsorship: {
      beneficiaryName: "Dr. Test",
      coversBasePrice: true,
      coveredAccessIds: [],
      totalAmount: 200,
      batch: {
        labName: "Test Lab",
        contactName: "Lab Contact",
        email: "lab@example.com",
      },
    },
    registration: {
      id: "reg-uuid-1234",
      email: "doctor@example.com",
      firstName: "John",
      lastName: "Doe",
      phone: null,
      totalAmount: 200,
      baseAmount: 200,
      sponsorshipAmount: 200,
      linkBaseUrl: "https://events.example.com",
      editToken: "tok123",
    },
    event: {
      name: "Medical Conference 2025",
      slug: "medical-conf-2025",
      startDate: new Date("2025-09-01"),
      location: "Tunis",
      client: { name: "Organizer" },
    },
    pricing: { basePrice: 200 },
    accessItems: [],
    currency: "TND",
  };

  it("does not include sponsorshipCode in the returned context", () => {
    const context = buildLinkedSponsorshipContext(baseInput);
    expect(context).not.toHaveProperty("sponsorshipCode");
  });

  it("does not include code as any key in the returned context", () => {
    const context = buildLinkedSponsorshipContext(baseInput);
    const keys = Object.keys(context);
    expect(keys).not.toContain("code");
    expect(keys).not.toContain("sponsorshipCode");
  });

  it("still includes sponsorshipAmount (non-sensitive fields remain)", () => {
    const context = buildLinkedSponsorshipContext(baseInput);
    expect(context).toHaveProperty("sponsorshipAmount");
    expect(context.sponsorshipAmount).toBeTruthy();
  });

  it("still includes labName in the returned context", () => {
    const context = buildLinkedSponsorshipContext(baseInput);
    expect(context).toHaveProperty("labName", "Test Lab");
  });

  it("includes registration info in the returned context", () => {
    const context = buildLinkedSponsorshipContext(baseInput);
    expect(context).toHaveProperty("firstName", "John");
    expect(context).toHaveProperty("lastName", "Doe");
    expect(context).toHaveProperty("email", "doctor@example.com");
  });
});
