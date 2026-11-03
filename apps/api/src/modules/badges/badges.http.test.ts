import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes, UserRole, seedBadgeZones } from "@app/contracts";

// The badge routes over HTTP: real controller, service, validation, scope
// guard, response contracts and envelope; the DB reads and storage stubbed.
vi.mock("@app/integrations", async (original) => ({
  ...(await original<typeof import("@app/integrations")>()),
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
  buildEmailContextWithAccess: vi.fn(async () => ({ fullName: "Leila Ben Ali" })),
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  getUserWithClientById: vi.fn(),
  getEventTenantScope: vi.fn(),
  getBadgeTemplateTenantScope: vi.fn(),
  getRegistrationTenantScope: vi.fn(),
  createBadgeTemplate: vi.fn(),
  listBadgeTemplates: vi.fn(),
  getBadgeTemplate: vi.fn(),
  updateBadgeTemplate: vi.fn(),
  deleteBadgeTemplate: vi.fn(),
  getRegistrationFormLanguage: vi.fn(async () => "fr"),
  getRegistrationForEmailContext: vi.fn(),
  getRegistrationFormSchema: vi.fn(async () => ({
    steps: [{ fields: [{ id: "company", type: "text", label: "Company", translations: { fr: { label: "Société" } } }] }],
  })),
}));

import * as db from "@app/db";
import { authAs } from "../../testing/auth";
import { createTestApp } from "../../testing/create-test-app";
import { EmailController } from "../email/email.controller";
import { EmailTemplateService } from "../email/email-template.service";
import { EmailSendService } from "../email/email-send.service";
import { BadgesController } from "./badges.controller";
import { BadgesService } from "./badges.service";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const BADGE = "33333333-3333-4333-8333-333333333333";
const REG = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a12";
const headers = { authorization: "Bearer test" };

const scope = (modules = ["registrations"]) => ({
  event: { id: EVENT, clientId: CLIENT, status: "OPEN" as const, slug: "summit" },
  client: { id: CLIENT, active: true, enabledModules: modules },
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: BADGE, eventId: EVENT, name: "Attendee", widthMm: 90, heightMm: 55,
    backgroundUrl: null, backgroundWidth: null, backgroundHeight: null,
    renderImageKey: "secret/render.jpg", renderImageWidth: 1, renderImageHeight: 1,
    zones: seedBadgeZones(90, 55), deletedAt: null,
    createdAt: new Date("2026-11-01T10:00:00.000Z"), updatedAt: new Date("2026-11-01T10:00:00.000Z"),
    ...overrides,
  } as never;
}

let app: NestFastifyApplication;
beforeAll(async () => {
  app = await createTestApp({
    controllers: [BadgesController, EmailController],
    providers: [
      BadgesService,
      { provide: EmailTemplateService, useValue: {} },
      { provide: EmailSendService, useValue: {} },
    ],
  });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  authAs(UserRole.CLIENT_ADMIN, CLIENT);
  vi.mocked(db.getEventTenantScope).mockResolvedValue(scope());
  vi.mocked(db.getBadgeTemplateTenantScope).mockResolvedValue({ badgeTemplate: { id: BADGE }, ...scope() });
  vi.mocked(db.getRegistrationTenantScope).mockResolvedValue({ registration: { id: REG }, ...scope() });
});

