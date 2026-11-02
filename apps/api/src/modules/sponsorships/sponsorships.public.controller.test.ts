import { assertClientModuleEnabled } from "../clients/module-gates";
import { assertEventAcceptsPublicActions } from "../events";
import { AppException } from "../../core/app-exception";
import type { CreateSponsorshipBatchDto } from "./dto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getEventWithPricing: vi.fn(),
  getEventWithPricingBySlug: vi.fn(),
  getActiveSponsorForm: vi.fn(),
  searchRegistrantsForSponsorship: vi.fn(),
}));
vi.mock("@app/db", () => db);
vi.mock("../clients/module-gates", () => ({
  assertClientModuleEnabled: vi.fn(async () => undefined),
}));
vi.mock("../events", () => ({ assertEventAcceptsPublicActions: vi.fn() }));

import { ErrorCodes, RegistrantSearchQuerySchema } from "@app/contracts";
import type { AccessService } from "../access/access.service";
import { SponsorshipsPublicController } from "./sponsorships.public.controller";
import { SponsorshipsPublicService } from "./sponsorships.public.service";

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

// The real public service over the mocked db: the route's response is what
// the anonymous caller gets, whichever layer shapes it.
function makeController() {
  db.getActiveSponsorForm.mockResolvedValue({
    id: "f1",
    schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } },
  });
  db.searchRegistrantsForSponsorship.mockResolvedValue([result]);
  const service = new SponsorshipsPublicService({} as AccessService);
  return { controller: new SponsorshipsPublicController(service), service };
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

describe.each(["id", "slug"] as const)("public sponsorship create by %s", (route) => {
  const input: CreateSponsorshipBatchDto = { sponsor: { labName: "Lab", contactName: "Contact", email: "lab@example.com" }, beneficiaries: [] };
  function setup() {
    const { controller, service } = makeController();
    const event = { id: "resolved-event", clientId: "c1" };
    const lookup = route === "id" ? db.getEventWithPricing : db.getEventWithPricingBySlug;
    lookup.mockResolvedValue(event);
    const create = vi.spyOn(service, "createSponsorshipBatch").mockResolvedValue({ batchId: "batch-1", count: 2 });
    const call = () => route === "id"
      ? controller.createByEventId({ eventId: "requested-event" }, input)
      : controller.createBySlug({ slug: "summit" }, input);
    return { lookup, create, call, event };
  }
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertClientModuleEnabled).mockResolvedValue(undefined);
    vi.mocked(assertEventAcceptsPublicActions).mockImplementation(() => undefined);
  });
  it("preserves gates, form lookup ID and the complete created response", async () => {
    const { call, event, create } = setup();
    await expect(call()).resolves.toEqual({ success: true, message: "2 sponsoring(s) created successfully", batchId: "batch-1", count: 2 });
    expect(assertEventAcceptsPublicActions).toHaveBeenCalledExactlyOnceWith(event);
    expect(assertClientModuleEnabled).toHaveBeenCalledExactlyOnceWith("c1", "sponsorships");
    const eventId = route === "id" ? "requested-event" : "resolved-event";
    expect(db.getActiveSponsorForm).toHaveBeenCalledExactlyOnceWith(eventId);
    expect(create).toHaveBeenCalledExactlyOnceWith(eventId, "f1", input);
    expect(vi.mocked(assertEventAcceptsPublicActions).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(assertClientModuleEnabled).mock.invocationCallOrder[0]);
    expect(vi.mocked(assertClientModuleEnabled).mock.invocationCallOrder[0]).toBeLessThan(db.getActiveSponsorForm.mock.invocationCallOrder[0]);
  });
  it("returns the event 404 before any gates or form lookup", async () => {
    const { call, lookup, create } = setup();
    lookup.mockResolvedValue(null);
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(404);
    expect((error as AppException).getResponse()).toMatchObject({ code: ErrorCodes.NOT_FOUND, message: "Event not found" });
    expect(assertEventAcceptsPublicActions).not.toHaveBeenCalled();
    expect(db.getActiveSponsorForm).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it("retains the create-specific sponsor form 404", async () => {
    const { call, create } = setup();
    db.getActiveSponsorForm.mockResolvedValue(null);
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(404);
    expect((error as AppException).getResponse()).toMatchObject({ code: ErrorCodes.NOT_FOUND, message: "Sponsor form not found for this event" });
    expect(create).not.toHaveBeenCalled();
  });
});
