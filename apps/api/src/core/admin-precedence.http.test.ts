import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { InjectOptions } from "fastify";
import { ErrorCodes, UserRole } from "@app/contracts";

const db = vi.hoisted(() => ({
  getUserWithClientById: vi.fn(),
  getEventWithPricing: vi.fn(),
  findEventClientId: vi.fn(),
  findClientModuleState: vi.fn(),
  getRegistrationForSponsorship: vi.fn(),
  getCertificateTemplateWithEvent: vi.fn(),
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<Record<string, unknown>>()), ...db,
}));
vi.mock("@app/integrations", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));

import { authAs } from "../testing/auth";
import { createTestApp } from "../testing/create-test-app";
import { FormsController } from "../modules/forms/forms.controller";
import { FormsService } from "../modules/forms/forms.service";
import {
  RegistrationSponsorshipsController,
  SponsorshipDetailController,
  SponsorshipsListController,
} from "../modules/sponsorships/sponsorships.controller";
import { SponsorshipsService } from "../modules/sponsorships/sponsorships.service";
import { PricingController } from "../modules/pricing/pricing.controller";
import { PricingService } from "../modules/pricing/pricing.service";
import { EmailController } from "../modules/email/email.controller";
import { EmailTemplateService } from "../modules/email/email-template.service";
import { EmailSendService } from "../modules/email/email-send.service";
import { AbstractsController } from "../modules/abstracts/abstracts.controller";
import { AbstractsConfigService } from "../modules/abstracts/abstracts.config.service";
import { AbstractsAdminService } from "../modules/abstracts/abstracts.admin.service";
import { AbstractsCommitteeService } from "../modules/abstracts/abstracts.committee.service";
import { AbstractsBookService } from "../modules/abstracts/abstracts.book.service";
import { EventsController } from "../modules/events/events.controller";
import { EventsService } from "../modules/events/events.service";
import { CertificatesController } from "../modules/certificates/certificates.controller";
import { CertificatesService } from "../modules/certificates/certificates.service";

const eventId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
const eventUrl = `/api/events/${eventId}`;
const templateUrl = `/api/events/email-templates/${resourceId}`;
const certificateUrl = `/api/events/certificates/${resourceId}`;
const registrationUrl = `/api/registrations/${resourceId}`;
const modules = ["registrations", "sponsorships", "pricing", "emails", "abstracts", "certificates"];

const forms = {
  getFormById: vi.fn(), getSponsorFormByEventId: vi.fn(),
  createForm: vi.fn(), createSponsorForm: vi.fn(), updateForm: vi.fn(), listForms: vi.fn(),
};
const sponsorships = {
  linkSponsorshipToRegistration: vi.fn(), linkSponsorshipByCode: vi.fn(),
  unlinkSponsorshipFromRegistration: vi.fn(), listSponsorships: vi.fn(), getSponsorshipById: vi.fn(),
};
const pricing = {
  getEventForOwnership: db.getEventWithPricing,
  // Preserve the real service's module gate, not a canned thrown error.
  assertClientModuleEnabled: PricingService.prototype.assertClientModuleEnabled,
  updateEventPricing: vi.fn(), deletePricingRule: vi.fn(), getEventPricing: vi.fn(),
};
const templates = { getById: vi.fn(), create: vi.fn(), update: vi.fn(), list: vi.fn() };
const abstracts = { getOrCreateConfig: vi.fn(), updateConfig: vi.fn() };
const events = { getEventById: db.getEventWithPricing, updateEvent: vi.fn() };
const certificates = {
  getTemplate: CertificatesService.prototype.getTemplate,
  createTemplate: vi.fn(), updateTemplate: vi.fn(), listTemplates: vi.fn(), sendCertificates: vi.fn(),
};

