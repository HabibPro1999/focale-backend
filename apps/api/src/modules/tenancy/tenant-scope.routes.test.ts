import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Module, RequestMethod, type Type } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes, UserRole, type ModuleId, type UserRoleValue } from "@app/contracts";
import type { ClientRow } from "@app/db";

// ============================================================================
// Route matrix for plan 5.4: every route whose hand-written tenant resolver
// was replaced by a scope guard. For each route it checks
//   - the guard metadata (kind, id param, modules, write) against the table
//     below, which restates what the removed resolver did;
//   - that no route of these controllers is left without a scope guard;
//   - a request from another client's admin: 403 AUTH_1004 "Insufficient
//     permissions" (the same code as before), and nothing behind the guard
//     runs (no service method, no data read);
//   - a request for a missing resource: 404 with the unified code;
//   - the owner's admin and a super admin pass the guard, reading the id
//     from the right route param; archived events and disabled modules are
//     refused on the routes that checked them before.
// ============================================================================

vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // Every other data read fails loudly: a refused request must not reach one.
  const reads = Object.fromEntries(
    Object.entries(actual)
      .filter(([name, value]) => typeof value === "function" && /^(get|find|list|search|iterate)[A-Z]/.test(name))
      .map(([name]) => [name, vi.fn(async () => { throw new Error(`unexpected read ${name}`); })]),
  );
  return {
    ...actual,
    ...reads,
    getUserWithClientById: vi.fn(),
    getEventTenantScope: vi.fn(),
    getRegistrationTenantScope: vi.fn(),
    getSponsorshipTenantScope: vi.fn(),
    getEmailTemplateTenantScope: vi.fn(),
  };
});

import * as db from "@app/db";
import { AuthGuard } from "../../core/auth/auth.guard";
import { clearUserCache, type AuthUser } from "../../core/auth/user-cache";
import { ZodValidationPipe } from "../../core/zod";
import { EnvelopeInterceptor } from "../../core/envelope.interceptor";
import { HttpExceptionFilter } from "../../core/http-exception.filter";
import { ExportDownloads } from "../../core/exports/stream-download";
import { AbstractsController } from "../abstracts/abstracts.controller";
import { AbstractsConfigService } from "../abstracts/abstracts.config.service";
import { AbstractsAdminService } from "../abstracts/abstracts.admin.service";
import { AbstractsCommitteeService } from "../abstracts/abstracts.committee.service";
import { AbstractsBookService } from "../abstracts/abstracts.book.service";
import { EmailController } from "../email/email.controller";
import { EmailTemplateService } from "../email/email-template.service";
import { EmailSendService } from "../email/email-send.service";
import {
  RegistrationEditLinkController,
  RegistrationsController,
} from "../registrations/registrations.controller";
import { RegistrationsService } from "../registrations/registrations.service";
import { RegistrationRepricer } from "../registrations/registrations.repricer";
import { RegistrationPaymentsService } from "../registrations/registrations.payments.service";
import { RegistrationCreateService } from "../registrations/registrations.create.service";
import { PricingController } from "../pricing/pricing.controller";
import { PricingService } from "../pricing/pricing.service";
import { CheckinController } from "../checkin/checkin.controller";
import { CheckinService } from "../checkin/checkin.service";
import { ReportsController } from "../reports/reports.controller";
import { ReportsService } from "../reports/reports.service";
import {
  RegistrationSponsorshipsController,
  SponsorshipDetailController,
  SponsorshipsListController,
} from "../sponsorships/sponsorships.controller";
import { SponsorshipsAdminService } from "../sponsorships/sponsorships.admin.service";
import { TENANT_SCOPE, TenantScopeGuard, type TenantScopeKind, type TenantScopeRule } from "./tenant-scope";

