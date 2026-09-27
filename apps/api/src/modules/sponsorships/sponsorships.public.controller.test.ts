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
import { assertClientModuleEnabled } from "../clients/module-gates";
import { assertEventAcceptsPublicActions } from "../events";
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


describe.each(["eventId", "slug"] as const)("public create by %s", (route) => {
  const input = { sponsor: { labName: "Lab", contactName: "Contact", email: "lab@example.com" } };
  const event = { id: "ev1", clientId: "c1" };
  let service: { getActiveSponsorForm: ReturnType<typeof vi.fn>; createSponsorshipBatch: ReturnType<typeof vi.fn> };
  let create: () => Promise<unknown>;
  beforeEach(() => {
    vi.clearAllMocks();
    db.getEventWithPricing.mockResolvedValue(event);
    db.getEventWithPricingBySlug.mockResolvedValue(event);
    vi.mocked(assertEventAcceptsPublicActions).mockImplementation(() => undefined);
    vi.mocked(assertClientModuleEnabled).mockResolvedValue(undefined);
    service = {
      getActiveSponsorForm: vi.fn().mockResolvedValue({ id: "f1" }),
      createSponsorshipBatch: vi.fn().mockResolvedValue({ batchId: "b1", count: 2 }),
    };
    const controller = new SponsorshipsPublicController(service as unknown as SponsorshipsService);
    create = () => route === "eventId"
      ? controller.createByEventId({ eventId: "ev1" }, input)
      : controller.createBySlug({ slug: "summit" }, input);
  });

  it("keeps the response and event/form/input forwarding", async () => {
    await expect(create()).resolves.toEqual({ success: true, message: "2 sponsoring(s) created successfully", batchId: "b1", count: 2 });
    expect(service.getActiveSponsorForm).toHaveBeenCalledExactlyOnceWith("ev1");
    expect(service.createSponsorshipBatch).toHaveBeenCalledExactlyOnceWith("ev1", "f1", input);
    expect(assertEventAcceptsPublicActions).toHaveBeenCalledWith(event);
    expect(assertClientModuleEnabled).toHaveBeenCalledWith("c1", "sponsorships");
  });
  it("not found wins before public actions and module gating", async () => {
    db.getEventWithPricing.mockResolvedValue(null);
    db.getEventWithPricingBySlug.mockResolvedValue(null);
    await expect(create()).rejects.toMatchObject({ statusCode: 404, message: "Event not found" });
    expect(assertEventAcceptsPublicActions).not.toHaveBeenCalled();
    expect(assertClientModuleEnabled).not.toHaveBeenCalled();
  });
  it("public-action failure wins before the module gate or form lookup", async () => {
    const error = new Error("closed event");
    vi.mocked(assertEventAcceptsPublicActions).mockImplementation(() => { throw error; });
    await expect(create()).rejects.toBe(error);
    expect(assertClientModuleEnabled).not.toHaveBeenCalled();
    expect(service.getActiveSponsorForm).not.toHaveBeenCalled();
  });
  it("module failure wins before the missing form", async () => {
    const error = new Error("module disabled");
    vi.mocked(assertClientModuleEnabled).mockRejectedValue(error);
    service.getActiveSponsorForm.mockResolvedValue(null);
    await expect(create()).rejects.toBe(error);
    expect(service.getActiveSponsorForm).not.toHaveBeenCalled();
  });
  it("preserves the create-specific missing-form message", async () => {
    service.getActiveSponsorForm.mockResolvedValue(null);
    await expect(create()).rejects.toMatchObject({ statusCode: 404, message: "Sponsor form not found for this event" });
    expect(service.createSponsorshipBatch).not.toHaveBeenCalled();
  });
});
