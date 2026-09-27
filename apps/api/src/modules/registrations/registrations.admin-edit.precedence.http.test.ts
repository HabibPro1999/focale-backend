import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes, UserRole } from "@app/contracts";

const db = vi.hoisted(() => ({
  getUserWithClientById: vi.fn(),
  getEventForRegistrationAdmin: vi.fn(),
  findClientModuleState: vi.fn(),
  findRegistrationForMutation: vi.fn(),
  updateRegistrationRow: vi.fn(),
  withTxn: vi.fn(),
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<Record<string, unknown>>()), ...db,
}));
vi.mock("@app/integrations", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));

import { authAs } from "../../testing/auth";
import { createTestApp } from "../../testing/create-test-app";
import { txnPassthrough } from "../../testing/txn";
import { CONFIG } from "../../core/config";
import { AccessService } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { RegistrationsController } from "./registrations.controller";
import { RegistrationsReadService } from "./registrations.read.service";
import { RegistrationsCreateService } from "./registrations.create.service";
import { RegistrationsAdminService } from "./registrations.admin.service";

const eventId = "11111111-1111-4111-8111-111111111111";
const registrationId = "22222222-2222-4222-8222-222222222222";
const otherEventId = "33333333-3333-4333-8333-333333333333";
const url = `/api/events/${eventId}/registrations/${registrationId}/admin-edit`;

function registration({ owned = true, status = "OPEN", enabledModules = ["registrations"] } = {}) {
  return {
    id: registrationId,
    eventId: owned ? eventId : otherEventId,
    event: { status, client: { active: true, enabledModules } },
  };
}

describe("registration admin-edit HTTP precedence through the real service", () => {
  let app: NestFastifyApplication;
  let headers: { authorization: string };
  let payload: Record<string, unknown>;
  const request = () => app.inject({ method: "PUT", url, payload, headers });

  async function expectError(status: number, code: string, message: string) {
    const res = await request();
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ ok: false, error: { code, message }, requestId: "" });
    expect(db.updateRegistrationRow).not.toHaveBeenCalled();
  }

  beforeAll(async () => {
    app = await createTestApp({
      controllers: [RegistrationsController],
      providers: [
        RegistrationsReadService,
        RegistrationsCreateService,
        RegistrationsAdminService,
        { provide: AccessService, useValue: {} },
        { provide: PricingService, useValue: {} },
        { provide: CONFIG, useValue: {} },
      ],
    });
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    vi.resetAllMocks();
    headers = authAs(UserRole.CLIENT_ADMIN, "c1");
    payload = { note: "Admin edit" };
    db.getEventForRegistrationAdmin.mockResolvedValue({ id: eventId, clientId: "c1", status: "OPEN" });
    db.findClientModuleState.mockResolvedValue({ active: true, enabledModules: ["registrations", "pricing"] });
    db.findRegistrationForMutation.mockResolvedValue(registration({ owned: false, status: "ARCHIVED", enabledModules: [] }));
    db.withTxn.mockImplementation(txnPassthrough.withTxn);
  });

  it("route event missing wins before registration lookup and belongs-to-event", async () => {
    headers = authAs(UserRole.CLIENT_ADMIN, "c2");
    db.getEventForRegistrationAdmin.mockResolvedValue(null);
    await expectError(404, ErrorCodes.NOT_FOUND, "Event not found");
    expect(db.withTxn).not.toHaveBeenCalled();
    expect(db.findRegistrationForMutation).not.toHaveBeenCalled();
  });

  it("route ownership wins over archived, module-disabled and registration mismatch", async () => {
    db.getEventForRegistrationAdmin.mockResolvedValue({ id: eventId, clientId: "c2", status: "ARCHIVED" });
    db.findClientModuleState.mockResolvedValue({ active: true, enabledModules: [] });
    await expectError(403, ErrorCodes.FORBIDDEN, "Insufficient permissions");
    expect(db.findClientModuleState).not.toHaveBeenCalled();
    expect(db.withTxn).not.toHaveBeenCalled();
  });

  it("route archived wins over its module gate and registration mismatch", async () => {
    db.getEventForRegistrationAdmin.mockResolvedValue({ id: eventId, clientId: "c1", status: "ARCHIVED" });
    db.findClientModuleState.mockResolvedValue({ active: true, enabledModules: [] });
    await expectError(400, ErrorCodes.INVALID_STATUS_TRANSITION, "Archived events cannot be modified");
    expect(db.findClientModuleState).not.toHaveBeenCalled();
    expect(db.withTxn).not.toHaveBeenCalled();
  });

  it("route registration module gate wins over a missing registration", async () => {
    db.findClientModuleState.mockResolvedValue({ active: true, enabledModules: [] });
    db.findRegistrationForMutation.mockResolvedValue(null);
    await expectError(403, ErrorCodes.FORBIDDEN, "Registrations module is disabled for this client");
    expect(db.withTxn).not.toHaveBeenCalled();
  });

  it("route pricing gate runs for accessSelections, before belongs-to-event", async () => {
    payload = { accessSelections: [] };
    db.findClientModuleState.mockResolvedValue({ active: true, enabledModules: ["registrations"] });
    await expectError(403, ErrorCodes.FORBIDDEN, "Pricing module is disabled for this client");
    expect(db.findClientModuleState).toHaveBeenCalledTimes(2);
    expect(db.withTxn).not.toHaveBeenCalled();
  });

  it("route skips the pricing gate when accessSelections is absent", async () => {
    db.findClientModuleState.mockResolvedValue({ active: true, enabledModules: ["registrations"] });
    await expectError(400, ErrorCodes.BAD_REQUEST, "Registration does not belong to this event");
    expect(db.findClientModuleState).toHaveBeenCalledTimes(1);
    expect(db.withTxn).toHaveBeenCalledTimes(1);
  });

  it("transaction registration missing keeps REGISTRATION_NOT_FOUND, not the route's generic NOT_FOUND", async () => {
    db.findRegistrationForMutation.mockResolvedValue(null);
    await expectError(404, ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found");
    expect(db.findRegistrationForMutation).toHaveBeenCalledWith(registrationId, expect.any(Object));
  });

  it("transaction belongs-to-event wins over that registration's archived event and disabled module", async () => {
    await expectError(400, ErrorCodes.BAD_REQUEST, "Registration does not belong to this event");
    expect(db.withTxn).toHaveBeenCalledTimes(1);
    expect(db.findRegistrationForMutation).toHaveBeenCalledWith(registrationId, expect.any(Object));
  });

  it("transaction archived wins over its embedded module gate when event IDs match", async () => {
    db.findRegistrationForMutation.mockResolvedValue(registration({ status: "ARCHIVED", enabledModules: [] }));
    await expectError(400, ErrorCodes.INVALID_STATUS_TRANSITION, "Archived events cannot be modified");
  });

  it("transaction uses the registration's freshly loaded module state after route checks passed", async () => {
    db.findRegistrationForMutation.mockResolvedValue(registration({ enabledModules: [] }));
    await expectError(403, ErrorCodes.FORBIDDEN, "Registrations module is disabled for this client");
    expect(db.findClientModuleState).toHaveBeenCalledTimes(1);
  });
});
