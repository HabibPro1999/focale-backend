import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { PATH_METADATA } from "@nestjs/common/constants";
import type { z } from "zod";

const db = vi.hoisted(() => ({
  getRegistrationFormSchemaForEvent: vi.fn(),
  getEventWithPricingBySlug: vi.fn(),
  searchRegistrantsForSponsorship: vi.fn(),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...db,
}));
vi.mock("./clients/module-gates", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertClientModuleEnabled: vi.fn(async () => undefined),
}));
vi.mock("./events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertEventAcceptsPublicActions: vi.fn(),
}));

import {
  AccessSelectionValidationResponseSchema,
  AdminRegistrantSearchResponseSchema,
  AdminRegistrationListResponseSchema,
  AdminRegistrationResponseSchema,
  AvailableSponsorshipsResponseSchema,
  EventAccessItemResponseSchema,
  GroupedAccessResponseSchema,
  LinkedSponsorshipsResponseSchema,
  PaymentMethodSelectedResponseSchema,
  PaymentProofUploadResponseSchema,
  PriceBreakdownSchema,
  PublicEventAccessListResponseSchema,
  PublicFormResponseSchema,
  PublicPaymentConfigResponseSchema,
  PublicRegistrantSearchResponseSchema,
  PublicRegistrationCreateResponseSchema,
  PublicRegistrationEditResponseSchema,
  PublicRegistrationForEditResponseSchema,
  PublicSponsorFormResponseSchema,
  RegistrationAuditLogListResponseSchema,
  RegistrationEditLinkResponseSchema,
  RegistrationEmailLogListResponseSchema,
  RegistrationTableColumnsResponseSchema,
  SponsorshipBatchCreatedResponseSchema,
  SponsorshipDetailResponseSchema,
  SponsorshipLinkedResponseSchema,
  SponsorshipListResponseSchema,
  SponsorshipSuccessResponseSchema,
  type PriceBreakdown,
  type PublicPaymentConfigResponse,
} from "@app/contracts";
import type {
  EventAccessRow,
  EventAccessWithPrereqs,
  EventRow,
  FormWithRelations,
  LinkedSponsorshipItem,
  RegistrantSearchResult,
  RegistrationRow,
  SponsorshipListItem,
  SponsorshipWithUsages,
} from "@app/db";
import { paginate } from "@app/shared";
import { RESPONSE_CONTRACT, projectOntoContract } from "../core/response-contract";
import { SKIP_ENVELOPE } from "../core/envelope.interceptor";
import { groupAccess } from "./access/access-grouping";
import { AccessPublicController } from "./access/access.public.controller";
import { EventsPublicController } from "./events/events.public.controller";
import { FormsPublicController } from "./forms/forms-public.controller";
import type { FormsService } from "./forms/forms.service";
import { PricingPublicController } from "./pricing/pricing.public.controller";
import {
  RegistrationEditLinkController,
  RegistrationsController,
} from "./registrations/registrations.controller";
import {
  RegistrationEditPublicController,
  RegistrationsPublicController,
} from "./registrations/registrations.public.controller";
import {
  toAdminRegistration,
  toPublicRegistration,
} from "./registrations/registrations.mappers";
import { getRegistrationTableColumns } from "./registrations/table-columns";
import {
  RegistrationSponsorshipsController,
  SponsorshipDetailController,
  SponsorshipsListController,
} from "./sponsorships/sponsorships.controller";
import { SponsorshipsPublicController } from "./sponsorships/sponsorships.public.controller";
import { SponsorshipsPublicService } from "./sponsorships/sponsorships.public.service";
import type { AccessService } from "./access/access.service";

// ============================================================================
// Fixtures: full rows, typed against the Drizzle tables, so every column a
// route returns today is present. A contract that missed one would strip it.
// ============================================================================

const at = (iso: string) => new Date(iso);