// ----------------------------------------------------------------------------
// Expected scope per route. `module`/`write` restate the removed resolver:
// module = the assertClientModuleEnabled calls it made, write = it called
// assertEventWritable. One deliberate addition: the sponsorships export now
// needs the sponsorships module.
// ----------------------------------------------------------------------------
type Row = { kind: TenantScopeKind; param?: string; module?: ModuleId[]; write?: boolean };
const ev = (module: ModuleId[] = [], write = false): Row => ({ kind: "event", module, write });
const reg = (module: ModuleId[] = [], write = false, param = "id"): Row => ({ kind: "registration", param, module, write });
const spo = (module: ModuleId[] = []): Row => ({ kind: "sponsorship", module });
const tpl = (write: boolean): Row => ({ kind: "emailTemplate", module: ["emails"], write });
const ABS = ev(["abstracts"]);

const EXPECTED: Record<string, Row> = {
  // abstracts.controller.ts resolveEvent: 404 → 403 → abstracts module; no writable check.
  "AbstractsController.exportAbstracts": ABS,
  "AbstractsController.getConfig": ABS,
  "AbstractsController.patchConfig": ABS,
  "AbstractsController.listThemes": ABS,
  "AbstractsController.createTheme": ABS,
  "AbstractsController.updateTheme": ABS,
  "AbstractsController.deleteTheme": ABS,
  "AbstractsController.getAdditionalFields": ABS,
  "AbstractsController.setAdditionalFields": ABS,
  "AbstractsController.listAbstracts": ABS,
  "AbstractsController.getAbstract": ABS,
  "AbstractsController.finalize": ABS,
  "AbstractsController.reopen": ABS,
  "AbstractsController.presented": ABS,
  "AbstractsController.listCommittee": ABS,
  "AbstractsController.addCommittee": ABS,
  "AbstractsController.removeCommittee": ABS,
  "AbstractsController.setReviewerThemes": ABS,
  "AbstractsController.resetCommitteePassword": ABS,
  "AbstractsController.setCommitteePassword": ABS,
  "AbstractsController.assignReviewers": ABS,
  "AbstractsController.enqueueBookJob": ABS,
  "AbstractsController.listBookJobs": ABS,
  "AbstractsController.getBookJob": ABS,
  // email.controller.ts resolveEvent + assertAccess (+ assertEmailFeatureWritable
  // on writes); getTemplateWriteContext on template writes.
  "EmailController.list": ev(["emails"]),
  "EmailController.variables": ev(["emails"]),
  "EmailController.create": ev(["emails"], true),
  "EmailController.getOne": tpl(false),
  "EmailController.update": tpl(true),
  "EmailController.remove": tpl(true),
  "EmailController.duplicate": tpl(true),
  "EmailController.testSend": tpl(true),
  "EmailController.listLogs": ev(["emails"]),
  "EmailController.resendLog": ev(["emails"], true),
  "EmailController.bulkSend": ev(["emails"], true),
  "EmailController.sendCustom": ev(["emails"], true),
  // registrations.controller.ts loadEvent / getRegistrationClientId checks.
  // adminEdit keeps its body-dependent pricing gate in the handler.
  "RegistrationsController.columns": ev(),
  "RegistrationsController.search": ev(),
  "RegistrationsController.adminCreate": ev(["registrations", "pricing"], true),
  "RegistrationsController.adminEdit": ev(["registrations"], true),
  "RegistrationsController.list": ev(),
  "RegistrationsController.getById": reg(),
  "RegistrationsController.update": reg(["registrations"]),
  "RegistrationsController.remove": reg(["registrations"]),
  "RegistrationsController.confirm": reg(["registrations"]),
  "RegistrationsController.auditLogs": reg(),
  "RegistrationsController.emailLogs": reg(),
  "RegistrationsController.paymentProof": reg(),
  "RegistrationEditLinkController.editLink": reg(),
  // pricing.controller.ts ensureAccess(…, checkWritable) + pricing module.
  "PricingController.getPricing": ev(["pricing"]),
  "PricingController.updatePricing": ev(["pricing"], true),
  "PricingController.addRule": ev(["pricing"], true),
  "PricingController.updateRule": ev(["pricing"], true),
  "PricingController.deleteRule": ev(["pricing"], true),
  // checkin.controller.ts / reports.controller.ts authorizeEvent (404 → 403).
  "CheckinController.checkIn": ev(),
  "CheckinController.registrations": ev(),
  "CheckinController.stats": ev(),
  "CheckinController.sync": ev(),
  "ReportsController.analytics": ev(),
  "ReportsController.accessRegistrants": ev(),
  "ReportsController.financial": ev(),
  "ReportsController.exportRegistrations": ev(),
  "ReportsController.modularExport": ev(),
  "ReportsController.accessRegistrantsReport": ev(),
  "ReportsController.sponsorshipsReport": ev(["sponsorships"]), // new module check (5.4)
  "ReportsController.checkinExport": ev(),
  "ReportsController.summary": ev(),
  // sponsorships.controller.ts inline checks, requireRegistration and
  // requireWritableRegistration.
  "SponsorshipsListController.list": ev(),
  "SponsorshipDetailController.detail": spo(),
  "SponsorshipDetailController.update": spo(["sponsorships"]),
  "SponsorshipDetailController.remove": spo(["sponsorships"]),
  "RegistrationSponsorshipsController.available": reg([], false, "registrationId"),
  "RegistrationSponsorshipsController.linked": reg([], false, "registrationId"),
  "RegistrationSponsorshipsController.link": reg(["sponsorships"], true, "registrationId"),
  "RegistrationSponsorshipsController.linkByCode": reg(["sponsorships"], true, "registrationId"),
  "RegistrationSponsorshipsController.unlink": reg(["sponsorships"], true, "registrationId"),
};

