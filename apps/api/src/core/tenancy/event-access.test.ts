import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { UserRole } from "@app/contracts";

const db = vi.hoisted(() => ({ getEventWithPricing: vi.fn() }));
vi.mock("@app/db", async (original) => ({
  ...(await original<Record<string, unknown>>()), ...db,
}));

import { assertEventAccess } from "./event-access";
import { assertEventAccess as legacyAssertEventAccess } from "../auth/assert-event-access";

const owner = { role: UserRole.CLIENT_ADMIN, clientId: "c1" };
const event = { id: "event", clientId: "c1", status: "ARCHIVED" };

describe("event ownership compatibility", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.getEventWithPricing.mockResolvedValue(event);
  });

  it("keeps a missing event's Nest 404 before ownership, through the old import path", async () => {
    db.getEventWithPricing.mockResolvedValue(null);
    const error = await legacyAssertEventAccess({ ...owner, clientId: "c2" }, "missing")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toEqual({
      message: "Event not found", error: "Not Found", statusCode: 404,
    });
    expect(db.getEventWithPricing).toHaveBeenCalledExactlyOnceWith("missing");
  });

  it.each([undefined, "Insufficient permissions to update this event"])(
    "keeps the Nest 403 with message %s", async (message) => {
      const error = await assertEventAccess({ ...owner, clientId: "c2" }, "event", message)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual({
        message: message ?? "Insufficient permissions", error: "Forbidden", statusCode: 403,
      });
    },
  );

  it("returns the loaded archived event unchanged without adding policy checks", async () => {
    expect(await assertEventAccess(owner, "event")).toBe(event);
    expect(db.getEventWithPricing).toHaveBeenCalledExactlyOnceWith("event");
  });
});