const registrationRow: RegistrationRow = {
  id: "r1",
  formId: "f1",
  eventId: "e1",
  formData: { specialty: "cardio", diet: "other_diet", diet_other: "none" },
  networkingOptIn: true,
  submittedAt: at("2026-06-01T08:00:00.000Z"),
  formSchemaVersion: 2,
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  phone: "+216 20 000 000",
  referenceNumber: "26-SUMMIT-0001",
  paymentStatus: "PARTIAL",
  totalAmount: 300,
  paidAmount: 100,
  currency: "TND",
  paymentMethod: "BANK_TRANSFER",
  paymentReference: "VIR-1",
  paymentProofUrl: "https://storage.example/proofs/r1.webp",
  // As a public signup stores it (lines marked "confirmed"), after an access
  // item was deactivated.
  priceBreakdown: {
    basePrice: 200,
    appliedRules: [],
    calculatedBasePrice: 200,
    accessItems: [{ accessId: "a1", name: "Workshop", unitPrice: 100, quantity: 1, subtotal: 100, status: "confirmed" }],
    accessTotal: 100,
    subtotal: 300,
    sponsorships: [],
    sponsorshipTotal: 0,
    total: 300,
    currency: "TND",
    droppedAccessItems: [
      { accessId: "a2", name: "Dinner", unitPrice: 80, quantity: 1, subtotal: 80, status: "confirmed", reason: "deactivated" },
    ],
  },
  baseAmount: 200,
  discountAmount: 0,
  accessAmount: 100,
  sponsorshipCode: null,
  sponsorshipAmount: 0,
  labName: null,
  paidAt: null,
  createdAt: at("2026-06-01T08:00:00.000Z"),
  updatedAt: at("2026-06-02T08:00:00.000Z"),
  lastEditedAt: at("2026-06-02T08:00:00.000Z"),
  editToken: "e".repeat(64),
  linkBaseUrl: "https://summit.example",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  note: "VIP",
  role: "SPEAKER",
  accessTypeIds: ["a1"],
  droppedAccessIds: [],
  checkedInAt: at("2026-06-03T08:00:00.000Z"),
  checkedInBy: "u1",
};

const accessSelection = {
  id: "r1-a1",
  accessId: "a1",
  unitPrice: 100,
  quantity: 1,
  subtotal: 100,
  access: {
    id: "a1",
    name: "Workshop",
    type: "WORKSHOP",
    startsAt: at("2026-06-05T09:00:00.000Z"),
    endsAt: null,
  },
};
const droppedSelection = {
  ...accessSelection,
  id: "r1-dropped-a2",
  accessId: "a2",
  reason: "capacity_reached",
  access: { id: "a2", name: "Dinner", type: "OTHER", startsAt: null, endsAt: null },
};

const withMeta = {
  ...registrationRow,
  form: { id: "f1", name: "Registration" },
  event: { id: "e1", name: "Summit", slug: "summit", clientId: "c1" },
};

const priceBreakdown: PriceBreakdown = {
  basePrice: 200,
  appliedRules: [{ ruleId: "rule1", ruleName: "Members", effect: -50, reason: "Base price set to 150" }],
  calculatedBasePrice: 150,
  accessItems: [{ accessId: "a1", name: "Workshop", unitPrice: 100, quantity: 1, subtotal: 100 }],
  accessTotal: 100,
  subtotal: 250,
  sponsorships: [{ code: "SP-1", amount: 50, valid: true }],
  sponsorshipTotal: 50,
  total: 200,
  currency: "TND",
  droppedAccessItems: [],
};

const eventRow: EventRow = {
  id: "e1",
  clientId: "c1",
  name: "Summit",
  slug: "summit",
  description: "Annual summit",
  maxCapacity: 500,
  registeredCount: 120,
  startDate: at("2026-06-05T08:00:00.000Z"),
  endDate: at("2026-06-06T18:00:00.000Z"),
  location: "Tunis",
  status: "OPEN",
  bannerUrl: "https://cdn.example/banner.webp",
  createdAt: at("2026-01-01T00:00:00.000Z"),
  updatedAt: at("2026-01-02T00:00:00.000Z"),
};