// 404 per kind. Before 5.4 every one of these answered RES_3001 from the
// controllers; registration-not-found is now REG_8001 everywhere.
const NOT_FOUND: Record<TenantScopeKind, { code: string; message: string }> = {
  event: { code: ErrorCodes.NOT_FOUND, message: "Event not found" },
  registration: { code: ErrorCodes.REGISTRATION_NOT_FOUND, message: "Registration not found" },
  sponsorship: { code: ErrorCodes.NOT_FOUND, message: "Sponsorship not found" },
  emailTemplate: { code: ErrorCodes.NOT_FOUND, message: "Email template not found" },
};

const CONTROLLERS: Type[] = [
  AbstractsController,
  EmailController,
  RegistrationsController,
  RegistrationEditLinkController,
  PricingController,
  CheckinController,
  ReportsController,
  SponsorshipsListController,
  SponsorshipDetailController,
  RegistrationSponsorshipsController,
];

// Every service method is a spy; a refused request must call none of them.
const serviceCalls = vi.fn();
function serviceMock(name: string): unknown {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "then"
          ? undefined
          : (...args: unknown[]) => {
              serviceCalls(`${name}.${String(prop)}`, ...args);
              return undefined;
            },
    },
  );
}
const SERVICES: Type[] = [
  AbstractsConfigService,
  AbstractsAdminService,
  AbstractsCommitteeService,
  AbstractsBookService,
  ExportDownloads,
  EmailTemplateService,
  EmailSendService,
  RegistrationsService,
  RegistrationRepricer,
  RegistrationPaymentsService,
  RegistrationCreateService,
  PricingService,
  CheckinService,
  ReportsService,
  SponsorshipsAdminService,
];

