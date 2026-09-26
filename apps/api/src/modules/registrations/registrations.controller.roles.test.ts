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
import { ErrorCodes, UserRole, type UserRoleValue } from "@app/contracts";

// Real AuthGuard runs; mock only its side-effecting deps and the controller's
// own event/tenant lookups.
vi.mock("@app/integrations", () => ({
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", () => ({
  getUserWithClientById: vi.fn(),
  getEventForRegistrationAdmin: vi.fn(),
  findClientModuleState: vi.fn(),
  // The exception filter calls these on every caught error; the real ones
  // return null for non-pg errors, which is all these tests throw.
  pgErrorCode: () => null,
  pgUniqueViolation: () => null,
}));

import { verifyToken } from "@app/integrations";
import {
  findClientModuleState,
  getEventForRegistrationAdmin,
  getUserWithClientById,
} from "@app/db";
import { ROLE_KEY } from "../../core/auth/auth.decorator";
import { AuthGuard } from "../../core/auth/auth.guard";
import { clearUserCache } from "../../core/auth/user-cache";
import { ZodValidationPipe } from "../../core/zod";
import { EnvelopeInterceptor } from "../../core/envelope.interceptor";
import { HttpExceptionFilter } from "../../core/http-exception.filter";
import { RegistrationsController } from "./registrations.controller";
import { RegistrationsService } from "./registrations.service";
import { RegistrationRepricer } from "./registrations.repricer";
import { RegistrationPaymentsService } from "./registrations.payments.service";

const eventId = "11111111-1111-4111-8111-111111111111";
const registrationId = "22222222-2222-4222-8222-222222222222";
const AUTH = { authorization: "Bearer test" };

const service = {
  deleteRegistration: vi.fn(async () => undefined),
  getRegistrationClientId: vi.fn(async () => "c1"),
};
const repricer = {
  adminEditRegistration: vi.fn(async () => ({ id: registrationId })),
};

@Module({
  controllers: [RegistrationsController],
  providers: [
    { provide: RegistrationsService, useValue: service },
    { provide: RegistrationRepricer, useValue: repricer },
    { provide: RegistrationPaymentsService, useValue: {} },
    Reflector,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class TestRegistrationsModule {}

function signedInAs(role: UserRoleValue) {
  vi.mocked(getUserWithClientById).mockResolvedValue({
    id: "u1",
    email: "u1@example.com",
    name: "User",
    role,
    clientId: "c1",
    active: true,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    client: { active: true },
  } as never);
}

describe("RegistrationsController role checks", () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearUserCache();
    vi.mocked(getEventForRegistrationAdmin).mockResolvedValue({
      id: eventId,
      clientId: "c1",
      status: "OPEN",
    } as never);
    vi.mocked(findClientModuleState).mockResolvedValue({
      active: true,
      enabledModules: ["registrations", "pricing"],
    } as never);
    app = await NestFactory.create<NestFastifyApplication>(
      TestRegistrationsModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("admin edit carries the role as metadata only: one guard, from the class", () => {
    const handler = RegistrationsController.prototype.adminEdit;
    expect(Reflect.getMetadata(ROLE_KEY, handler)).toBe(UserRole.CLIENT_ADMIN);
    expect(Reflect.getMetadata("__guards__", handler)).toBeUndefined();
    expect(Reflect.getMetadata("__guards__", RegistrationsController)).toEqual([AuthGuard]);
  });

  it("admin edit: a CLIENT_ADMIN passes and the token is verified once", async () => {
    signedInAs(UserRole.CLIENT_ADMIN);
    const res = await app.inject({
      method: "PUT",
      url: `/api/events/${eventId}/registrations/${registrationId}/admin-edit`,
      headers: AUTH,
      payload: { firstName: "Ada" },
    });
    expect(res.statusCode).toBe(200);
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(repricer.adminEditRegistration).toHaveBeenCalledWith(
      eventId,
      registrationId,
      { firstName: "Ada" },
      "u1",
    );
  });

  it("admin edit: a SCIENTIFIC_COMMITTEE user gets 403 before the handler", async () => {
    signedInAs(UserRole.SCIENTIFIC_COMMITTEE);
    const res = await app.inject({
      method: "PUT",
      url: `/api/events/${eventId}/registrations/${registrationId}/admin-edit`,
      headers: AUTH,
      payload: { firstName: "Ada" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: ErrorCodes.FORBIDDEN, message: "Insufficient permissions" });
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(getEventForRegistrationAdmin).not.toHaveBeenCalled();
    expect(repricer.adminEditRegistration).not.toHaveBeenCalled();
  });

  it("force delete: a non-admin role is refused by the tenant check before the service", async () => {
    signedInAs(UserRole.SCIENTIFIC_COMMITTEE);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/events/registrations/${registrationId}?force=true`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(403);
    expect(service.deleteRegistration).not.toHaveBeenCalled();
  });

  it("force delete: a CLIENT_ADMIN of the tenant reaches the service with force", async () => {
    signedInAs(UserRole.CLIENT_ADMIN);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/events/registrations/${registrationId}?force=true`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(service.deleteRegistration).toHaveBeenCalledWith(registrationId, "u1", true);
  });
});