const accessRow: EventAccessRow = {
  id: "a1",
  eventId: "e1",
  type: "WORKSHOP",
  name: "Workshop",
  description: "Hands-on",
  location: "Room 1",
  startsAt: at("2026-06-05T09:00:00.000Z"),
  endsAt: at("2026-06-05T11:00:00.000Z"),
  price: 100,
  currency: "TND",
  maxCapacity: 30,
  registeredCount: 10,
  paidCount: 8,
  availableFrom: null,
  availableTo: null,
  conditions: [{ fieldId: "specialty", operator: "equals", value: "cardio" }],
  conditionLogic: "AND",
  sortOrder: 1,
  active: true,
  groupLabel: null,
  allowCompanion: true,
  includedInBase: false,
  companionPrice: 50,
  createdAt: at("2026-01-01T00:00:00.000Z"),
  updatedAt: at("2026-01-02T00:00:00.000Z"),
};

const pricingRow: NonNullable<FormWithRelations["event"]["pricing"]> = {
  id: "p1",
  eventId: "e1",
  basePrice: 200,
  currency: "TND",
  rules: [
    {
      id: "8c0f5d8e-4b8a-4e0b-9a55-2f1f6c1e7a10",
      name: "Members",
      description: null,
      priority: 0,
      conditions: [{ fieldId: "membership", operator: "equals", value: "member" }],
      conditionLogic: "AND",
      price: 150,
      active: true,
    },
  ],
  onlinePaymentEnabled: true,
  onlinePaymentUrl: "https://pay.example",
  cashPaymentEnabled: false,
  bankName: "Bank",
  bankAccountName: "Organizer",
  bankAccountNumber: "TN59 0000",
  createdAt: at("2026-01-01T00:00:00.000Z"),
  updatedAt: at("2026-01-02T00:00:00.000Z"),
};

const client = {
  id: "c1",
  name: "Organizer",
  logo: "https://cdn.example/logo.png",
  primaryColor: "#123456",
  phone: "+216 71 000 000",
};

const publicForm: FormWithRelations = {
  id: "f1",
  eventId: "e1",
  type: "REGISTRATION",
  name: "Registration",
  schema: { steps: [{ id: "s1", title: "You", fields: [] }] },
  schemaVersion: 2,
  successTitle: "Thanks",
  successMessage: null,
  successTranslations: { fr: { title: "Merci" } },
  active: true,
  createdAt: at("2026-01-01T00:00:00.000Z"),
  updatedAt: at("2026-01-02T00:00:00.000Z"),
  event: { ...eventRow, client, pricing: pricingRow, access: [accessRow] },
};

const accessWithPrereqs: EventAccessWithPrereqs = {
  ...accessRow,
  requiredAccess: [{ id: "a0", name: "Plenary" }],
};

const sponsorshipRow = {
  id: "s1",
  batchId: "b1",
  eventId: "e1",
  code: "SP-1",
  status: "USED" as const,
  beneficiaryName: "Ada Lovelace",
  beneficiaryEmail: "ada@example.com",
  beneficiaryPhone: "+216 20 000 000",
  beneficiaryAddress: "Tunis",
  coversBasePrice: true,
  coveredAccessIds: ["a1"],
  totalAmount: 300,
  targetRegistrationId: null,
  createdAt: at("2026-05-01T00:00:00.000Z"),
  updatedAt: at("2026-05-02T00:00:00.000Z"),
};

const sponsorshipListItem: SponsorshipListItem = {
  ...sponsorshipRow,
  batch: { id: "b1", labName: "Lab", contactName: "Grace", email: "grace@lab.example" },
  usages: [{ registrationId: "r1", amountApplied: 300 }],
};