@Module({
  controllers: CONTROLLERS,
  providers: [
    ...SERVICES.map((token) => ({ provide: token, useValue: serviceMock(token.name) })),
    Reflector,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class MatrixModule {}

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
// A distinct id per route param, so the test sees which one the guard reads.
const IDS: Record<string, string> = {
  eventId: "e0000000-0000-4000-8000-000000000001",
  id: "e0000000-0000-4000-8000-000000000002",
  registrationId: "e0000000-0000-4000-8000-000000000003",
  templateId: "e0000000-0000-4000-8000-000000000004",
};
const OTHER_PARAM = "e0000000-0000-4000-8000-0000000000ff";

type RouteCase = {
  name: string;
  controller: Type;
  handler: (...args: never[]) => unknown;
  method: string;
  url: string;
  params: Record<string, string>;
  rule: TenantScopeRule | undefined;
};

function routes(): RouteCase[] {
  const out: RouteCase[] = [];
  for (const controller of CONTROLLERS) {
    const proto = controller.prototype as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const handler = proto[key];
      if (key === "constructor" || typeof handler !== "function") continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      const full = `/${Reflect.getMetadata(PATH_METADATA, controller) as string}/${path}`;
      const params: Record<string, string> = {};
      const url = full.replace(/:([A-Za-z]+)/g, (_m, name: string) => (params[name] = IDS[name] ?? OTHER_PARAM));
      out.push({
        name: `${controller.name}.${key}`,
        controller,
        handler: handler as RouteCase["handler"],
        method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!,
        url,
        params,
        rule: Reflect.getMetadata(TENANT_SCOPE, handler) as TenantScopeRule | undefined,
      });
    }
  }
  return out;
}

const ROUTES = routes();

function scopeRow(status: "OPEN" | "ARCHIVED" = "OPEN", modules: string[] | null = ["abstracts", "emails", "registrations", "pricing", "sponsorships"], active = true) {
  return {
    event: { id: IDS.eventId!, clientId: OWNER, status, slug: "summit" },
    client: { id: OWNER, active, enabledModules: modules },
  };
}

function ownScopes(...args: Parameters<typeof scopeRow>) {
  const scope = scopeRow(...args);
  vi.mocked(db.getEventTenantScope).mockResolvedValue(scope);
  vi.mocked(db.getRegistrationTenantScope).mockResolvedValue({ registration: { id: IDS.id! }, ...scope });
  vi.mocked(db.getSponsorshipTenantScope).mockResolvedValue({ sponsorship: { id: IDS.id! }, ...scope });
  vi.mocked(db.getEmailTemplateTenantScope).mockResolvedValue({
    template: { id: IDS.templateId!, clientId: OWNER, eventId: IDS.eventId! },
    ...scope,
  });
}

const READS: Record<TenantScopeKind, ReturnType<typeof vi.fn>> = {
  event: vi.mocked(db.getEventTenantScope),
  registration: vi.mocked(db.getRegistrationTenantScope),
  sponsorship: vi.mocked(db.getSponsorshipTenantScope),
  emailTemplate: vi.mocked(db.getEmailTemplateTenantScope),
};

function user(role: UserRoleValue, clientId: string | null): AuthUser {
  return {
    id: "u1",
    email: "u1@example.com",
    name: "User",
    role,
    clientId,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function signIn(role: UserRoleValue, clientId: string | null) {
  clearUserCache();
  vi.mocked(db.getUserWithClientById).mockResolvedValue({
    ...user(role, clientId),
    client: clientId ? ({ id: clientId, active: true } as ClientRow) : null,
  } as never);
}

/** Run the route's scope guard directly, as Nest would for this handler. */
async function runGuard(route: RouteCase, who: AuthUser) {
  const req = { user: who, params: route.params } as Record<string, unknown>;
  const ctx = new ExecutionContextHost([req, {}, () => undefined], route.controller, route.handler as never);
  ctx.setType("http");
  const ok = await new TenantScopeGuard(new Reflector()).canActivate(ctx);
  return { ok, scope: req.tenantScope };
}

describe("tenant scope route matrix (5.4)", () => {
  it("covers every route of the converted controllers, and nothing else", () => {
    expect(ROUTES.map((r) => r.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(ROUTES).toHaveLength(76);
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: guard metadata", (name, route) => {
    const row = EXPECTED[name]!;
    expect(route.rule).toEqual({
      kind: row.kind,
      param: row.param ?? { event: "eventId", registration: "id", sponsorship: "id", emailTemplate: "templateId" }[row.kind],
      modules: row.module ?? [],
      write: row.write ?? false,
    });
    expect(route.params).toHaveProperty(route.rule!.param);
    // The scope guard is the route's; authentication is the controller's @Auth().
    expect(Reflect.getMetadata(GUARDS_METADATA, route.handler)).toContain(TenantScopeGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, route.controller)).toEqual([AuthGuard]);
  });

  describe("over HTTP", () => {
    let app: NestFastifyApplication;
    beforeAll(async () => {
      app = await NestFactory.create<NestFastifyApplication>(MatrixModule, new FastifyAdapter(), {
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
      ownScopes();
    });

    const send = (route: RouteCase) =>
      app.inject({
        method: route.method as "GET",
        url: route.url,
        headers: { authorization: "Bearer test" },
        ...(route.method === "GET" ? {} : { payload: {} }),
      });

    it.each(ROUTES.map((r) => [r.name, r] as const))(
      "%s: another client's admin gets 403 AUTH_1004 and nothing behind the guard runs",
      async (_name, route) => {
        signIn(UserRole.CLIENT_ADMIN, OTHER);
        const res = await send(route);
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toEqual({ code: ErrorCodes.FORBIDDEN, message: "Insufficient permissions" });
        expect(READS[route.rule!.kind]).toHaveBeenCalledWith(route.params[route.rule!.param]);
        expect(serviceCalls).not.toHaveBeenCalled();
      },
    );

    it.each(ROUTES.map((r) => [r.name, r] as const))(
      "%s: a missing resource is 404 with its unified code, for the owner too",
      async (_name, route) => {
        signIn(UserRole.CLIENT_ADMIN, OWNER);
        READS[route.rule!.kind].mockResolvedValue(null);
        const res = await send(route);
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toEqual(NOT_FOUND[route.rule!.kind]);
        expect(serviceCalls).not.toHaveBeenCalled();
      },
    );
  });

  describe("the guard itself", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      ownScopes();
    });

    it.each(ROUTES.map((r) => [r.name, r] as const))(
      "%s: lets the owner's admin and a super admin through, reading the right id",
      async (_name, route) => {
        for (const who of [user(UserRole.CLIENT_ADMIN, OWNER), user(UserRole.SUPER_ADMIN, null)]) {
          const { ok, scope } = await runGuard(route, who);
          expect(ok).toBe(true);
          expect(scope).toEqual(scopeRow());
        }
        expect(READS[route.rule!.kind]).toHaveBeenCalledWith(route.params[route.rule!.param]);
        await expect(runGuard(route, user(UserRole.SCIENTIFIC_COMMITTEE, OWNER))).rejects.toMatchObject({
          status: 403,
        });
      },
    );

    it.each(ROUTES.filter((r) => r.rule!.write).map((r) => [r.name, r] as const))(
      "%s: refuses an archived event",
      async (_name, route) => {
        ownScopes("ARCHIVED");
        await expect(runGuard(route, user(UserRole.CLIENT_ADMIN, OWNER))).rejects.toMatchObject({
          status: 400,
          response: { code: ErrorCodes.INVALID_STATUS_TRANSITION },
        });
      },
    );

    it.each(ROUTES.filter((r) => !r.rule!.write).map((r) => [r.name, r] as const))(
      "%s: does not check the event state",
      async (_name, route) => {
        ownScopes("ARCHIVED");
        await expect(runGuard(route, user(UserRole.CLIENT_ADMIN, OWNER))).resolves.toMatchObject({ ok: true });
      },
    );

    it.each(ROUTES.filter((r) => r.rule!.modules.length > 0).map((r) => [r.name, r] as const))(
      "%s: refuses an inactive client and each disabled module, with distinct codes",
      async (_name, route) => {
        ownScopes("OPEN", ["abstracts", "emails", "registrations", "pricing", "sponsorships"], false);
        await expect(runGuard(route, user(UserRole.SUPER_ADMIN, null))).rejects.toMatchObject({
          status: 403,
          response: { code: ErrorCodes.CLIENT_INACTIVE },
        });
        for (const moduleId of route.rule!.modules) {
          ownScopes("OPEN", ["abstracts", "emails", "registrations", "pricing", "sponsorships"].filter((m) => m !== moduleId));
          await expect(runGuard(route, user(UserRole.SUPER_ADMIN, null))).rejects.toMatchObject({
            status: 403,
            response: { code: ErrorCodes.MODULE_DISABLED },
          });
        }
      },
    );

    it.each(ROUTES.filter((r) => r.rule!.modules.length === 0).map((r) => [r.name, r] as const))(
      "%s: has no module gate",
      async (_name, route) => {
        ownScopes("OPEN", [], false);
        await expect(runGuard(route, user(UserRole.SUPER_ADMIN, null))).resolves.toMatchObject({ ok: true });
      },
    );
  });
});
