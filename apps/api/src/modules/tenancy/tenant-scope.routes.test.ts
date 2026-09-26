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
// Route matrix for plan 5.4 (and 5.4b): every route whose hand-written tenant
// resolver was replaced by a scope guard. For each route it checks
//   - the guard metadata (kind, id param, modules, write) against the table
//     below, which restates what the removed resolver did;
//   - that every other route of these controllers is listed as checking a
//     body/query id in the handler (`requireTenantScope`, tested over HTTP
//     below) or as needing no tenant scope, with the reason;
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
    getAccessItemTenantScope: vi.fn(),
    getCertificateTemplateTenantScope: vi.fn(),
    getFormTenantScope: vi.fn(),
    getClientTenantScope: vi.fn(),
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
import { AccessController } from "../access/access.controller";
import { AccessService } from "../access/access.service";
import { CertificatesController } from "../certificates/certificates.controller";
import { CertificatesService } from "../certificates/certificates.service";
import { EventsController } from "../events/events.controller";
import { EventsService } from "../events/events.service";
import { FormsController } from "../forms/forms.controller";
import { FormsService } from "../forms/forms.service";
import { ClientsController } from "../clients/clients.controller";
import { ClientsService } from "../clients/clients.service";
import { TENANT_SCOPE, TenantScopeGuard, type TenantScopeKind, type TenantScopeRule } from "./tenant-scope";

// ----------------------------------------------------------------------------
// Expected scope per route. `module`/`write` restate the removed resolver:
// module = the assertClientModuleEnabled calls it made, write = it called
// assertEventWritable. One deliberate addition: the sponsorships export now
// needs the sponsorships module.
// ----------------------------------------------------------------------------
type Row = {
  kind: TenantScopeKind;
  param?: string;
  module?: ModuleId[];
  write?: boolean;
  moduleOfFormType?: boolean;
};
const ev = (module: ModuleId[] = [], write = false): Row => ({ kind: "event", module, write });
const evId = (module: ModuleId[] = [], write = false): Row => ({ kind: "event", param: "id", module, write });
const reg = (module: ModuleId[] = [], write = false, param = "id"): Row => ({ kind: "registration", param, module, write });
const spo = (module: ModuleId[] = []): Row => ({ kind: "sponsorship", module });
const tpl = (write: boolean): Row => ({ kind: "emailTemplate", module: ["emails"], write });
const acc = (write = false): Row => ({ kind: "accessItem", module: ["registrations"], write });
const cert = (write = false): Row => ({ kind: "certificateTemplate", module: ["certificates"], write });
// A form route gated on its type's module (moduleOfFormType) or on a fixed one.
const frm = (write = false, module: ModuleId[] = []): Row => ({
  kind: "form",
  module,
  write,
  moduleOfFormType: module.length === 0,
});
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
  // 5.4b. access.controller.ts assertEventAccess (+ access lookup) →
  // assertEventWritable on writes → registrations module.
  "AccessController.create": ev(["registrations"], true),
  "AccessController.list": ev(["registrations"]),
  "AccessController.getOne": acc(),
  "AccessController.update": acc(true),
  "AccessController.remove": acc(true),
  // certificates.controller.ts assertEventAccess / getTemplate + canAccessClient
  // → writable on writes → certificates module (+ emails to send).
  "CertificatesController.list": ev(["certificates"]),
  "CertificatesController.create": ev(["certificates"], true),
  "CertificatesController.getOne": cert(),
  "CertificatesController.update": cert(true),
  "CertificatesController.remove": cert(true),
  "CertificatesController.uploadImage": cert(true),
  "CertificatesController.downloadImage": cert(),
  "CertificatesController.send": ev(["certificates", "emails"], true),
  // events.controller.ts requireOwnedEvent (writable only on the banner upload).
  "EventsController.getById": evId(),
  "EventsController.update": evId(),
  "EventsController.remove": evId(),
  "EventsController.uploadBanner": evId([], true),
  // forms.controller.ts event lookups and requireOwnedForm; the by-id routes
  // gated on the form type's module, except sponsorship settings.
  "FormsController.getSponsorByEvent": evId(["sponsorships"]),
  "FormsController.createSponsorByEvent": evId(["sponsorships"], true),
  "FormsController.getOne": frm(),
  "FormsController.sponsorshipModeLocked": frm(),
  "FormsController.updateSponsorshipSettings": frm(true, ["sponsorships"]),
  "FormsController.update": frm(true),
  "FormsController.remove": frm(true),
  // clients.controller.ts canAccessClient(user, :id).
  "ClientsController.getById": { kind: "client" },
};