const sponsorshipDetail: SponsorshipWithUsages = {
  ...sponsorshipRow,
  event: { clientId: "c1" },
  batch: {
    id: "b1",
    eventId: "e1",
    formId: "f2",
    labName: "Lab",
    contactName: "Grace",
    email: "grace@lab.example",
    phone: null,
    formData: { note: "for our residents" },
    createdAt: at("2026-05-01T00:00:00.000Z"),
  },
  usages: [
    {
      id: "u1",
      sponsorshipId: "s1",
      registrationId: "r1",
      amountApplied: 300,
      appliedAt: at("2026-05-03T00:00:00.000Z"),
      appliedBy: "admin-1",
      registration: { id: "r1", email: "ada@example.com", firstName: "Ada", lastName: null },
    },
  ],
  coveredAccessItems: [{ id: "a1", name: "Workshop", price: 100 }],
};

const linkedSponsorship: LinkedSponsorshipItem = {
  id: "s1",
  code: "SP-1",
  status: "USED",
  beneficiaryName: "Ada Lovelace",
  beneficiaryEmail: "ada@example.com",
  coversBasePrice: true,
  coveredAccessIds: ["a1"],
  totalAmount: 300,
  batch: { id: "b1", labName: "Lab", contactName: "Grace", email: "grace@lab.example" },
  usage: { id: "u1", amountApplied: 300, appliedAt: at("2026-05-03T00:00:00.000Z") },
};

const registrantSearchResult: RegistrantSearchResult = {
  id: "r1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  paymentStatus: "PENDING",
  totalAmount: 300,
  baseAmount: 200,
  accessAmount: 100,
  sponsorshipAmount: 0,
  accessTypeIds: ["a1"],
  coveredAccessIds: [],
  isBasePriceCovered: false,
};

const paymentConfig: PublicPaymentConfigResponse = {
  event: {
    id: "e1",
    name: "Summit",
    slug: "summit",
    description: null,
    status: "OPEN",
    startDate: eventRow.startDate,
    endDate: eventRow.endDate,
    location: "Tunis",
    bannerUrl: null,
    client,
  },
  sponsorshipsEnabled: true,
  pricing: {
    basePrice: 200,
    currency: "TND",
    rules: [],
    paymentMethods: ["BANK_TRANSFER", "ONLINE"],
    bankDetails: { bankName: "Bank", accountName: "Organizer", iban: "TN59 0000", bic: "" },
    onlinePaymentUrl: "https://pay.example",
  },
};

