import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { z } from "zod";
import { ErrorCodes, UserRole, type UserRoleValue } from "@app/contracts";
import type { ClientRow, ScopedClientRow, ScopedEventRow } from "@app/db";

// Real AuthGuard, tenant scope guard, pipe, interceptor and filter; only the
// token check, the user read and the four scope reads are faked.
vi.mock("@app/integrations", () => ({
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", () => ({
  getUserWithClientById: vi.fn(),
  getEventTenantScope: vi.fn(),
  getRegistrationTenantScope: vi.fn(),
  getSponsorshipTenantScope: vi.fn(),
  getEmailTemplateTenantScope: vi.fn(),
  getFormTenantScope: vi.fn(),
  getClientTenantScope: vi.fn(),
  pgErrorCode: () => null,
  pgUniqueViolation: () => null,
}));

import {
  getClientTenantScope,
  getEmailTemplateTenantScope,
  getEventTenantScope,
  getFormTenantScope,
  getRegistrationTenantScope,
  getSponsorshipTenantScope,
  getUserWithClientById,
} from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { clearUserCache } from "../../core/auth/user-cache";
import { createZodDto, ZodValidationPipe } from "../../core/zod";
import { EnvelopeInterceptor } from "../../core/envelope.interceptor";
import { HttpExceptionFilter } from "../../core/http-exception.filter";
import {
  ClientScoped,
  EmailTemplateScoped,
  EventScoped,
  FormScoped,
  RegistrationScoped,
  ScopedClient,
  ScopedEvent,
  SponsorshipScoped,
} from "./tenant-scope";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";
const REG = "44444444-4444-4444-8444-444444444444";
const TPL = "55555555-5555-4555-8555-555555555555";
const AUTH = { authorization: "Bearer test" };

class EventParam extends createZodDto(z.strictObject({ eventId: z.string().uuid() })) {}
class IdParam extends createZodDto(z.strictObject({ id: z.string().uuid() })) {}
class TplParam extends createZodDto(z.strictObject({ templateId: z.string().uuid() })) {}
class NameBody extends createZodDto(z.strictObject({ name: z.string().min(1) })) {}

const reached = vi.fn();

@Controller("t")
@Auth()
class FixtureController {
  @Get("events/:eventId")
  @EventScoped()
  read(@Param() { eventId }: EventParam, @ScopedEvent() event: ScopedEventRow) {
    reached("read", eventId);
    return { event };
  }

  @Post("events/:eventId")
  @EventScoped({ module: ["registrations", "pricing"], write: true })
  write(
    @Param() { eventId }: EventParam,
    @Body() body: NameBody,
    @ScopedClient() client: ScopedClientRow,
  ) {
    reached("write", eventId, body.name);
    return { client };
  }

  @Get("registrations/:id")
  @RegistrationScoped({ module: "registrations" })
  registration(@Param() { id }: IdParam) {
    reached("registration", id);
    return { id };
  }

  @Get("sponsorships/:id")
  @SponsorshipScoped({ module: "sponsorships" })
  sponsorship(@Param() { id }: IdParam) {
    reached("sponsorship", id);
    return { id };
  }

  @Get("templates/:templateId")
  @EmailTemplateScoped({ module: "emails" })
  template(@Param() { templateId }: TplParam) {
    reached("template", templateId);
    return { templateId };
  }

  @Post("templates/:templateId")
  @EmailTemplateScoped({ module: "emails", write: true })
  templateWrite(@Param() { templateId }: TplParam) {
    reached("templateWrite", templateId);
    return { templateId };
  }

  @Get("forms/:id")
  @FormScoped({ moduleOfFormType: true })
  form(@Param() { id }: IdParam) {
    reached("form", id);
    return { id };
  }

  @Get("clients/:id")
  @ClientScoped()
  client(@Param() { id }: IdParam, @ScopedClient() client: ScopedClientRow) {
    reached("client", id);
    return { client };
  }

