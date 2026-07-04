import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import {
  APP_FILTER,
  APP_INTERCEPTOR,
  APP_PIPE,
  NestFactory,
  Reflector,
} from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { UserRole } from "@app/contracts";
import type { ClientRow } from "@app/db";

// Real AuthGuard runs; only its two side-effecting deps + getEventWithPricing
// (the per-route ownership lookup) are mocked.
vi.mock("@app/integrations", () => ({
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", () => ({
  // The service module (imported by the controller) reads this at load time.
  CHECKIN_ELIGIBLE_STATUSES: ["PAID", "SPONSORED", "WAIVED"],
  getUserWithClientById: vi.fn(),
  getUserIdsByClient: vi.fn(async () => []),
  getEventWithPricing: vi.fn(),
  // The exception filter calls these on every caught error; the real
  // implementations return null for non-pg errors, which is all these
  // tests throw.
  pgErrorCode: () => null,
  pgUniqueViolation: () => null,
}));

import { getUserWithClientById, getEventWithPricing } from "@app/db";
import { clearUserCache } from "../../core/auth/user-cache";
import { ZodValidationPipe } from "../../core/zod";
import { EnvelopeInterceptor } from "../../core/envelope.interceptor";
import { HttpExceptionFilter } from "../../core/http-exception.filter";
import { CheckinController } from "./checkin.controller";
import { CheckinService } from "./checkin.service";

const getUser = vi.mocked(getUserWithClientById);
const getEvent = vi.mocked(getEventWithPricing);

const clientId = "11111111-1111-4111-8111-111111111111";
const otherClientId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const registrationId = "44444444-4444-4444-8444-444444444444";
const AUTH = { authorization: "Bearer test" };

function dbUser(role: number, userClientId: string | null, client: ClientRow | null) {
  return {
    id: "u1",
    email: "u1@example.com",
    name: "User One",
    role,
    clientId: userClientId,
    active: true,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    client,
  };
}

const service = {
  checkIn: vi.fn(),
  getCheckInRegistrations: vi.fn(),
  getCheckInStats: vi.fn(),
  batchSync: vi.fn(),
};

@Module({
  controllers: [CheckinController],
  providers: [
    { provide: CheckinService, useValue: service },
    Reflector,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class TestCheckinModule {}

describe("CheckinController (guards)", () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearUserCache();
    // Default caller: super admin (passes canAccessClient for any event).
    getUser.mockResolvedValue(dbUser(UserRole.SUPER_ADMIN, null, null));
    getEvent.mockResolvedValue({ id: eventId, clientId } as never);

    app = await NestFactory.create<NestFastifyApplication>(
      TestCheckinModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects unauthenticated requests (401) before the handler", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/events/${eventId}/checkin`,
      payload: { registrationId },
    });

    expect(res.statusCode).toBe(401);
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it("returns 404 when the event does not exist (no service call)", async () => {
    getEvent.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${eventId}/checkin`,
      headers: AUTH,
      payload: { registrationId },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe("Event not found");
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it("returns 403 when a client admin does not own the event (no service call)", async () => {
    getUser.mockResolvedValue(
      dbUser(UserRole.CLIENT_ADMIN, otherClientId, {
        id: otherClientId,
        active: true,
      } as ClientRow),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${eventId}/checkin`,
      headers: AUTH,
      payload: { registrationId },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("Insufficient permissions");
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it("returns 403 for a scientific-committee user (never passes canAccessClient)", async () => {
    getUser.mockResolvedValue(
      dbUser(UserRole.SCIENTIFIC_COMMITTEE, clientId, {
        id: clientId,
        active: true,
      } as ClientRow),
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/events/${eventId}/checkin/stats`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(403);
    expect(service.getCheckInStats).not.toHaveBeenCalled();
  });

  it("passes through to the service on success (POST checkin = 200, not 201)", async () => {
    service.checkIn.mockResolvedValue({
      success: true,
      alreadyCheckedIn: false,
      checkedInAt: new Date("2026-04-03T10:00:00Z"),
      registration: { id: registrationId },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${eventId}/checkin`,
      headers: AUTH,
      payload: { registrationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(true);
    expect(service.checkIn).toHaveBeenCalledWith(
      eventId,
      registrationId,
      undefined,
      "u1",
    );
  });

  it("rejects an invalid body (400, no service call)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/events/${eventId}/checkin`,
      headers: AUTH,
      payload: { registrationId: "not-a-uuid" },
    });

    expect(res.statusCode).toBe(400);
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it("batch sync returns 200 and delegates the check-in list", async () => {
    service.batchSync.mockResolvedValue({
      synced: 0,
      alreadyCheckedIn: 0,
      errors: [],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${eventId}/checkin/sync`,
      headers: AUTH,
      payload: { checkIns: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(service.batchSync).toHaveBeenCalledWith(eventId, [], "u1");
  });
});