// Payloads the route handlers produce today, built through the real mappers
// and transforms wherever the route has one.
async function todaysPayloads(): Promise<Array<[string, z.ZodType, unknown]>> {
  db.getRegistrationFormSchemaForEvent.mockResolvedValue({
    schema: {
      steps: [
        {
          fields: [
            { id: "email", type: "email", label: "E-mail" },
            { id: "first", type: "firstName", label: "Prénom" },
            { id: "last", type: "lastName", label: "Nom" },
            {
              id: "diet",
              type: "dropdown",
              label: "Régime",
              options: [
                { id: "none", label: "Aucun" },
                { id: "other_diet", label: "Autre" },
              ],
            },
            {
              id: "diet_other",
              type: "text",
              label: "Précisez",
              conditions: [{ fieldId: "diet", operator: "equals", value: "other_diet" }],
            },
          ],
        },
      ],
    },
  });
  db.getEventWithPricingBySlug.mockResolvedValue({ id: "e1", clientId: "c1" });

  const publicCreated = toPublicRegistration(
    { ...withMeta, accessSelections: [accessSelection] },
    { token: registrationRow.editToken },
  );
  const publicForEdit = toPublicRegistration({
    ...registrationRow,
    accessSelections: [accessSelection],
    form: { id: "f1", name: "Registration", schema: publicForm.schema },
    event: { id: "e1", name: "Summit", slug: "summit", status: "OPEN", endDate: eventRow.endDate },
  });
  const publicEdited = toPublicRegistration({
    ...withMeta,
    accessSelections: [accessSelection],
    droppedAccessSelections: [droppedSelection],
  });
  const admin = toAdminRegistration({
    ...withMeta,
    accessCheckIns: [{ accessId: "a1", checkedInAt: at("2026-06-05T09:05:00.000Z") }],
    accessSelections: [accessSelection],
    droppedAccessSelections: [droppedSelection],
  });
  const adminListed = toAdminRegistration({
    ...withMeta,
    accessSelections: [],
    droppedAccessSelections: [],
  });
  // Stored before dropped items were recorded (April 2026): no droppedAccessItems key.
  const { droppedAccessItems: _dropped, ...breakdownBeforeDrops } = registrationRow.priceBreakdown;
  const adminBeforeDrops = toAdminRegistration({
    ...withMeta,
    priceBreakdown: breakdownBeforeDrops,
    accessSelections: [accessSelection],
    droppedAccessSelections: [],
  });

  const formsPublic = new FormsPublicController({
    getFormByEventSlug: vi.fn(async () => publicForm),
    getSponsorFormByEventSlug: vi.fn(async () => ({ ...publicForm, type: "SPONSOR" })),
  } as unknown as FormsService);
  const registrationForm = await formsPublic.getBySlug({ slug: "summit" });
  const sponsorForm = await formsPublic.getSponsorBySlug({ slug: "summit" });

  db.searchRegistrantsForSponsorship.mockResolvedValue([registrantSearchResult]);
  const publicService = new SponsorshipsPublicService({} as AccessService);
  const publicSearch = await new SponsorshipsPublicController({
    getActiveSponsorForm: vi.fn(async () => ({
      id: "f2",
      schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } },
    })),
    searchRegistrants: publicService.searchRegistrants.bind(publicService),
  } as unknown as SponsorshipsPublicService).searchRegistrants({ slug: "summit" }, { query: "ada" });

  const grouped = groupAccess(
    [
      { ...accessRow, requiredAccess: [] },
      { ...accessRow, id: "a3", type: "ADDON", startsAt: null, endsAt: null, requiredAccess: [{ id: "a1" }] },
    ],
    { specialty: "cardio" },
    ["a1"],
    at("2026-06-01T00:00:00.000Z"),
  );

  return [
    ["POST register", PublicRegistrationCreateResponseSchema, { registration: publicCreated, priceBreakdown: registrationRow.priceBreakdown }],
    [
      "GET registration for edit",
      PublicRegistrationForEditResponseSchema,
      {
        registration: publicForEdit,
        expectedUpdatedAt: registrationRow.updatedAt.toISOString(),
        canEdit: true,
        canEditPersonalInfo: true,
        canEditAccess: false,
        canAddAccess: false,
        canRemoveAccess: false,
        isFullySponsored: false,
        amountDue: 200,
        editRestrictions: ["Access selections are locked after payment"],
      },
    ],
    ["PATCH registration", PublicRegistrationEditResponseSchema, { registration: publicEdited, priceBreakdown }],
    ["PATCH payment-method", PaymentMethodSelectedResponseSchema, { success: true }],
    [
      "POST payment-proof",
      PaymentProofUploadResponseSchema,
      {
        id: "p1",
        registrationId: "r1",
        fileUrl: "https://storage.example/proofs/r1.webp",
        fileName: "proof.webp",
        fileSize: 1024,
        mimeType: "image/webp",
        uploadedAt: "2026-06-02T08:00:00.000Z",
      },
    ],
    ["admin registration", AdminRegistrationResponseSchema, admin],
    ["admin registration, breakdown without droppedAccessItems", AdminRegistrationResponseSchema, adminBeforeDrops],
    [
      "admin registration list",
      AdminRegistrationListResponseSchema,
      {
        ...paginate([adminListed], 1, { page: 1, limit: 20 }),
        stats: {
          total: 1,
          totalAmount: 300,
          collected: 100,
          paid: { count: 0, amount: 0 },
          pending: { count: 1, amount: 200 },
          sponsored: { count: 0, amount: 0 },
        },
      },
    ],
    ["registration table columns", RegistrationTableColumnsResponseSchema, await getRegistrationTableColumns("e1")],
    ["admin registrant search", AdminRegistrantSearchResponseSchema, [registrantSearchResult]],
    [
      "registration audit logs",
      RegistrationAuditLogListResponseSchema,
      paginate(
        [
          {
            id: "l1",
            action: "CHECK_IN",
            changes: { checkedIn: { old: false, new: true } },
            performedBy: "u1",
            performedByName: "Staff",
            performedAt: "2026-06-05T09:05:00.000Z",
            ipAddress: null,
          },
        ],
        1,
        { page: 1, limit: 50 },
      ),
    ],
    [
      "registration email logs",
      RegistrationEmailLogListResponseSchema,
      paginate(
        [
          {
            id: "m1",
            subject: "Sponsoring",
            status: "SENT",
            trigger: "SPONSORSHIP_APPLIED",
            templateName: null,
            errorMessage: null,
            queuedAt: "2026-05-03T00:00:00.000Z",
            sentAt: "2026-05-03T00:00:01.000Z",
            deliveredAt: null,
            openedAt: null,
            clickedAt: null,
            bouncedAt: null,
            failedAt: null,
          },
        ],
        1,
        { page: 1, limit: 50 },
      ),
    ],
    ["registration edit link", RegistrationEditLinkResponseSchema, { url: "https://summit.example/registration/r1/tok" }],
    [
      "public sponsorship batch",
      SponsorshipBatchCreatedResponseSchema,
      { success: true, message: "2 sponsoring(s) created successfully", batchId: "b1", count: 2 },
    ],
    ["public registrant search", PublicRegistrantSearchResponseSchema, publicSearch],
    [
      "sponsorship list",
      SponsorshipListResponseSchema,
      {
        ...paginate([sponsorshipListItem], 1, { page: 1, limit: 20 }),
        stats: {
          total: 1,
          totalAmount: 300,
          pending: { count: 0, amount: 0 },
          used: { count: 1, amount: 300 },
          cancelled: { count: 0, amount: 0 },
        },
      },
    ],
    ["sponsorship detail", SponsorshipDetailResponseSchema, sponsorshipDetail],
    ["sponsorship success", SponsorshipSuccessResponseSchema, { success: true }],
    [
      "available sponsorships",
      AvailableSponsorshipsResponseSchema,
      {
        sponsorships: [
          {
            id: "s2",
            code: "SP-2",
            beneficiaryName: "Ada Lovelace",
            beneficiaryEmail: "ada@example.com",
            totalAmount: 200,
            coversBasePrice: true,
            coveredAccessIds: [],
            batch: { labName: "Lab" },
            applicableAmount: 200,
            conflicts: [],
          },
        ],
      },
    ],
    ["linked sponsorships", LinkedSponsorshipsResponseSchema, [linkedSponsorship]],
    [
      "sponsorship linked",
      SponsorshipLinkedResponseSchema,
      {
        success: true,
        usage: { id: "u1", sponsorshipId: "s1", amountApplied: 300 },
        registration: { totalAmount: 300, sponsorshipAmount: 300, amountDue: 0 },
        warnings: [],
      },
    ],
    ["public registration form", PublicFormResponseSchema, registrationForm],
    ["public sponsor form", PublicSponsorFormResponseSchema, sponsorForm],
    ["payment config", PublicPaymentConfigResponseSchema, paymentConfig],
    ["price quote", PriceBreakdownSchema, priceBreakdown],
    ["public access list", PublicEventAccessListResponseSchema, [accessWithPrereqs]],
    ["public access item", EventAccessItemResponseSchema, accessWithPrereqs],
    ["grouped access", GroupedAccessResponseSchema, grouped],
    ["access validation", AccessSelectionValidationResponseSchema, { valid: false, errors: ["Workshop is full"] }],
  ];
}

