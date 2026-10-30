import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes, UserRole } from "@app/contracts";

// The template send route with the abstracts audience (backend 0f86c91d,
// admin fa67663): real guards, DTO validation, controller, send service and
// email context; only the DB boundary is mocked.
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/integrations")>()),
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  getUserWithClientById: vi.fn(),
  getEventTenantScope: vi.fn(),
  getEventWithPricing: vi.fn(),
  getEmailTemplateById: vi.fn(),
  getRegistrationsByFilters: vi.fn(),
  listAbstractsForBulkEmail: vi.fn(),
  withTxn: vi.fn(),
  insertEmailLogsSkippingConflicts: vi.fn(),
}));

import * as db from "@app/db";
import { authAs } from "../../testing/auth";
import { createTestApp } from "../../testing/create-test-app";
import { txnPassthrough } from "../../testing/txn";
import { EmailController } from "./email.controller";
import { EmailSendService } from "./email-send.service";
import { EmailTemplateService } from "./email-template.service";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const EVENT = "e0000000-0000-4000-8000-000000000001";
const TEMPLATE = "e0000000-0000-4000-8000-000000000002";
const ABSTRACT = "e0000000-0000-4000-8000-000000000003";
const tx = { executor: "bulk-send" };

const routeScope = (modules = ["emails", "abstracts"]) => ({
  event: { id: EVENT, clientId: OWNER, status: "OPEN" as const, slug: "congress" },
  client: { id: OWNER, active: true, enabledModules: modules },
});
const event = {
  id: EVENT,
  clientId: OWNER,
  name: "Congress",
  startDate: new Date("2026-04-20T12:00:00Z"),
  endDate: new Date("2026-04-22T12:00:00Z"),
  location: "Tunis",
  pricing: null,
};
// Noon UTC: the same calendar day in any host timezone.
const recipient: db.AbstractForBulkEmail = {
  id: ABSTRACT,
  authorFirstName: "Ada",
  authorLastName: "Lovelace",
  authorAffiliation: "Analytical Institute",
  authorEmail: "ada@example.com",
  authorPhone: "+21612345678",
  content: { title: "Computing" },
  status: "ACCEPTED",
  requestedType: "POSTER",
  finalType: null,
  code: null,
  editToken: "token-1",
  linkBaseUrl: "https://events.example.com",
  eventId: EVENT,
  language: "fr",
  event: {
    name: "Congress",
    slug: "congress",
    clientId: OWNER,
    startDate: event.startDate,
    endDate: event.endDate,
    location: "Tunis",
    client: { name: "Client", email: "contact@client.tn", phone: "+216" },
  },
  config: {
    submissionStartAt: null,
    submissionDeadline: null,
    editingDeadline: null,
    scoringStartAt: null,
    scoringDeadline: null,
    finalFileDeadline: null,
    finalFileUploadEnabled: false,
  },
};