describe("badge CRUD", () => {
  it("POST :eventId/badges creates a CARD badge with the seeded zones; the response hides storage columns", async () => {
    vi.mocked(db.createBadgeTemplate).mockImplementation(async (values) => row(values));
    const res = await app.inject({ method: "POST", url: `/api/events/${EVENT}/badges`, headers, payload: { name: "Attendee" } });
    expect(res.statusCode).toBe(201);
    expect(db.createBadgeTemplate).toHaveBeenCalledWith({
      eventId: EVENT, name: "Attendee", widthMm: 90, heightMm: 55, zones: seedBadgeZones(90, 55),
    }, expect.anything());
    const { data } = res.json();
    expect(Object.keys(data).sort()).toEqual([
      "backgroundHeight", "backgroundUrl", "backgroundWidth", "createdAt", "eventId", "heightMm",
      "id", "name", "updatedAt", "widthMm", "zones",
    ]);
    expect(data).toMatchObject({ id: BADGE, widthMm: 90, heightMm: 55, createdAt: "2026-11-01T10:00:00.000Z" });
    expect(data.zones).toEqual(seedBadgeZones(90, 55));
  });

  it("refuses zones without exactly one QR, and sizes outside 40..210 mm (400 VAL_2001, nothing written)", async () => {
    for (const payload of [
      { name: "B", zones: [] },
      { name: "B", widthMm: 300 },
    ]) {
      const res = await app.inject({ method: "POST", url: `/api/events/${EVENT}/badges`, headers, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    }
    const patch = await app.inject({
      method: "PATCH", url: `/api/events/badges/${BADGE}`, headers,
      payload: { zones: [{ kind: "text", id: "t", x: 0, y: 0, width: 10, height: 10, variable: "fullName", fontSize: null }] },
    });
    expect(patch.statusCode).toBe(400);
    expect(db.createBadgeTemplate).not.toHaveBeenCalled();
    expect(db.updateBadgeTemplate).not.toHaveBeenCalled();
  });

  it("lists, reads, patches and soft-deletes", async () => {
    vi.mocked(db.listBadgeTemplates).mockResolvedValue([row()]);
    const list = await app.inject({ method: "GET", url: `/api/events/${EVENT}/badges`, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).not.toHaveProperty("renderImageKey");

    vi.mocked(db.getBadgeTemplate).mockResolvedValue(row());
    expect((await app.inject({ method: "GET", url: `/api/events/badges/${BADGE}`, headers })).json().data.id).toBe(BADGE);

    vi.mocked(db.updateBadgeTemplate).mockResolvedValue(row({ name: "Speaker", widthMm: 100, heightMm: 140 }));
    const patched = await app.inject({ method: "PATCH", url: `/api/events/badges/${BADGE}`, headers, payload: { name: "Speaker", widthMm: 100, heightMm: 140 } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data).toMatchObject({ name: "Speaker", widthMm: 100, heightMm: 140 });

    vi.mocked(db.deleteBadgeTemplate).mockResolvedValue(true);
    const removed = await app.inject({ method: "DELETE", url: `/api/events/badges/${BADGE}`, headers });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe("");
  });

  it("a deleted badge is 404 BDG_21001", async () => {
    vi.mocked(db.getBadgeTemplate).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: `/api/events/badges/${BADGE}`, headers });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: ErrorCodes.BADGE_TEMPLATE_NOT_FOUND, message: "Badge not found" });
  });
});

describe("badge variables", () => {
  it("GET :eventId/badges/variables answers exactly what the email variables route does", async () => {
    vi.mocked(db.getEventTenantScope).mockResolvedValue(scope(["registrations", "emails"]));
    for (const query of ["", "?language=fr"]) {
      const badges = await app.inject({ method: "GET", url: `/api/events/${EVENT}/badges/variables${query}`, headers });
      const emails = await app.inject({ method: "GET", url: `/api/events/${EVENT}/email-templates/variables${query}`, headers });
      expect(badges.statusCode).toBe(200);
      expect(badges.body).toBe(emails.body);
    }
    const fr = await app.inject({ method: "GET", url: `/api/events/${EVENT}/badges/variables?language=fr`, headers });
    expect(fr.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fullName" }),
      expect.objectContaining({ id: "form_company", label: "Société", category: "form", example: "Sample text" }),
    ]));
  });

  it("needs the registrations module only (the email route needs emails)", async () => {
    vi.mocked(db.getEventTenantScope).mockResolvedValue(scope(["registrations"]));
    expect((await app.inject({ method: "GET", url: `/api/events/${EVENT}/badges/variables`, headers })).statusCode).toBe(200);
    const email = await app.inject({ method: "GET", url: `/api/events/${EVENT}/email-templates/variables`, headers });
    expect(email.statusCode).toBe(403);

    vi.mocked(db.getEventTenantScope).mockResolvedValue(scope(["emails"]));
    const res = await app.inject({ method: "GET", url: `/api/events/${EVENT}/badges/variables`, headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(ErrorCodes.MODULE_DISABLED);
  });

  it("validates the language (400) and refuses another client's admin (403)", async () => {
    expect((await app.inject({ method: "GET", url: `/api/events/${EVENT}/badges/variables?language=xx`, headers })).statusCode).toBe(400);
    authAs(UserRole.CLIENT_ADMIN, "44444444-4444-4444-8444-444444444444");
    expect((await app.inject({ method: "GET", url: `/api/events/${EVENT}/badges/variables`, headers })).statusCode).toBe(403);
    expect(db.getRegistrationFormSchema).not.toHaveBeenCalled();
  });
});