// Keep the controllers, AuthGuard, ownership/writability/module policies, DTO
// validation and error filter real. Stub downstream work so rejected requests
// cannot write/send; these tests characterize HTTP guard order, not services.
type RouteCase = {
  name: string;
  request: InjectOptions;
  missing: string;
  forbidden: string;
  module: string;
  result: ReturnType<typeof vi.fn>;
  sponsorForm?: boolean;
};
const writes: RouteCase[] = [
  { name: "forms create", request: { method: "POST", url: "/api/forms", payload: { eventId, name: "Form" } }, missing: "Event not found", forbidden: "Insufficient permissions to create form for this event", module: "Registrations", result: forms.createForm },
  { name: "sponsor form create", request: { method: "POST", url: `/api/forms/events/${eventId}/sponsor`, payload: {} }, missing: "Event not found", forbidden: "Insufficient permissions to create form for this event", module: "Sponsorships", result: forms.createSponsorForm },
  { name: "registration form update", request: { method: "PATCH", url: `/api/forms/${resourceId}`, payload: { name: "Form" } }, missing: "Form not found", forbidden: "Insufficient permissions to update this form", module: "Registrations", result: forms.updateForm },
  { name: "sponsor form update", request: { method: "PATCH", url: `/api/forms/${resourceId}`, payload: { name: "Form" } }, missing: "Form not found", forbidden: "Insufficient permissions to update this form", module: "Sponsorships", result: forms.updateForm, sponsorForm: true },
  { name: "sponsorship link", request: { method: "POST", url: `${registrationUrl}/sponsorships`, payload: { sponsorshipId: resourceId } }, missing: "Registration not found", forbidden: "Insufficient permissions", module: "Sponsorships", result: sponsorships.linkSponsorshipToRegistration },
  { name: "sponsorship link by code", request: { method: "POST", url: `${registrationUrl}/sponsorships/by-code`, payload: { code: "ABC123" } }, missing: "Registration not found", forbidden: "Insufficient permissions", module: "Sponsorships", result: sponsorships.linkSponsorshipByCode },
  { name: "sponsorship unlink", request: { method: "DELETE", url: `${registrationUrl}/sponsorships/${resourceId}` }, missing: "Registration not found", forbidden: "Insufficient permissions", module: "Sponsorships", result: sponsorships.unlinkSponsorshipFromRegistration },
  { name: "pricing update", request: { method: "PATCH", url: `${eventUrl}/pricing`, payload: { basePrice: 100 } }, missing: "Event not found", forbidden: "Insufficient permissions to update this event", module: "Pricing", result: pricing.updateEventPricing },
  { name: "pricing rule delete", request: { method: "DELETE", url: `${eventUrl}/pricing/rules/${resourceId}` }, missing: "Event not found", forbidden: "Insufficient permissions to delete this pricing rule", module: "Pricing", result: pricing.deletePricingRule },
  { name: "email template create", request: { method: "POST", url: `${eventUrl}/email-templates`, payload: { name: "Email", subject: "Subject", content: { type: "doc", content: [] }, category: "MANUAL" } }, missing: "Event not found", forbidden: "Insufficient permissions", module: "Emails", result: templates.create },
  { name: "email template update", request: { method: "PATCH", url: templateUrl, payload: { name: "Email" } }, missing: "Email template not found", forbidden: "Insufficient permissions", module: "Emails", result: templates.update },
  { name: "certificate create", request: { method: "POST", url: `${eventUrl}/certificates`, payload: { name: "Certificate" } }, missing: "Event not found", forbidden: "Insufficient permissions", module: "Certificates", result: certificates.createTemplate },
  { name: "certificate update", request: { method: "PATCH", url: certificateUrl, payload: { name: "Certificate" } }, missing: "Certificate template not found", forbidden: "Insufficient permissions", module: "Certificates", result: certificates.updateTemplate },
];

function fixtures({ missing = false, clientId = "c1", status = "OPEN", enabledModules = modules, sponsorForm = false } = {}) {
  const event = { id: eventId, clientId, status };
  db.getEventWithPricing.mockResolvedValue(missing ? null : event);
  db.findEventClientId.mockResolvedValue(missing ? null : { clientId });
  db.findClientModuleState.mockResolvedValue({ active: true, enabledModules });
  db.getRegistrationForSponsorship.mockResolvedValue(missing ? null : { id: resourceId, event });
  db.getCertificateTemplateWithEvent.mockResolvedValue(missing ? null : { id: resourceId, event });
  forms.getFormById.mockResolvedValue(missing ? null : { id: resourceId, event, type: sponsorForm ? "SPONSOR" : "REGISTRATION" });
  templates.getById.mockResolvedValue(missing ? null : { id: resourceId, eventId, clientId });
  sponsorships.getSponsorshipById.mockResolvedValue(missing ? null : { id: resourceId, event });
}

function expectError(res: { statusCode: number; json(): unknown; headers: Record<string, unknown> }, status: number, code: string, message: string) {
  expect(res.statusCode).toBe(status);
  expect(res.json()).toEqual({ ok: false, error: { code, message }, requestId: "" });
  expect(res.headers["x-request-id"]).toBe("");
}