// Routes of these controllers without a scope guard. Their event or client id
// comes from the body or the query: the handler calls requireTenantScope once
// the pipes have validated it (tested over HTTP below).
const IN_HANDLER = [
  "EventsController.create", // body.clientId
  "FormsController.create", // body.eventId
  "FormsController.list", // query.eventId, modules by query.type
];
// No tenant scope needed.
const UNSCOPED = [
  "EventsController.list", // a client admin's list is filtered to their own client
  "ClientsController.getMe", // the caller's own client
  "ClientsController.create", // super admin only
  "ClientsController.list", // super admin only
  "ClientsController.update", // super admin only
  "ClientsController.remove", // super admin only
];

// 404 per kind. Before 5.4 every one of these answered RES_3001 from the
// controllers; registration-not-found is now REG_8001 everywhere.
const NOT_FOUND: Record<TenantScopeKind, { code: string; message: string }> = {
  event: { code: ErrorCodes.NOT_FOUND, message: "Event not found" },
  registration: { code: ErrorCodes.REGISTRATION_NOT_FOUND, message: "Registration not found" },
  sponsorship: { code: ErrorCodes.NOT_FOUND, message: "Sponsorship not found" },
  emailTemplate: { code: ErrorCodes.NOT_FOUND, message: "Email template not found" },
  // 5.4b: the codes and messages the removed resolvers answered.
  accessItem: { code: ErrorCodes.ACCESS_NOT_FOUND, message: "Access item not found" },
  certificateTemplate: { code: ErrorCodes.NOT_FOUND, message: "Certificate template not found" },
  form: { code: ErrorCodes.NOT_FOUND, message: "Form not found" },
  client: { code: ErrorCodes.NOT_FOUND, message: "Client not found" },
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
  AccessController,
  CertificatesController,
  EventsController,
  FormsController,
  ClientsController,
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
  AccessService,
  CertificatesService,
  EventsService,
  FormsService,
  ClientsService,
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

const ALL_ROUTES = routes();
const ROUTES = ALL_ROUTES.filter((r) => r.rule !== undefined);

const ALL_MODULES: ModuleId[] = ["abstracts", "emails", "registrations", "pricing", "sponsorships", "certificates"];
type FormType = "REGISTRATION" | "SPONSOR";
const TYPE_MODULE: Record<FormType, ModuleId> = { SPONSOR: "sponsorships", REGISTRATION: "registrations" };

function scopeRow(status: "OPEN" | "ARCHIVED" = "OPEN", modules: string[] | null = ALL_MODULES, active = true) {
  return {
    event: { id: IDS.eventId!, clientId: OWNER, status, slug: "summit" },
    client: { id: OWNER, active, enabledModules: modules },
  };
}

function ownScopes(status?: "OPEN" | "ARCHIVED", modules?: string[] | null, active?: boolean, formType: FormType = "SPONSOR") {
  const scope = scopeRow(status, modules, active);
  vi.mocked(db.getEventTenantScope).mockResolvedValue(scope);
  vi.mocked(db.getRegistrationTenantScope).mockResolvedValue({ registration: { id: IDS.id! }, ...scope });
  vi.mocked(db.getSponsorshipTenantScope).mockResolvedValue({ sponsorship: { id: IDS.id! }, ...scope });
  vi.mocked(db.getEmailTemplateTenantScope).mockResolvedValue({
    template: { id: IDS.templateId!, clientId: OWNER, eventId: IDS.eventId! },
    ...scope,
  });
  vi.mocked(db.getAccessItemTenantScope).mockResolvedValue({ accessItem: { id: IDS.id! }, ...scope });
  vi.mocked(db.getCertificateTemplateTenantScope).mockResolvedValue({ certificateTemplate: { id: IDS.id! }, ...scope });
  vi.mocked(db.getFormTenantScope).mockResolvedValue({ form: { id: IDS.id!, type: formType }, ...scope });
  vi.mocked(db.getClientTenantScope).mockResolvedValue({ client: scope.client });
}

/** What the guard attaches: the event and its client, or the client alone on a client route. */
function expectedScope(kind: TenantScopeKind) {
  const scope = scopeRow();
  return kind === "client" ? { event: null, client: scope.client } : scope;
}

/** The modules a route's guard checks, given the form's type on a form route. */
function gatedModules(rule: TenantScopeRule, formType: FormType): ModuleId[] {
  const modules = [...rule.modules];
  if (rule.moduleOfFormType && !modules.includes(TYPE_MODULE[formType])) modules.push(TYPE_MODULE[formType]);
  return modules;
}

const READS: Record<TenantScopeKind, ReturnType<typeof vi.fn>> = {
  event: vi.mocked(db.getEventTenantScope),
  registration: vi.mocked(db.getRegistrationTenantScope),
  sponsorship: vi.mocked(db.getSponsorshipTenantScope),
  emailTemplate: vi.mocked(db.getEmailTemplateTenantScope),
  accessItem: vi.mocked(db.getAccessItemTenantScope),
  certificateTemplate: vi.mocked(db.getCertificateTemplateTenantScope),
  form: vi.mocked(db.getFormTenantScope),
  client: vi.mocked(db.getClientTenantScope),
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
  it("covers every route of the converted controllers: guarded, checked in the handler, or unscoped", () => {
    expect(ROUTES.map((r) => r.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(ROUTES).toHaveLength(101); // 76 (5.4) + 25 (5.4b)
    const unguarded = ALL_ROUTES.filter((r) => r.rule === undefined);
    expect(unguarded.map((r) => r.name).sort()).toEqual([...IN_HANDLER, ...UNSCOPED].sort());
    for (const route of unguarded) {
      expect(Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []).not.toContain(TenantScopeGuard);
    }
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: guard metadata", (name, route) => {
    const row = EXPECTED[name]!;
    expect(route.rule).toEqual({
      kind: row.kind,
      param: row.param ?? (row.kind === "event" ? "eventId" : row.kind === "emailTemplate" ? "templateId" : "id"),
      modules: row.module ?? [],
      write: row.write ?? false,
      moduleOfFormType: row.moduleOfFormType ?? false,
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

    // ------------------------------------------------------------------------
    // 5.4b: routes that take their event or client from the body or query.
    // requireTenantScope runs in the handler, after validation: same read,
    // order and codes as the guard.
    // ------------------------------------------------------------------------
    type InHandlerCase = {
      name: string;
      method: "GET" | "POST";
      url: string;
      payload?: Record<string, unknown>;
      kind: "event" | "client";
      modules: ModuleId[];
      write: boolean;
      service: string;
    };
    const eventBody = {
      clientId: OWNER,
      name: "Summit",
      slug: "summit",
      startDate: "2026-10-01",
      endDate: "2026-10-02",
    };
    const IN_HANDLER_CASES: InHandlerCase[] = [
      { name: "EventsController.create", method: "POST", url: "/api/events", payload: eventBody, kind: "client", modules: [], write: false, service: "EventsService.createEvent" },
      { name: "FormsController.create", method: "POST", url: "/api/forms", payload: { eventId: IDS.eventId, name: "Signup" }, kind: "event", modules: ["registrations"], write: true, service: "FormsService.createForm" },
      { name: "FormsController.list", method: "GET", url: `/api/forms?eventId=${IDS.eventId}`, kind: "event", modules: ["registrations", "sponsorships"], write: false, service: "FormsService.listForms" },
      { name: "FormsController.list", method: "GET", url: `/api/forms?eventId=${IDS.eventId}&type=SPONSOR`, kind: "event", modules: ["sponsorships"], write: false, service: "FormsService.listForms" },
      { name: "FormsController.list", method: "GET", url: `/api/forms?eventId=${IDS.eventId}&type=REGISTRATION`, kind: "event", modules: ["registrations"], write: false, service: "FormsService.listForms" },
    ];
    const scopedId = (c: InHandlerCase) => (c.kind === "client" ? OWNER : IDS.eventId);
    const sendCase = (c: InHandlerCase) =>
      app.inject({ method: c.method, url: c.url, headers: { authorization: "Bearer test" }, ...(c.payload ? { payload: c.payload } : {}) });

    it("lists every in-handler route", () => {
      expect([...new Set(IN_HANDLER_CASES.map((c) => c.name))].sort()).toEqual([...IN_HANDLER].sort());
    });

    it.each(IN_HANDLER_CASES.map((c) => [`${c.method} ${c.url}`, c] as const))(
      "%s: another client's admin gets 403 AUTH_1004; the owner's admin and a super admin reach the service",
      async (_name, c) => {
        signIn(UserRole.CLIENT_ADMIN, OTHER);
        const res = await sendCase(c);
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toEqual({ code: ErrorCodes.FORBIDDEN, message: "Insufficient permissions" });
        expect(READS[c.kind]).toHaveBeenCalledWith(scopedId(c));
        expect(serviceCalls).not.toHaveBeenCalled();

        for (const [role, clientId] of [[UserRole.CLIENT_ADMIN, OWNER], [UserRole.SUPER_ADMIN, null]] as const) {
          signIn(role, clientId);
          ownScopes("OPEN", c.modules, true);
          const ok = await sendCase(c);
          expect(ok.statusCode).toBeLessThan(300);
          expect(serviceCalls.mock.lastCall?.[0]).toBe(c.service);
        }
      },
    );

    it.each(IN_HANDLER_CASES.map((c) => [`${c.method} ${c.url}`, c] as const))(
      "%s: a missing event or client is 404 with its unified code",
      async (_name, c) => {
        signIn(UserRole.SUPER_ADMIN, null);
        READS[c.kind].mockResolvedValue(null);
        const res = await sendCase(c);
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toEqual(NOT_FOUND[c.kind]);
        expect(serviceCalls).not.toHaveBeenCalled();
      },
    );

    it.each(IN_HANDLER_CASES.map((c) => [`${c.method} ${c.url}`, c] as const))(
      "%s: archived event (writes only), inactive client and each disabled module",
      async (_name, c) => {
        signIn(UserRole.SUPER_ADMIN, null);
        ownScopes("ARCHIVED", ALL_MODULES, true);
        const archived = await sendCase(c);
        if (c.write) {
          expect(archived.statusCode).toBe(400);
          expect(archived.json().error.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
        } else {
          expect(archived.statusCode).toBeLessThan(300);
        }
        if (c.modules.length === 0) {
          ownScopes("OPEN", [], false);
          expect((await sendCase(c)).statusCode).toBeLessThan(300);
          return;
        }
        ownScopes("OPEN", ALL_MODULES, false);
        expect((await sendCase(c)).json().error.code).toBe(ErrorCodes.CLIENT_INACTIVE);
        for (const moduleId of c.modules) {
          ownScopes("OPEN", ALL_MODULES.filter((m) => m !== moduleId), true);
          const res = await sendCase(c);
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe(ErrorCodes.MODULE_DISABLED);
        }
      },
    );

    it("validation runs before the in-handler scope check (400, no read)", async () => {
      signIn(UserRole.CLIENT_ADMIN, OTHER);
      const events = await app.inject({ method: "POST", url: "/api/events", headers: { authorization: "Bearer test" }, payload: { ...eventBody, clientId: "nope" } });
      const forms = await app.inject({ method: "POST", url: "/api/forms", headers: { authorization: "Bearer test" }, payload: { eventId: IDS.eventId } });
      const list = await app.inject({ method: "GET", url: "/api/forms?eventId=nope", headers: { authorization: "Bearer test" } });
      for (const res of [events, forms, list]) {
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
      expect(db.getClientTenantScope).not.toHaveBeenCalled();
      expect(db.getEventTenantScope).not.toHaveBeenCalled();
    });

    it("a super admin lists forms without an event (no scope read); a client admin must name one", async () => {
      signIn(UserRole.SUPER_ADMIN, null);
      expect((await app.inject({ method: "GET", url: "/api/forms", headers: { authorization: "Bearer test" } })).statusCode).toBe(200);
      expect(db.getEventTenantScope).not.toHaveBeenCalled();
      expect(serviceCalls).toHaveBeenCalledWith("FormsService.listForms", expect.anything());

      signIn(UserRole.CLIENT_ADMIN, OWNER);
      const res = await app.inject({ method: "GET", url: "/api/forms", headers: { authorization: "Bearer test" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toEqual({ code: ErrorCodes.VALIDATION_ERROR, message: "Event ID is required for client admin users" });
    });

    it.each([
      ["GET /api/events", "/api/events", UserRole.CLIENT_ADMIN],
      ["GET /api/forms", `/api/forms?eventId=${IDS.eventId}`, UserRole.CLIENT_ADMIN],
      ["GET /api/clients/me (client admin)", "/api/clients/me", UserRole.CLIENT_ADMIN],
      ["GET /api/clients/me (super admin)", "/api/clients/me", UserRole.SUPER_ADMIN],
    ] as const)(
      "%s: a user without a client gets 403 AUTH_1004, one status on every route (5.4b)",
      async (_name, url, role) => {
        signIn(role, null);
        const res = await app.inject({ method: "GET", url, headers: { authorization: "Bearer test" } });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toEqual({ code: ErrorCodes.FORBIDDEN, message: "User is not associated with any client" });
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
          expect(scope).toEqual(expectedScope(route.rule!.kind));
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

    const gated = (r: RouteCase) => r.rule!.modules.length > 0 || r.rule!.moduleOfFormType;

    it.each(ROUTES.filter(gated).map((r) => [r.name, r] as const))(
      "%s: refuses an inactive client and each disabled module, with distinct codes",
      async (_name, route) => {
        for (const formType of ["SPONSOR", "REGISTRATION"] as const) {
          ownScopes("OPEN", ALL_MODULES, false, formType);
          await expect(runGuard(route, user(UserRole.SUPER_ADMIN, null))).rejects.toMatchObject({
            status: 403,
            response: { code: ErrorCodes.CLIENT_INACTIVE },
          });
          const modules = gatedModules(route.rule!, formType);
          for (const moduleId of modules) {
            ownScopes("OPEN", ALL_MODULES.filter((m) => m !== moduleId), true, formType);
            await expect(runGuard(route, user(UserRole.SUPER_ADMIN, null))).rejects.toMatchObject({
              status: 403,
              response: { code: ErrorCodes.MODULE_DISABLED },
            });
          }
          // Only those: every other module can be off.
          ownScopes("OPEN", modules, true, formType);
          await expect(runGuard(route, user(UserRole.SUPER_ADMIN, null))).resolves.toMatchObject({ ok: true });
        }
      },
    );

    it.each(ROUTES.filter((r) => !gated(r)).map((r) => [r.name, r] as const))(
      "%s: has no module gate",
      async (_name, route) => {
        ownScopes("OPEN", [], false);
        await expect(runGuard(route, user(UserRole.SUPER_ADMIN, null))).resolves.toMatchObject({ ok: true });
      },
    );
  });
});
