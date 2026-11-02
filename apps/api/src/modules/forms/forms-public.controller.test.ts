import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { FormsPublicController } from "./forms-public.controller";
import type { FormsService } from "./forms.service";

// Direct instantiation — the transform in getSponsorBySlug is what's under
// test, no Nest bootstrapping needed.
function makeController(form: unknown) {
  return new FormsPublicController({
    getSponsorFormByEventSlug: vi.fn().mockResolvedValue(form),
  } as unknown as FormsService);
}

const form = {
  id: "form-1",
  schemaVersion: 3,
  schema: { fields: [] },
  event: {
    id: "event-1",
    name: "Event",
    slug: "event",
    status: "OPEN",
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    endDate: new Date("2026-06-02T00:00:00.000Z"),
    location: "Tunis",
    bannerUrl: "https://cdn.example.com/banner.webp",
    client: { id: "client-1", name: "Client", logo: null, primaryColor: null, phone: null },
    pricing: null,
    access: [],
  },
};

describe("FormsPublicController.getBySlug", () => {
  it("returns the form without the event's clientId", async () => {
    const row = { id: "form-1", event: { ...form.event, clientId: "client-1" } };
    const controller = new FormsPublicController({
      getFormByEventSlug: vi.fn().mockResolvedValue(row),
    } as unknown as FormsService);

    const res = await controller.getBySlug({ slug: "event" });

    expect(res.event).not.toHaveProperty("clientId");
    expect(res.event.client).toEqual(form.event.client);
    expect(res).toEqual({ id: "form-1", event: form.event });
  });

  it("404s when no published form matches", async () => {
    const controller = new FormsPublicController({
      getFormByEventSlug: vi.fn().mockResolvedValue(null),
    } as unknown as FormsService);
    await expect(controller.getBySlug({ slug: "nope" })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("FormsPublicController.getSponsorBySlug", () => {
  it("exposes id/eventId/schemaVersion and the event bannerUrl (formId kept for back-compat)", async () => {
    const res = await makeController(form).getSponsorBySlug({ slug: "event" });

    expect(res).toMatchObject({
      id: "form-1",
      formId: "form-1",
      eventId: "event-1",
      schemaVersion: 3,
    });
    expect(res.event).toMatchObject({
      id: "event-1",
      bannerUrl: "https://cdn.example.com/banner.webp",
      startsAt: "2026-06-01T00:00:00.000Z",
      endsAt: "2026-06-02T00:00:00.000Z",
    });
    expect(res.accessItems).toEqual([]);
  });

  it("404s when no sponsor form matches", async () => {
    await expect(
      makeController(null).getSponsorBySlug({ slug: "nope" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