describe("admin HTTP error precedence", () => {
  let app: NestFastifyApplication;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = await createTestApp({
      controllers: [FormsController, RegistrationSponsorshipsController, SponsorshipDetailController, SponsorshipsListController, PricingController, EmailController, AbstractsController, EventsController, CertificatesController],
      providers: [
        { provide: FormsService, useValue: forms },
        { provide: SponsorshipsService, useValue: sponsorships },
        { provide: PricingService, useValue: pricing },
        { provide: EmailTemplateService, useValue: templates },
        { provide: EmailSendService, useValue: {} },
        { provide: AbstractsConfigService, useValue: abstracts },
        { provide: AbstractsAdminService, useValue: {} },
        { provide: AbstractsCommitteeService, useValue: {} },
        { provide: AbstractsBookService, useValue: {} },
        { provide: EventsService, useValue: events },
        { provide: CertificatesService, useValue: certificates },
      ],
    });
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    vi.resetAllMocks();
    // resetAllMocks restores the token mock's original implementation.
    headers = authAs(UserRole.CLIENT_ADMIN, "c1");
    fixtures();
    for (const route of writes) route.result.mockResolvedValue({ id: resourceId });
  });

  describe.each(writes)("$name", (route) => {
    const request = () => app.inject({ ...route.request, headers });

    it("missing resource wins for an authenticated user from another tenant, before module checks", async () => {
      headers = authAs(UserRole.CLIENT_ADMIN, "c2");
      fixtures({ missing: true, status: "ARCHIVED", enabledModules: [], sponsorForm: route.sponsorForm });
      expectError(await request(), 404, ErrorCodes.NOT_FOUND, route.missing);
      expect(db.findClientModuleState).not.toHaveBeenCalled();
      expect(route.result).not.toHaveBeenCalled();
    });

    it("forbidden wins over archived and module-disabled", async () => {
      fixtures({ clientId: "c2", status: "ARCHIVED", enabledModules: [], sponsorForm: route.sponsorForm });
      expectError(await request(), 403, ErrorCodes.FORBIDDEN, route.forbidden);
      expect(db.findClientModuleState).not.toHaveBeenCalled();
      expect(route.result).not.toHaveBeenCalled();
    });

    it("archived wins over module-disabled for the owning tenant", async () => {
      fixtures({ status: "ARCHIVED", enabledModules: [], sponsorForm: route.sponsorForm });
      expectError(await request(), 400, ErrorCodes.INVALID_STATUS_TRANSITION, "Archived events cannot be modified");
      expect(db.findClientModuleState).not.toHaveBeenCalled();
      expect(route.result).not.toHaveBeenCalled();
    });

    it("module-disabled rejects an owned writable event before downstream work", async () => {
      fixtures({ enabledModules: [], sponsorForm: route.sponsorForm });
      expectError(await request(), 403, ErrorCodes.FORBIDDEN, `${route.module} module is disabled for this client`);
      expect(db.findClientModuleState).toHaveBeenCalledTimes(1);
      expect(route.result).not.toHaveBeenCalled();
    });

    it("reaches downstream work when ownership, writability and the module pass", async () => {
      fixtures({ sponsorForm: route.sponsorForm });
      const res = await request();
      expect(res.statusCode).toBe(route.request.method === "POST" ? 201 : route.name === "pricing rule delete" ? 204 : 200);
      expect(route.result).toHaveBeenCalledTimes(1);
    });
  });

  it("sponsorship ownership wins even if the subsequent event read would be missing", async () => {
    fixtures({ clientId: "c2" });
    db.getEventWithPricing.mockResolvedValue(null);
    const res = await app.inject({ ...writes[4]!.request, headers });
    expectError(res, 403, ErrorCodes.FORBIDDEN, "Insufficient permissions");
    expect(db.getEventWithPricing).not.toHaveBeenCalled();
  });

  it("sponsorship's second event lookup returns 404 before its module gate", async () => {
    db.getEventWithPricing.mockResolvedValue(null);
    const res = await app.inject({ ...writes[4]!.request, headers });
    expectError(res, 404, ErrorCodes.NOT_FOUND, "Event not found");
    expect(db.findClientModuleState).not.toHaveBeenCalled();
  });

  it("email template update loads the event before checking template ownership", async () => {
    fixtures({ clientId: "c2", enabledModules: [] });
    db.getEventWithPricing.mockResolvedValue(null);
    const res = await app.inject({ method: "PATCH", url: templateUrl, payload: { name: "Email" }, headers });
    expectError(res, 404, ErrorCodes.NOT_FOUND, "Event not found");
    expect(db.findClientModuleState).not.toHaveBeenCalled();
  });

  it("email template read checks template ownership before loading its missing event", async () => {
    fixtures({ clientId: "c2" });
    db.getEventWithPricing.mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: templateUrl, headers });
    expectError(res, 403, ErrorCodes.FORBIDDEN, "Insufficient permissions");
    expect(db.getEventWithPricing).not.toHaveBeenCalled();
  });

  it("non-event email template update returns validation before ownership", async () => {
    templates.getById.mockResolvedValue({ clientId: "c2", eventId: null });
    const res = await app.inject({ method: "PATCH", url: templateUrl, payload: { name: "Email" }, headers });
    expectError(res, 400, ErrorCodes.VALIDATION_ERROR, "Email template is not event-scoped");
    expect(db.getEventWithPricing).not.toHaveBeenCalled();
  });

  it("certificate send checks certificates before emails when both modules are disabled", async () => {
    fixtures({ enabledModules: [] });
    const res = await app.inject({ method: "POST", url: `${eventUrl}/certificates/send`, payload: {}, headers });
    expectError(res, 403, ErrorCodes.FORBIDDEN, "Certificates module is disabled for this client");
    expect(db.findClientModuleState).toHaveBeenCalledTimes(1);
    expect(certificates.sendCertificates).not.toHaveBeenCalled();
  });

  it("certificate send reaches the emails gate after the certificates gate", async () => {
    fixtures({ enabledModules: ["certificates"] });
    const res = await app.inject({ method: "POST", url: `${eventUrl}/certificates/send`, payload: {}, headers });
    expectError(res, 403, ErrorCodes.FORBIDDEN, "Emails module is disabled for this client");
    expect(db.findClientModuleState).toHaveBeenCalledTimes(2);
  });

  describe("abstracts config mutation (no controller writability check)", () => {
    const request = () => app.inject({ method: "PATCH", url: `${eventUrl}/abstracts/config`, payload: {}, headers });
    it("returns missing event before tenancy and module", async () => {
      headers = authAs(UserRole.CLIENT_ADMIN, "c2");
      fixtures({ missing: true, enabledModules: [] });
      expectError(await request(), 404, ErrorCodes.NOT_FOUND, "Event not found");
      expect(db.findClientModuleState).not.toHaveBeenCalled();
    });
    it("returns ownership failure before module-disabled", async () => {
      fixtures({ clientId: "c2", status: "ARCHIVED", enabledModules: [] });
      expectError(await request(), 403, ErrorCodes.FORBIDDEN, "Insufficient permissions");
      expect(db.findClientModuleState).not.toHaveBeenCalled();
    });
    it("returns module-disabled even when the event is archived", async () => {
      fixtures({ status: "ARCHIVED", enabledModules: [] });
      expectError(await request(), 403, ErrorCodes.FORBIDDEN, "Abstracts module is disabled for this client");
      expect(abstracts.updateConfig).not.toHaveBeenCalled();
    });
    it("hands the mutation to its service without fetching event status", async () => {
      fixtures({ status: "ARCHIVED" });
      abstracts.updateConfig.mockResolvedValue({ enabled: true });
      expect((await request()).statusCode).toBe(200);
      expect(db.getEventWithPricing).not.toHaveBeenCalled();
      expect(abstracts.updateConfig).toHaveBeenCalledWith(eventId, {}, "u1");
    });
  });

  describe("events banner ownership and writability", () => {
    const request = () => app.inject({ method: "POST", url: `${eventUrl}/banner`, headers });
    it("missing event wins for a different tenant", async () => {
      headers = authAs(UserRole.CLIENT_ADMIN, "c2");
      fixtures({ missing: true });
      expectError(await request(), 404, ErrorCodes.NOT_FOUND, "Event not found");
    });
    it("ownership wins over archived", async () => {
      fixtures({ clientId: "c2", status: "ARCHIVED" });
      expectError(await request(), 403, ErrorCodes.FORBIDDEN, "Insufficient permissions to update this event");
    });
    it("archived rejects before multipart file access without any module gate", async () => {
      fixtures({ status: "ARCHIVED", enabledModules: [] });
      expectError(await request(), 400, ErrorCodes.INVALID_STATUS_TRANSITION, "Archived events cannot be modified");
      expect(db.findClientModuleState).not.toHaveBeenCalled();
    });
  });

  it("events validates the body before its inline admin-role check", async () => {
    headers = authAs(UserRole.SCIENTIFIC_COMMITTEE);
    fixtures({ missing: true });
    const res = await app.inject({ method: "PATCH", url: eventUrl, payload: { name: "" }, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: { code: ErrorCodes.VALIDATION_ERROR, message: "Validation failed", details: { fieldErrors: { name: [expect.any(String)] } } } });
    expect(db.getEventWithPricing).not.toHaveBeenCalled();
  });

  it("events inline admin-role check precedes lookup after valid DTO validation", async () => {
    headers = authAs(UserRole.SCIENTIFIC_COMMITTEE);
    fixtures({ missing: true });
    const res = await app.inject({ method: "PATCH", url: eventUrl, payload: { name: "Event" }, headers });
    expectError(res, 403, ErrorCodes.FORBIDDEN, "Insufficient permissions");
    expect(db.getEventWithPricing).not.toHaveBeenCalled();
  });

  it("forms role guard precedes body validation, unlike events' inline role check", async () => {
    headers = authAs(UserRole.SCIENTIFIC_COMMITTEE);
    const res = await app.inject({ method: "POST", url: "/api/forms", payload: {}, headers });
    expectError(res, 403, ErrorCodes.FORBIDDEN, "Insufficient permissions");
    expect(db.getEventWithPricing).not.toHaveBeenCalled();
  });

  it("authentication precedes DTO validation and missing-resource lookup", async () => {
    fixtures({ missing: true });
    const res = await app.inject({ method: "POST", url: "/api/forms", payload: {} });
    expectError(res, 401, ErrorCodes.UNAUTHORIZED, "Missing or invalid authorization header");
    expect(db.getEventWithPricing).not.toHaveBeenCalled();
  });

  it("authenticated invalid DTO returns validation before tenancy or lookup", async () => {
    fixtures({ missing: true });
    const res = await app.inject({ method: "POST", url: "/api/forms", payload: { eventId, name: "" }, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: { code: ErrorCodes.VALIDATION_ERROR, message: "Validation failed", details: { fieldErrors: { name: [expect.any(String)] } } } });
    expect(db.getEventWithPricing).not.toHaveBeenCalled();
  });

  it("forms list requires a client admin's event ID before loading anything", async () => {
    const res = await app.inject({ method: "GET", url: "/api/forms", headers });
    expectError(res, 400, ErrorCodes.VALIDATION_ERROR, "Event ID is required for client admin users");
    expect(db.getEventWithPricing).not.toHaveBeenCalled();
  });

  it("forms list without a type checks registrations before sponsorships", async () => {
    fixtures({ enabledModules: [] });
    const res = await app.inject({ method: "GET", url: `/api/forms?eventId=${eventId}`, headers });
    expectError(res, 403, ErrorCodes.FORBIDDEN, "Registrations module is disabled for this client");
    expect(db.findClientModuleState).toHaveBeenCalledTimes(1);
  });

  it.each([
    { url: `${eventUrl}/sponsorships`, result: sponsorships.listSponsorships },
    { url: `/api/sponsorships/${resourceId}`, result: sponsorships.getSponsorshipById },
  ])("sponsorship read $url skips the writable and module gates", async ({ url, result }) => {
    fixtures({ status: "ARCHIVED", enabledModules: [] });
    const res = await app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(200);
    expect(result).toHaveBeenCalledTimes(1);
    expect(db.findClientModuleState).not.toHaveBeenCalled();
  });

  it.each([
    { url: `${eventUrl}/pricing`, module: "Pricing" },
    { url: `${eventUrl}/email-templates`, module: "Emails" },
    { url: `${eventUrl}/certificates`, module: "Certificates" },
    { url: `/api/forms?eventId=${eventId}&type=SPONSOR`, module: "Sponsorships" },
  ])("read $url checks the module but permits archived events", async ({ url, module }) => {
    fixtures({ status: "ARCHIVED", enabledModules: [] });
    const res = await app.inject({ method: "GET", url, headers });
    expectError(res, 403, ErrorCodes.FORBIDDEN, `${module} module is disabled for this client`);
  });
});
