import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getEventWithPricing: vi.fn(),
  getEventWithPricingBySlug: vi.fn(),
}));
vi.mock("@app/db", () => db);
vi.mock("../clients/module-gates", () => ({
  assertClientModuleEnabled: vi.fn(async () => undefined),
}));
vi.mock("../events", () => ({ assertEventAcceptsPublicActions: vi.fn() }));

import { RegistrantSearchQuerySchema } from "@app/contracts";
import { SponsorshipsPublicController } from "./sponsorships.public.controller";
import type { SponsorshipsService } from "./sponsorships.service";

const result = {
  id: "r1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Martin",
  paymentStatus: "PENDING",
  totalAmount: 300,
  baseAmount: 200,
  accessAmount: 100,
  sponsorshipAmount: 0,
  accessTypeIds: ["a1"],
  coveredAccessIds: [],
  isBasePriceCovered: false,
  phone: "+216 20 000 000",
  formData: { specialty: "cardio" },
};

function makeController() {
  const service = {
    getActiveSponsorForm: vi.fn(async () => ({
      id: "f1",
      schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } },
    })),
    searchRegistrantsForSponsorship: vi.fn(async () => [result]),
  };
  return {
    controller: new SponsorshipsPublicController(service as unknown as SponsorshipsService),
    service,
  };
}

describe("anonymous registrant search (sponsor form)", () => {
  beforeEach(() => {
    db.getEventWithPricingBySlug.mockResolvedValue({ id: "ev1", clientId: "c1" });
  });

  it("masks the email and strips phone + formData, keeping the rest of the shape", async () => {
    const { controller } = makeController();
    const [row] = await controller.searchRegistrants({ slug: "summit" }, { query: "ali" });
    expect(row.email).toBe("a***@example.com");
    expect(row).not.toHaveProperty("phone");
    expect(row).not.toHaveProperty("formData");
    const rest: Record<string, unknown> = { ...result };
    for (const key of ["phone", "formData", "email"]) delete rest[key];
    expect(row).toMatchObject(rest);
    expect(JSON.stringify(row)).not.toContain("alice@");
  });

  it("the request contract rejects queries shorter than 3 characters (→ 400)", () => {
    expect(RegistrantSearchQuerySchema.safeParse({ query: "al" }).success).toBe(false);
    expect(RegistrantSearchQuerySchema.safeParse({ query: " al " }).success).toBe(false);
    expect(RegistrantSearchQuerySchema.safeParse({ query: "ali" }).success).toBe(true);
  });
});
