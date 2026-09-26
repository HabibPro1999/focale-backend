import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { RegistrationRow } from "@app/db";
import { EnvelopeInterceptor } from "../../core/envelope.interceptor";
import { HttpExceptionFilter } from "../../core/http-exception.filter";
import { logger } from "../../core/logger.service";
import { ZodValidationPipe } from "../../core/zod";
import { toPublicRegistration } from "./registrations.mappers";
import { PaymentProofService } from "./registrations.payment-proof.service";
import { RegistrationPaymentsService } from "./registrations.payments.service";
import {
  RegistrationEditPublicController,
  RegistrationsPublicController,
} from "./registrations.public.controller";
import { RegistrationRepricer } from "./registrations.repricer";
import { RegistrationsService } from "./registrations.service";
import { RegistrationCreateService } from "./registrations.create.service";

const FORM_ID = "11111111-1111-4111-8111-111111111111";
const REGISTRATION_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "a".repeat(64);

const at = (iso: string) => new Date(iso);

const row: RegistrationRow = {
  id: REGISTRATION_ID,
  formId: FORM_ID,
  eventId: "e1",
  formData: { specialty: "cardio" },
  networkingOptIn: false,
  submittedAt: at("2026-06-01T08:00:00.000Z"),
  formSchemaVersion: 1,
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  phone: null,
  referenceNumber: "26-SUMMIT-0001",
  paymentStatus: "PENDING",
  totalAmount: 200,
  paidAmount: 0,
  currency: "TND",
  paymentMethod: "BANK_TRANSFER",
  paymentReference: "VIR-INTERNAL-1",
  paymentProofUrl: "https://storage.example/private/proofs/r1.webp",
  priceBreakdown: { basePrice: 200, accessItems: [], droppedAccessItems: [], total: 200 },
  baseAmount: 200,
  discountAmount: 0,
  accessAmount: 0,
  sponsorshipCode: null,
  sponsorshipAmount: 0,
  labName: null,
  paidAt: null,
  createdAt: at("2026-06-01T08:00:00.000Z"),
  updatedAt: at("2026-06-01T08:00:00.000Z"),
  lastEditedAt: null,
  editToken: TOKEN,
  linkBaseUrl: "https://summit.example",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  note: "internal admin note",
  role: "PARTICIPANT",
  accessTypeIds: [],
  droppedAccessIds: [],
  checkedInAt: null,
  checkedInBy: null,
};

// A column added to the registrations table: it shows up on every row read.
const rowWithNewColumn = { ...row, riskScore: 97 };

const meta = {
  form: { id: FORM_ID, name: "Registration" },
  event: { id: "e1", name: "Summit", slug: "summit" },
  accessSelections: [],
};

/** Keys no public registration response may carry. */
const INTERNAL_KEYS = [
  "riskScore",
  "editToken",
  "idempotencyKey",
  "note",
  "role",
  "paymentReference",
  "paymentProofUrl",
  "linkBaseUrl",
  "checkedInAt",
  "checkedInBy",
  "accessTypeIds",
  "droppedAccessIds",
  "formSchemaVersion",
];

const service = {
  verifyEditToken: vi.fn(async () => true),
  getRegistrationForEdit: vi.fn(),
};
const creator = {
  createPublicRegistration: vi.fn(),
};

@Module({
  controllers: [RegistrationsPublicController, RegistrationEditPublicController],
  providers: [
    { provide: RegistrationsService, useValue: service },
    { provide: RegistrationCreateService, useValue: creator },
    { provide: PaymentProofService, useValue: {} },
    { provide: RegistrationRepricer, useValue: {} },
    { provide: RegistrationPaymentsService, useValue: {} },
  ],
})
class PublicRegistrationsTestModule {}