describe("POST /api/events/:eventId/email-templates/:templateId/send (abstracts audience)", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createTestApp({
      controllers: [EmailController],
      providers: [EmailTemplateService, EmailSendService],
    });
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    authAs(UserRole.CLIENT_ADMIN, OWNER);
    vi.mocked(db.getEventTenantScope).mockResolvedValue(routeScope());
    vi.mocked(db.getEventWithPricing).mockResolvedValue(event as never);
    vi.mocked(db.getEmailTemplateById).mockResolvedValue({ id: TEMPLATE, clientId: OWNER } as never);
    vi.mocked(db.listAbstractsForBulkEmail).mockResolvedValue({ recipients: [recipient], skipped: 1 });
    vi.mocked(db.getRegistrationsByFilters).mockResolvedValue([]);
    vi.mocked(db.withTxn).mockImplementation(txnPassthrough(tx));
    vi.mocked(db.insertEmailLogsSkippingConflicts).mockImplementation(
      async (values) => new Set(values.map((_, index) => `log-${index}`)),
    );
  });

  const send = (payload: Record<string, unknown>) => app.inject({
    method: "POST",
    url: `/api/events/${EVENT}/email-templates/${TEMPLATE}/send`,
    headers: { authorization: "Bearer test" },
    payload,
  });

  it("queues the admin dialog's send and answers queued and skipped", async () => {
    // BulkSendDialog's body: abstractFilters only when one is set, dedupeByEmail always.
    const response = await send({
      audience: "abstracts",
      abstractFilters: { status: ["ACCEPTED", "PENDING"], presentationType: "POSTER" },
      dedupeByEmail: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: { success: true, queued: 1, skipped: 1, message: "1 emails queued for sending" },
    });
    expect(db.listAbstractsForBulkEmail).toHaveBeenCalledWith(EVENT, {
      abstractIds: undefined,
      filters: { status: ["ACCEPTED", "PENDING"], presentationType: "POSTER" },
      dedupeByEmail: true,
    });
    const [[rows, exec]] = vi.mocked(db.insertEmailLogsSkippingConflicts).mock.calls;
    expect(exec).toBe(tx);
    expect(rows).toEqual([
      {
        templateId: TEMPLATE,
        abstractId: ABSTRACT,
        recipientEmail: "ada@example.com",
        recipientName: "Ada Lovelace",
        subject: "",
        status: "QUEUED",
        contextSnapshot: expect.objectContaining({
          authorName: "Ada Lovelace",
          submissionTitle: "Computing",
          congressName: "Congress",
          abstractEditLink: `https://events.example.com/congress/abstracts/${ABSTRACT}/token-1`,
          firstName: "Ada",
          lastName: "Lovelace",
          fullName: "Ada Lovelace",
          email: "ada@example.com",
          phone: "+21612345678",
          authorAffiliation: "Analytical Institute",
          eventName: "Congress",
          eventDate: "20 avril 2026",
          eventEndDate: "22 avril 2026",
          eventLocation: "Tunis",
          organizerName: "Client",
          organizerEmail: "contact@client.tn",
          organizerPhone: "+216",
        }),
      },
    ]);
  });

  it("defaults dedupeByEmail to true and passes explicit ids", async () => {
    const response = await send({ audience: "abstracts", abstractIds: [ABSTRACT] });
    expect(response.statusCode).toBe(200);
    expect(db.listAbstractsForBulkEmail).toHaveBeenCalledWith(EVENT, {
      abstractIds: [ABSTRACT],
      filters: undefined,
      dedupeByEmail: true,
    });
  });

  it("answers queued 0 with the skipped count when no author is left", async () => {
    vi.mocked(db.listAbstractsForBulkEmail).mockResolvedValue({ recipients: [], skipped: 2 });
    const response = await send({ audience: "abstracts", dedupeByEmail: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      success: true,
      queued: 0,
      skipped: 2,
      message: "No abstract submitters matched the criteria",
    });
    expect(db.insertEmailLogsSkippingConflicts).not.toHaveBeenCalled();
  });

  it("refuses the abstracts audience when the client has not enabled the abstracts module", async () => {
    vi.mocked(db.getEventTenantScope).mockResolvedValue(routeScope(["emails"]));
    const response = await send({ audience: "abstracts", dedupeByEmail: true });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toEqual({
      code: ErrorCodes.MODULE_DISABLED,
      message: "Abstracts module is disabled for this client",
    });
    expect(db.listAbstractsForBulkEmail).not.toHaveBeenCalled();
    expect(db.insertEmailLogsSkippingConflicts).not.toHaveBeenCalled();
  });

  it("does not need the abstracts module for the other audiences, and answers skipped 0", async () => {
    vi.mocked(db.getEventTenantScope).mockResolvedValue(routeScope(["emails"]));
    const response = await send({ audience: "registrants" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      success: true,
      queued: 0,
      skipped: 0,
      message: "No recipients matched the criteria",
    });
    expect(db.listAbstractsForBulkEmail).not.toHaveBeenCalled();
  });

  it("checks the template before the abstracts module, as legacy did", async () => {
    vi.mocked(db.getEventTenantScope).mockResolvedValue(routeScope(["emails"]));
    vi.mocked(db.getEmailTemplateById).mockResolvedValue({ id: TEMPLATE, clientId: OTHER } as never);
    const response = await send({ audience: "abstracts", dedupeByEmail: true });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toEqual({
      code: ErrorCodes.FORBIDDEN,
      message: "Template does not belong to this client",
    });
  });

  it("refuses another client's admin before any read", async () => {
    authAs(UserRole.CLIENT_ADMIN, OTHER);
    const response = await send({ audience: "abstracts", dedupeByEmail: true });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(ErrorCodes.FORBIDDEN);
    expect(db.getEmailTemplateById).not.toHaveBeenCalled();
    expect(db.listAbstractsForBulkEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["abstract ids on the registrant audience", { audience: "registrants", abstractIds: [ABSTRACT] }],
    ["abstract filters on the sponsor audience", { audience: "sponsors", abstractFilters: { status: ["ACCEPTED"] } }],
    ["a CONFERENCE presentation type", { audience: "abstracts", abstractFilters: { presentationType: "CONFERENCE" } }],
    ["an unknown abstract status", { audience: "abstracts", abstractFilters: { status: ["WITHDRAWN"] } }],
  ])("rejects %s with 400", async (_label, payload) => {
    const response = await send(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(db.listAbstractsForBulkEmail).not.toHaveBeenCalled();
  });
});
