import { ErrorCodes } from "@app/contracts";
import { describe, expect, it } from "vitest";
import { assertSelfEditAllowed, evaluateEditPolicy, type EditPolicyInput } from "./edit-policy";

const NOW = new Date("2026-06-10T15:00:00.000Z");
const CLIENT = { active: true, enabledModules: ["registrations", "pricing"] };

function input(
  registration: Partial<EditPolicyInput["registration"]> = {},
  event: Partial<EditPolicyInput["event"]> = {},
): EditPolicyInput {
  return {
    registration: {
      paymentStatus: "PENDING",
      paidAmount: 0,
      totalAmount: 100,
      sponsorshipAmount: 0,
      ...registration,
    },
    event: {
      status: "OPEN",
      endDate: new Date("2026-06-20T00:00:00.000Z"),
      client: CLIENT,
      ...event,
    },
    now: NOW,
  };
}

function thrown(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("evaluateEditPolicy", () => {
  it("allows everything on an open event for an unpaid registration", () => {
    expect(evaluateEditPolicy(input())).toMatchObject({
      canEdit: true,
      canEditPersonalInfo: true,
      canEditAccess: true,
      canAddAccess: true,
      canRemoveAccess: true,
      isFullySponsored: false,
      paymentReceived: false,
      restrictions: [],
    });
  });

  // The last-day drift: GET compared endDate itself, the edit the whole last day.
  it("treats a midnight-UTC end date as open for the whole last day", () => {
    const lastDay = input({}, { endDate: new Date("2026-06-10T00:00:00.000Z") });
    const policy = evaluateEditPolicy(lastDay);
    expect(policy.canEdit).toBe(true);
    expect(() =>
      assertSelfEditAllowed(policy, CLIENT, { changesAccess: true, removedAccessIds: [] }),
    ).not.toThrow();
  });

  it("closes the edit after the last day, and after a timed end", () => {
    for (const endDate of [
      new Date("2026-06-09T00:00:00.000Z"),
      new Date("2026-06-10T14:59:59.000Z"),
    ]) {
      const policy = evaluateEditPolicy(input({}, { endDate }));
      expect(policy).toMatchObject({ canEdit: false, editBlocks: ["EVENT_CLOSED"] });
      expect(policy.restrictions).toEqual(["Event is not accepting changes"]);
      expect(
        thrown(() => assertSelfEditAllowed(policy, CLIENT, { changesAccess: false, removedAccessIds: [] })),
      ).toMatchObject({ code: ErrorCodes.REGISTRATION_EDIT_FORBIDDEN, statusCode: 400 });
    }
  });

  it("closes the edit when the event is not OPEN", () => {
    const policy = evaluateEditPolicy(input({}, { status: "CLOSED" }));
    expect(policy.editBlocks).toEqual(["EVENT_CLOSED"]);
  });

  it("blocks everything for a REFUNDED registration, refunded first", () => {
    const policy = evaluateEditPolicy(input({ paymentStatus: "REFUNDED" }, { status: "CLOSED" }));
    expect(policy).toMatchObject({
      canEdit: false,
      canEditPersonalInfo: false,
      canEditAccess: false,
      canAddAccess: false,
      canRemoveAccess: false,
    });
    expect(policy.editBlocks).toEqual(["REFUNDED", "EVENT_CLOSED"]);
    expect(
      thrown(() => assertSelfEditAllowed(policy, CLIENT, { changesAccess: false, removedAccessIds: [] })),
    ).toMatchObject({ code: ErrorCodes.REGISTRATION_REFUNDED, statusCode: 400 });
  });

  it("blocks everything when a module is off, with the module gate's error", () => {
    const client = { active: true, enabledModules: ["registrations"] };
    const policy = evaluateEditPolicy(input({}, { client }));
    expect(policy.editBlocks).toEqual(["PRICING_DISABLED"]);
    expect(policy.restrictions).toEqual(["Pricing is disabled for this event"]);
    expect(
      thrown(() => assertSelfEditAllowed(policy, client, { changesAccess: false, removedAccessIds: [] })),
    ).toMatchObject({ response: { code: ErrorCodes.MODULE_DISABLED } });

    const inactive = { active: false, enabledModules: ["registrations", "pricing"] };
    expect(evaluateEditPolicy(input({}, { client: inactive })).editBlocks).toEqual([
      "REGISTRATIONS_DISABLED",
      "PRICING_DISABLED",
    ]);
  });

  it.each([
    ["VERIFYING", { paymentStatus: "VERIFYING" }, ErrorCodes.REGISTRATION_VERIFYING_BLOCKED],
    ["WAIVED", { paymentStatus: "WAIVED" }, ErrorCodes.REGISTRATION_WAIVED_ACCESS_BLOCKED],
    ["FULLY_SPONSORED", { paymentStatus: "SPONSORED", sponsorshipAmount: 100 }, ErrorCodes.REGISTRATION_FULLY_SPONSORED_BLOCKED],
  ] as const)("blocks access changes only when %s", (block, registration, code) => {
    const policy = evaluateEditPolicy(input(registration));
    expect(policy).toMatchObject({ canEdit: true, canEditAccess: false, canAddAccess: false, canRemoveAccess: false });
    expect(policy.accessBlocks).toContain(block);
    expect(() =>
      assertSelfEditAllowed(policy, CLIENT, { changesAccess: false, removedAccessIds: [] }),
    ).not.toThrow();
    expect(
      thrown(() => assertSelfEditAllowed(policy, CLIENT, { changesAccess: true, removedAccessIds: [] })),
    ).toMatchObject({ code, statusCode: 400 });
  });

  it("does not call a free registration fully sponsored", () => {
    expect(evaluateEditPolicy(input({ totalAmount: 0 })).isFullySponsored).toBe(false);
  });

  it.each([
    ["PAID", { paymentStatus: "PAID", paidAmount: 100 }],
    ["SPONSORED", { paymentStatus: "SPONSORED", sponsorshipAmount: 50 }],
    ["a partial payment", { paymentStatus: "PARTIAL", paidAmount: 10 }],
  ] as const)("allows adding but not removing access after %s", (_label, registration) => {
    const policy = evaluateEditPolicy(input(registration));
    expect(policy).toMatchObject({ paymentReceived: true, canAddAccess: true, canRemoveAccess: false });
    expect(policy.restrictions).toEqual(["Cannot remove access items (payment received)"]);
    expect(() =>
      assertSelfEditAllowed(policy, CLIENT, { changesAccess: true, removedAccessIds: [] }),
    ).not.toThrow();
    expect(
      thrown(() => assertSelfEditAllowed(policy, CLIENT, { changesAccess: true, removedAccessIds: ["acc1"] })),
    ).toMatchObject({
      code: ErrorCodes.REGISTRATION_ACCESS_REMOVAL_BLOCKED,
      statusCode: 400,
      details: { attemptedRemovals: ["acc1"] },
    });
  });

  it("lists the restrictions in the order GET has always shown them", () => {
    const policy = evaluateEditPolicy(
      input({ paymentStatus: "VERIFYING", paidAmount: 10, totalAmount: 100, sponsorshipAmount: 100 }),
    );
    expect(policy.restrictions).toEqual([
      "Payment proof is under review",
      "Cannot remove access items (payment received)",
      "Fully sponsored registration cannot modify access selections",
    ]);
  });
});