describe("badge PDFs", () => {
  it("GET badges/:id/sample.pdf returns raw PDF bytes, inline, named after the sample registration", async () => {
    vi.mocked(db.getBadgeTemplate).mockResolvedValue(row({ renderImageKey: null }));
    const res = await app.inject({ method: "GET", url: `/api/events/badges/${BADGE}/sample.pdf`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe('inline; filename="badge-5A7C3E91.pdf"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("GET registrations/:registrationId/badge.pdf?badgeId= renders the registrant's badge of their event", async () => {
    vi.mocked(db.getRegistrationForEmailContext).mockResolvedValue({ id: REG, eventId: EVENT } as never);
    vi.mocked(db.getBadgeTemplate).mockResolvedValue(row({ renderImageKey: null }));
    const res = await app.inject({ method: "GET", url: `/api/events/registrations/${REG}/badge.pdf?badgeId=${BADGE}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe('inline; filename="badge-3F2B8C1E.pdf"');
    expect(db.getRegistrationTenantScope).toHaveBeenCalledWith(REG);
    expect(db.getBadgeTemplate).toHaveBeenCalledWith(BADGE);
  });

  it("badge.pdf needs a badge id (400) and answers 404 BDG_21001 for a badge of another event", async () => {
    const missing = await app.inject({ method: "GET", url: `/api/events/registrations/${REG}/badge.pdf`, headers });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe(ErrorCodes.VALIDATION_ERROR);

    vi.mocked(db.getRegistrationForEmailContext).mockResolvedValue({ id: REG, eventId: EVENT } as never);
    vi.mocked(db.getBadgeTemplate).mockResolvedValue(row({ eventId: "99999999-9999-4999-8999-999999999999" }));
    const other = await app.inject({ method: "GET", url: `/api/events/registrations/${REG}/badge.pdf?badgeId=${BADGE}`, headers });
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe(ErrorCodes.BADGE_TEMPLATE_NOT_FOUND);
  });
});

describe("tenancy", () => {
  it("another client's admin gets 403 on every badge route; nothing is read or rendered", async () => {
    authAs(UserRole.CLIENT_ADMIN, "44444444-4444-4444-8444-444444444444");
    for (const [method, url] of [
      ["GET", `/api/events/${EVENT}/badges`],
      ["GET", `/api/events/badges/${BADGE}`],
      ["GET", `/api/events/badges/${BADGE}/sample.pdf`],
      ["GET", `/api/events/registrations/${REG}/badge.pdf?badgeId=${BADGE}`],
      ["DELETE", `/api/events/badges/${BADGE}`],
    ] as const) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe(ErrorCodes.FORBIDDEN);
    }
    expect(db.getBadgeTemplate).not.toHaveBeenCalled();
    expect(db.getRegistrationForEmailContext).not.toHaveBeenCalled();
  });

  it("is gated by the registrations module", async () => {
    vi.mocked(db.getBadgeTemplateTenantScope).mockResolvedValue({ badgeTemplate: { id: BADGE }, ...scope(["emails"]) });
    const res = await app.inject({ method: "GET", url: `/api/events/badges/${BADGE}/sample.pdf`, headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(ErrorCodes.MODULE_DISABLED);
  });
});