async function makeApp(isProduction: boolean): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    PublicRegistrationsTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new EnvelopeInterceptor(app.get(Reflector), { isProduction }));
  app.useGlobalFilters(new HttpExceptionFilter({ isProduction }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function forEdit(registration: unknown) {
  return {
    registration,
    expectedUpdatedAt: row.updatedAt.toISOString(),
    canEdit: true,
    canEditPersonalInfo: true,
    canEditAccess: true,
    canAddAccess: true,
    canRemoveAccess: true,
    isFullySponsored: false,
    amountDue: 200,
    editRestrictions: [],
  };
}

const getForEdit = (app: NestFastifyApplication) =>
  app.inject({
    method: "GET",
    url: `/api/public/registrations/${REGISTRATION_ID}`,
    headers: { "x-edit-token": TOKEN },
  });

const register = (app: NestFastifyApplication) =>
  app.inject({
    method: "POST",
    url: `/api/public/forms/${FORM_ID}/register`,
    payload: { email: "ada@example.com", formData: { specialty: "cardio" } },
  });

describe("public registration responses: a new registration column is never public", () => {
  let app: NestFastifyApplication | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  describe.each([
    ["production", true],
    ["test", false],
  ])("%s", (_env, isProduction) => {
    beforeEach(async () => {
      app = await makeApp(isProduction);
    });

    it("GET for edit through the real mapper: unchanged bytes, no new column", async () => {
      const payload = forEdit(
        toPublicRegistration({ ...rowWithNewColumn, ...meta, form: { ...meta.form, schema: { steps: [] } } }),
      );
      service.getRegistrationForEdit.mockResolvedValue(payload);

      const res = await getForEdit(app!);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(JSON.stringify({ ok: true, data: payload }));
      expect(res.body).not.toContain("riskScore");
      expect(warn).not.toHaveBeenCalled();
    });

    it("GET for edit when the service leaks the raw row: the contract strips every internal key", async () => {
      const safe = toPublicRegistration({ ...rowWithNewColumn, ...meta });
      service.getRegistrationForEdit.mockResolvedValue(
        forEdit({ ...rowWithNewColumn, ...safe }),
      );

      const res = await getForEdit(app!);

      expect(res.statusCode).toBe(200);
      const registration = res.json().data.registration as Record<string, unknown>;
      for (const key of INTERNAL_KEYS) expect(registration).not.toHaveProperty(key);
      expect(res.body).not.toContain("internal admin note");
      expect(res.body).not.toContain(TOKEN);
      expect(registration).toEqual(JSON.parse(JSON.stringify(safe)));
    });

    it("register when the service leaks the raw row: 201 with the public registration and token only", async () => {
      const safe = toPublicRegistration({ ...rowWithNewColumn, ...meta }, { token: TOKEN });
      creator.createPublicRegistration.mockResolvedValue({
        created: true,
        registration: { ...rowWithNewColumn, ...safe },
        priceBreakdown: row.priceBreakdown,
      });

      const res = await register(app!);

      expect(res.statusCode).toBe(201);
      const data = res.json().data as { registration: Record<string, unknown> };
      expect(Object.keys(data)).toEqual(["registration", "priceBreakdown"]);
      for (const key of INTERNAL_KEYS) expect(data.registration).not.toHaveProperty(key);
      expect(data.registration.token).toBe(TOKEN);
      expect(data.registration).toEqual(JSON.parse(JSON.stringify(safe)));
    });
  });

  it("outside production the stripped keys are logged by path, without values", async () => {
    app = await makeApp(false);
    const safe = toPublicRegistration({ ...rowWithNewColumn, ...meta });
    service.getRegistrationForEdit.mockResolvedValue(forEdit({ ...rowWithNewColumn, ...safe }));

    await getForEdit(app);

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [
      { handler: string; strippedKeys: string[] },
      string,
    ];
    expect(message).toBe("Response contract stripped undeclared keys");
    expect(fields.handler).toBe("RegistrationEditPublicController.getForEdit");
    expect(fields.strippedKeys).toEqual(
      expect.arrayContaining(INTERNAL_KEYS.map((key) => `registration.${key}`)),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("internal admin note");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("97");
  });

  it("in production nothing is logged", async () => {
    app = await makeApp(true);
    const safe = toPublicRegistration({ ...rowWithNewColumn, ...meta });
    service.getRegistrationForEdit.mockResolvedValue(forEdit({ ...rowWithNewColumn, ...safe }));

    await getForEdit(app);

    expect(warn).not.toHaveBeenCalled();
  });
});
