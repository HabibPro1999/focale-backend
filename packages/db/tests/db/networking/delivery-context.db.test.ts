import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { networkingDeliveryContext, type NetworkingDeliveryRow } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";

describe.runIf(dbTestsEnabled())("networking delivery context absent rows", () => {
  it.each([null, "missing-profile"])("preserves undefined context fields for profileId %s", async (profileId) => {
    const row: NetworkingDeliveryRow = {
      id: randomUUID(), eventId: randomUUID(), profileId, type: "OTP",
      payload: { meetingId: randomUUID(), connectionId: randomUUID(), messageId: randomUUID(), challengeId: randomUUID() },
      status: "PROCESSING", email: null, attempts: 1, lastError: null, dedupeKey: randomUUID(), lockedUntil: null,
      availableAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    };
    const context = await networkingDeliveryContext(row);
    for (const field of ["event", "client", "profile", "registration", "meeting", "table", "contact", "contactRegistration", "connection", "message", "challenge"] as const) {
      expect(context).toHaveProperty(field, undefined);
    }
    expect(context.blocked).toBe(false);
    expect(context.consentPending).toBe(false);
    expect(context.subscriptions).toEqual([]);
    expect(context.config.enabled).toBe(false);
  });
});