describe("response contracts match today's route payloads", () => {
  it("strip nothing, keep the bytes and validate, route by route", async () => {
    const payloads = await todaysPayloads();
    expect(payloads.length).toBeGreaterThan(25);
    for (const [route, schema, payload] of payloads) {
      const { value, stripped } = projectOntoContract(schema, payload);
      expect({ route, stripped }).toEqual({ route, stripped: [] });
      expect({ route, json: JSON.stringify(value) }).toEqual({
        route,
        json: JSON.stringify(payload),
      });
      const parsed = schema.safeParse(value);
      expect({ route, issues: parsed.error?.issues ?? [] }).toEqual({ route, issues: [] });
    }
  });

  it("the public registration form differs from the stored row by exactly event.clientId", async () => {
    // The route returned the whole row before; the contract now keeps the
    // event's clientId internal (the form app does not read it).
    expect(projectOntoContract(PublicFormResponseSchema, publicForm).stripped).toEqual([
      "event.clientId",
    ]);
    const payloads = await todaysPayloads();
    const served = payloads.find(([route]) => route === "public registration form")?.[2];
    const { clientId, ...event } = publicForm.event;
    expect(clientId).toBe("c1");
    expect(JSON.stringify(served)).toBe(JSON.stringify({ ...publicForm, event }));
  });

  it("a price breakdown key no writer stores is stripped and reported, like any undeclared key", async () => {
    const payloads = await todaysPayloads();
    const admin = payloads.find(([route]) => route === "admin registration")?.[2] as {
      priceBreakdown: PriceBreakdown;
    };
    const { value, stripped } = projectOntoContract(AdminRegistrationResponseSchema, {
      ...admin,
      priceBreakdown: { ...admin.priceBreakdown, internalNote: "VIP" },
    });
    expect(stripped).toEqual(["priceBreakdown.internalNote"]);
    expect(JSON.stringify(value)).toBe(JSON.stringify(admin));
  });

  it("the grouped-access fixture exercises both dated slots and the add-on group", async () => {
    const payloads = await todaysPayloads();
    const grouped = payloads.find(([route]) => route === "grouped access")?.[2] as {
      groups: unknown[];
      addonGroup: unknown;
    };
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.addonGroup).not.toBeNull();
  });

  it("the columns fixture carries a folded 'specify other' column (mergeWith)", async () => {
    const payloads = await todaysPayloads();
    const columns = payloads.find(([route]) => route === "registration table columns")?.[2];
    expect(JSON.stringify(columns)).toContain('"mergeWith":{"fieldId":"diet_other","triggerValue":"other_diet"}');
  });
});