  // Misuse: a client scope has no event.
  @Get("clients/:id/event")
  @ClientScoped()
  clientEvent(@Param() _params: IdParam, @ScopedEvent() event: ScopedEventRow) {
    return { event };
  }
}

// No @Auth: the scope guard itself refuses a request without a user.
@Controller("unauthed")
class NoAuthController {
  @Get(":eventId")
  @EventScoped()
  read(@Param() { eventId }: EventParam) {
    reached("unauthed", eventId);
    return {};
  }
}

@Module({
  controllers: [FixtureController, NoAuthController],
  providers: [
    Reflector,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class FixtureModule {}

const eventScope = (overrides: { status?: "OPEN" | "CLOSED" | "ARCHIVED"; active?: boolean; modules?: string[] | null } = {}) => ({
  event: { id: EVENT, clientId: OWNER, status: overrides.status ?? "OPEN", slug: "summit" },
  client: {
    id: OWNER,
    active: overrides.active ?? true,
    enabledModules: overrides.modules === undefined ? ["registrations", "pricing", "sponsorships", "emails"] : overrides.modules,
  },
});

function signIn(role: UserRoleValue, clientId: string | null) {
  clearUserCache();
  vi.mocked(getUserWithClientById).mockResolvedValue({
    id: "u1",
    email: "u1@example.com",
    name: "User",
    role,
    clientId,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    client: clientId ? ({ id: clientId, active: true } as ClientRow) : null,
  } as never);
}

describe("tenant scope guard (5.4)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(FixtureModule, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    signIn(UserRole.CLIENT_ADMIN, OWNER);
    vi.mocked(getEventTenantScope).mockResolvedValue(eventScope());
    vi.mocked(getRegistrationTenantScope).mockResolvedValue({ registration: { id: REG }, ...eventScope() });
    vi.mocked(getSponsorshipTenantScope).mockResolvedValue({ sponsorship: { id: REG }, ...eventScope() });
    vi.mocked(getEmailTemplateTenantScope).mockResolvedValue({
      template: { id: TPL, clientId: OWNER, eventId: EVENT },
      ...eventScope(),
    });
  });

  const get = (url: string) => app.inject({ method: "GET", url, headers: AUTH });
  const post = (url: string, payload: unknown = { name: "x" }) =>
    app.inject({ method: "POST", url, headers: AUTH, payload: payload as object });
  const error = (res: { json: () => unknown }) => (res.json() as { error: { code: string; message: string } }).error;

  it("lets the owner's admin through and hands the scoped event and client to the handler", async () => {
    const res = await get(`/t/events/${EVENT}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.event).toEqual(eventScope().event);
    expect(getEventTenantScope).toHaveBeenCalledWith(EVENT);
    expect(getEventTenantScope).toHaveBeenCalledTimes(1);

    const written = await post(`/t/events/${EVENT}`);
    expect(written.statusCode).toBe(201);
    expect(written.json().data.client).toEqual(eventScope().client);
    expect(reached).toHaveBeenCalledWith("write", EVENT, "x");
  });

  it("lets a super admin through for any client", async () => {
    signIn(UserRole.SUPER_ADMIN, null);
    expect((await get(`/t/events/${EVENT}`)).statusCode).toBe(200);
  });

  it("401 without a token (AuthGuard), and 401 from the scope guard on a route without @Auth", async () => {
    const res = await app.inject({ method: "GET", url: `/t/events/${EVENT}` });
    expect(res.statusCode).toBe(401);
    const unauthed = await get(`/unauthed/${EVENT}`);
    expect(unauthed.statusCode).toBe(401);
    expect(error(unauthed)).toMatchObject({ code: ErrorCodes.UNAUTHORIZED, message: "Authentication required" });
    expect(getEventTenantScope).not.toHaveBeenCalled();
    expect(reached).not.toHaveBeenCalled();
  });

  it("400 for a malformed id before any lookup (the route's param DTO, as the pipe would)", async () => {
    const res = await get(`/t/events/not-a-uuid`);
    expect(res.statusCode).toBe(400);
    expect(error(res).code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(getEventTenantScope).not.toHaveBeenCalled();
  });

  it("404 per resource kind, with one code per condition", async () => {
    vi.mocked(getEventTenantScope).mockResolvedValue(null);
    vi.mocked(getRegistrationTenantScope).mockResolvedValue(null);
    vi.mocked(getSponsorshipTenantScope).mockResolvedValue(null);
    vi.mocked(getEmailTemplateTenantScope).mockResolvedValue(null);
    const cases = [
      [`/t/events/${EVENT}`, ErrorCodes.NOT_FOUND, "Event not found"],
      [`/t/registrations/${REG}`, ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found"],
      [`/t/sponsorships/${REG}`, ErrorCodes.NOT_FOUND, "Sponsorship not found"],
      [`/t/templates/${TPL}`, ErrorCodes.NOT_FOUND, "Email template not found"],
    ] as const;
    for (const [url, code, message] of cases) {
      const res = await get(url);
      expect({ url, status: res.statusCode, ...error(res) }).toMatchObject({ url, status: 404, code, message });
    }
    expect(reached).not.toHaveBeenCalled();
  });

  it("403 for another client's admin and for roles below client admin, before body validation", async () => {
    signIn(UserRole.CLIENT_ADMIN, OTHER);
    for (const res of [
      await get(`/t/events/${EVENT}`),
      await post(`/t/events/${EVENT}`, { invalid: true }),
      await get(`/t/registrations/${REG}`),
      await get(`/t/sponsorships/${REG}`),
      await get(`/t/templates/${TPL}`),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(error(res)).toEqual({ code: ErrorCodes.FORBIDDEN, message: "Insufficient permissions" });
    }
    signIn(UserRole.SCIENTIFIC_COMMITTEE, OWNER);
    expect((await get(`/t/events/${EVENT}`)).statusCode).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it("write routes refuse an archived event (400) before the module gate", async () => {
    vi.mocked(getEventTenantScope).mockResolvedValue(eventScope({ status: "ARCHIVED", active: false }));
    const res = await post(`/t/events/${EVENT}`);
    expect(res.statusCode).toBe(400);
    expect(error(res)).toMatchObject({
      code: ErrorCodes.INVALID_STATUS_TRANSITION,
      message: "Archived events cannot be modified",
    });
    // Read routes do not check the event state.
    expect((await get(`/t/events/${EVENT}`)).statusCode).toBe(200);
  });

  it("module gates: CLIENT_INACTIVE and MODULE_DISABLED are distinct 403s, checked in order", async () => {
    vi.mocked(getEventTenantScope).mockResolvedValue(eventScope({ active: false }));
    const inactive = await post(`/t/events/${EVENT}`);
    expect(inactive.statusCode).toBe(403);
    expect(error(inactive)).toEqual({ code: ErrorCodes.CLIENT_INACTIVE, message: "Client is inactive" });

    vi.mocked(getEventTenantScope).mockResolvedValue(eventScope({ modules: ["registrations"] }));
    const disabled = await post(`/t/events/${EVENT}`);
    expect(disabled.statusCode).toBe(403);
    expect(error(disabled)).toEqual({
      code: ErrorCodes.MODULE_DISABLED,
      message: "Pricing module is disabled for this client",
    });

    vi.mocked(getEventTenantScope).mockResolvedValue(eventScope({ modules: null }));
    expect(error(await post(`/t/events/${EVENT}`)).code).toBe(ErrorCodes.MODULE_DISABLED);
    expect(reached).not.toHaveBeenCalled();
  });

  it("email templates: both the template's and its event's client must be reachable", async () => {
    vi.mocked(getEmailTemplateTenantScope).mockResolvedValue({
      template: { id: TPL, clientId: OTHER, eventId: EVENT },
      ...eventScope(),
    });
    expect((await get(`/t/templates/${TPL}`)).statusCode).toBe(403);
    expect((await post(`/t/templates/${TPL}`)).statusCode).toBe(403);
  });

  it("email templates without an event: readable without a module gate, never writable", async () => {
    vi.mocked(getEmailTemplateTenantScope).mockResolvedValue({
      template: { id: TPL, clientId: OWNER, eventId: null },
      event: null,
      client: null,
    });
    expect((await get(`/t/templates/${TPL}`)).statusCode).toBe(200);
    const write = await post(`/t/templates/${TPL}`);
    expect(write.statusCode).toBe(400);
    expect(error(write)).toMatchObject({
      code: ErrorCodes.VALIDATION_ERROR,
      message: "Email template is not event-scoped",
    });
    // Another client's admin gets 403 first, whatever the template's shape.
    signIn(UserRole.CLIENT_ADMIN, OTHER);
    expect((await post(`/t/templates/${TPL}`)).statusCode).toBe(403);
  });

  it("an email template whose event row is gone is a missing event (404)", async () => {
    vi.mocked(getEmailTemplateTenantScope).mockResolvedValue({
      template: { id: TPL, clientId: OWNER, eventId: EVENT },
      event: null,
      client: null,
    });
    const res = await get(`/t/templates/${TPL}`);
    expect(res.statusCode).toBe(404);
    expect(error(res)).toMatchObject({ code: ErrorCodes.NOT_FOUND, message: "Event not found" });
  });

  it("form routes gate on the module of the form's type (5.4b)", async () => {
    const formScope = (type: "SPONSOR" | "REGISTRATION", modules: string[]) => ({
      form: { id: REG, type },
      ...eventScope({ modules }),
    });
    vi.mocked(getFormTenantScope).mockResolvedValue(formScope("SPONSOR", ["registrations"]));
    const sponsor = await get(`/t/forms/${REG}`);
    expect(sponsor.statusCode).toBe(403);
    expect(error(sponsor)).toEqual({
      code: ErrorCodes.MODULE_DISABLED,
      message: "Sponsorships module is disabled for this client",
    });
    vi.mocked(getFormTenantScope).mockResolvedValue(formScope("REGISTRATION", ["registrations"]));
    expect((await get(`/t/forms/${REG}`)).statusCode).toBe(200);
    vi.mocked(getFormTenantScope).mockResolvedValue(formScope("REGISTRATION", ["sponsorships"]));
    expect(error(await get(`/t/forms/${REG}`)).code).toBe(ErrorCodes.MODULE_DISABLED);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it("client routes: 404 Client not found, 403 for another client, the client for its admin (5.4b)", async () => {
    const client = eventScope().client;
    vi.mocked(getClientTenantScope).mockResolvedValue({ client });
    const own = await get(`/t/clients/${OWNER}`);
    expect(own.statusCode).toBe(200);
    expect(own.json().data.client).toEqual(client);
    expect(getClientTenantScope).toHaveBeenCalledWith(OWNER);

    signIn(UserRole.CLIENT_ADMIN, OTHER);
    const other = await get(`/t/clients/${OWNER}`);
    expect(other.statusCode).toBe(403);
    expect(error(other)).toEqual({ code: ErrorCodes.FORBIDDEN, message: "Insufficient permissions" });

    vi.mocked(getClientTenantScope).mockResolvedValue(null);
    const missing = await get(`/t/clients/${OWNER}`);
    expect(missing.statusCode).toBe(404);
    expect(error(missing)).toEqual({ code: ErrorCodes.NOT_FOUND, message: "Client not found" });
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it("@ScopedEvent() on a client-scoped route is a 500, never a silent null", async () => {
    signIn(UserRole.SUPER_ADMIN, null);
    vi.mocked(getClientTenantScope).mockResolvedValue({ client: eventScope().client });
    expect((await get(`/t/clients/${OWNER}/event`)).statusCode).toBe(500);
  });
});
