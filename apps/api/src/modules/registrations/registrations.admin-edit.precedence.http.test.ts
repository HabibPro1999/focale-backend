import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes, UserRole } from "@app/contracts";

// Real route guards, DTO validation, controller and repricer; only the DB
// boundary is mocked. Every case refuses before settlement or other writes.
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/integrations")>()),
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  getUserWithClientById: vi.fn(),
  getUserIdsByClient: vi.fn(async () => []),
  getEventTenantScope: vi.fn(),
  withLockingTxn: vi.fn(),
  lockRegistrationForUpdate: vi.fn(),
  findRegistrationForMutation: vi.fn(),
  settleRegistrationTxn: vi.fn(async () => { throw new Error("unexpected settlement"); }),
  applyRegistrationSettlement: vi.fn(async () => { throw new Error("unexpected registration write"); }),
}));

import * as db from "@app/db";
import { authAs } from "../../testing/auth";
import { createTestApp } from "../../testing/create-test-app";
import { txnPassthrough } from "../../testing/txn";
import type { AccessService } from "../access/access.service";
import type { PricingService } from "../pricing/pricing.service";
import { RegistrationsController } from "./registrations.controller";
import { RegistrationCreateService } from "./registrations.create.service";
import { RegistrationPaymentsService } from "./registrations.payments.service";
import { RegistrationRepricer } from "./registrations.repricer";
import { RegistrationsService } from "./registrations.service";
import type { RegistrationSideEffects } from "./registrations.side-effects";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const EVENT = "e0000000-0000-4000-8000-000000000001";
const REGISTRATION = "e0000000-0000-4000-8000-000000000002";
const OTHER_EVENT = "e0000000-0000-4000-8000-000000000003";
const tx = { executor: "registration-precedence" };
const routeScope = (status: "OPEN" | "ARCHIVED" = "OPEN", modules = ["registrations", "pricing"]) => ({
  event: { id: EVENT, clientId: OWNER, status, slug: "summit" },
  client: { id: OWNER, active: true, enabledModules: modules },
});
// Deliberately wrong event AND archived/module-disabled. Event mismatch must
// win inside the service, after the route's own event scope has passed.
// Only these early-refusal fields are needed; no money/contact row is modeled.
type MutationRow = NonNullable<Awaited<ReturnType<typeof db.findRegistrationForMutation>>>;
const mismatchedRegistration: Pick<MutationRow, "id" | "eventId" | "event"> = {
  id: REGISTRATION,
  eventId: OTHER_EVENT,
  event: { clientId: OWNER, status: "ARCHIVED", client: { active: true, enabledModules: [] } },
};

// The early refusals need none of the repricer's collaborators. Plain empty
// stubs fail if a test unexpectedly reaches them; no replacement policy logic.
const repricer = new RegistrationRepricer(
  {} as AccessService,
  {} as PricingService,
  {} as RegistrationSideEffects,
);

describe("admin edit HTTP refusal precedence", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createTestApp({
      controllers: [RegistrationsController],
      providers: [
        { provide: RegistrationsService, useValue: {} },
        { provide: RegistrationCreateService, useValue: {} },
        { provide: RegistrationPaymentsService, useValue: {} },
        { provide: RegistrationRepricer, useValue: repricer },
      ],
    });
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    authAs(UserRole.CLIENT_ADMIN, OWNER);
    vi.mocked(db.getEventTenantScope).mockResolvedValue(routeScope());
    vi.mocked(db.withLockingTxn).mockImplementation(txnPassthrough(tx));
    vi.mocked(db.lockRegistrationForUpdate).mockResolvedValue(true);
    vi.mocked(db.findRegistrationForMutation).mockResolvedValue(mismatchedRegistration as MutationRow);
  });

  const send = (payload: Record<string, unknown> = { note: "updated" }) => app.inject({
    method: "PUT",
    url: `/api/events/${EVENT}/registrations/${REGISTRATION}/admin-edit`,
    headers: { authorization: "Bearer test" },
    payload,
  });

  it.each([
    ["missing route event", "missing", 404, ErrorCodes.NOT_FOUND, "Event not found"],
    ["foreign route event", "foreign", 403, ErrorCodes.FORBIDDEN, "Insufficient permissions"],
    ["archived route event", "archived", 400, ErrorCodes.INVALID_STATUS_TRANSITION, "Archived events cannot be modified"],
    ["disabled registration module", "disabled", 403, ErrorCodes.MODULE_DISABLED, "Registrations module is disabled for this client"],
  ] as const)("%s wins before the registration/event mismatch", async (_label, condition, status, code, message) => {
    if (condition === "missing") vi.mocked(db.getEventTenantScope).mockResolvedValue(null);
    if (condition === "foreign") authAs(UserRole.CLIENT_ADMIN, OTHER);
    if (condition === "archived") vi.mocked(db.getEventTenantScope).mockResolvedValue(routeScope("ARCHIVED", []));
    if (condition === "disabled") vi.mocked(db.getEventTenantScope).mockResolvedValue(routeScope("OPEN", []));
    const response = await send();
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toEqual({ code, message });
    expect(db.getEventTenantScope).toHaveBeenCalledWith(EVENT);
    expect(db.withLockingTxn).not.toHaveBeenCalled();
    expect(db.lockRegistrationForUpdate).not.toHaveBeenCalled();
    expect(db.findRegistrationForMutation).not.toHaveBeenCalled();
  });

  it("registration/event mismatch wins over the registration's own archived/module-disabled checks", async () => {
    const response = await send();
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual({
      code: ErrorCodes.CHECKIN_EVENT_MISMATCH,
      message: "Registration does not belong to this event",
    });
    expect(db.lockRegistrationForUpdate).toHaveBeenCalledWith(tx, REGISTRATION);
    expect(db.findRegistrationForMutation).toHaveBeenCalledWith(REGISTRATION, tx);
    expect(vi.mocked(db.getEventTenantScope).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(db.lockRegistrationForUpdate).mock.invocationCallOrder[0]!);
    expect(vi.mocked(db.lockRegistrationForUpdate).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(db.findRegistrationForMutation).mock.invocationCallOrder[0]!);
    expect(db.settleRegistrationTxn).not.toHaveBeenCalled();
    expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
  });

  it("a missing registration lock yields REGISTRATION_NOT_FOUND without a row read", async () => {
    vi.mocked(db.lockRegistrationForUpdate).mockResolvedValue(false);
    const response = await send();
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toEqual({ code: ErrorCodes.REGISTRATION_NOT_FOUND, message: "Registration not found" });
    expect(db.findRegistrationForMutation).not.toHaveBeenCalled();
  });

  it("body validation runs after route ownership but before the registration lookup", async () => {
    authAs(UserRole.CLIENT_ADMIN, OTHER);
    const forbidden = await send({ note: 123 });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe(ErrorCodes.FORBIDDEN);
    authAs(UserRole.CLIENT_ADMIN, OWNER);
    const invalid = await send({ note: 123 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(db.withLockingTxn).not.toHaveBeenCalled();
  });

  it("the controller's body-dependent pricing gate runs before registration/event mismatch", async () => {
    vi.mocked(db.getEventTenantScope).mockResolvedValue(routeScope("OPEN", ["registrations"]));
    const response = await send({ accessSelections: [] });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toEqual({ code: ErrorCodes.MODULE_DISABLED, message: "Pricing module is disabled for this client" });
    expect(db.withLockingTxn).not.toHaveBeenCalled();
  });
});