// ============================================================================
// Coverage: every enveloped route of these controllers declares a contract.
// ============================================================================

const COVERED_CONTROLLERS = [
  RegistrationsPublicController,
  RegistrationEditPublicController,
  RegistrationsController,
  RegistrationEditLinkController,
  SponsorshipsPublicController,
  SponsorshipsListController,
  SponsorshipDetailController,
  RegistrationSponsorshipsController,
  EventsPublicController,
  FormsPublicController,
  PricingPublicController,
  AccessPublicController,
];

describe("response contract coverage", () => {
  it.each(COVERED_CONTROLLERS.map((c) => [c.name, c] as const))(
    "%s: every route has a contract unless it skips the envelope (raw body / 204)",
    (_name, controller) => {
      const proto = controller.prototype as unknown as Record<string, unknown>;
      const routes = Object.getOwnPropertyNames(proto).filter(
        (key) =>
          key !== "constructor" &&
          typeof proto[key] === "function" &&
          Reflect.getMetadata(PATH_METADATA, proto[key] as object) !== undefined,
      );
      expect(routes.length).toBeGreaterThan(0);
      const missing = routes.filter((key) => {
        const handler = proto[key] as object;
        return (
          Reflect.getMetadata(RESPONSE_CONTRACT, handler) === undefined &&
          Reflect.getMetadata(SKIP_ENVELOPE, handler) !== true
        );
      });
      expect(missing).toEqual([]);
    },
  );
});
