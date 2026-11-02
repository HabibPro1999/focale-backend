import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATH_METADATA } from "@nestjs/common/constants";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";

// The public abstracts routes run for real (controllers and services); only
// the DB queries, the client module gate and Firebase are stubbed.
const db = vi.hoisted(() => ({
  findPublicConfigData: vi.fn(),
  findEventConfigForSubmit: vi.fn(),
  findActiveThemeIds: vi.fn(),
  findAbstractThemeIds: vi.fn(),
  findDuplicateAuthorEmail: vi.fn(),
  findRegistrationEventId: vi.fn(),
  findEventClientId: vi.fn(),
  submitAbstractTxn: vi.fn(),
  findAbstractForToken: vi.fn(),
  findAbstractForEdit: vi.fn(),
  editAbstractTxn: vi.fn(),
  findCommitteeInviteByHash: vi.fn(),
  findAbstractMembership: vi.fn(),
  claimCommitteeInvite: vi.fn(),
  deleteUnusedCommitteeInvites: vi.fn(),
  insertCommitteeInvite: vi.fn(),
  supersedeCommitteeInvite: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...db,
}));
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateFirebaseUserPassword: vi.fn(async () => undefined),
  revokeFirebaseRefreshTokens: vi.fn(async () => undefined),
}));
vi.mock("../clients/module-gates", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertClientModuleEnabled: vi.fn(async () => undefined),
}));

import {
  AbstractSubmittedResponseSchema,
  CommitteeInvitePasswordSetResponseSchema,
  CommitteeInviteResendResponseSchema,
  CommitteeInviteVerifyResponseSchema,
  PublicAbstractConfigResponseSchema,
  PublicAbstractResponseSchema,
  UserRole,
  type SubmitAbstractInput,
} from "@app/contracts";
import type {
  AbstractConfigRow,
  AbstractForEdit,
  AbstractForToken,
  AbstractRow,
  EventConfigForSubmit,
  PublicConfigData,
} from "@app/db";
import type { Config } from "../../core/config";
import { SKIP_ENVELOPE } from "../../core/envelope.interceptor";
import { RESPONSE_CONTRACT, projectOntoContract } from "../../core/response-contract";
import type { CommitteeEmailsService } from "./abstracts.committee-emails";
import { CommitteeInviteController } from "./abstracts.committee-invite.controller";
import { CommitteeInviteService } from "./abstracts.committee-invite.service";
import type { AbstractsFinalFileService } from "./abstracts.final-file.service";
import { AbstractsPublicController } from "./abstracts.public.controller";
import { AbstractsService } from "./abstracts.service";
import { hashCommitteeInviteToken } from "./committee-invite-token";

// ============================================================================
// Fixtures: full rows, typed against the Drizzle tables, so every column the
// queries return is present (the services pick their fields from these).
// ============================================================================

const at = (iso: string) => new Date(iso);
const token = "a".repeat(64);
const themeId = "44444444-4444-4444-8444-444444444444";

const configRow: AbstractConfigRow = {
  id: "cfg1",
  eventId: "e1",
  submissionMode: "STRUCTURED",
  globalWordLimit: 600,
  sectionWordLimits: { introduction: 120, methods: 200, results: null },
  submissionStartAt: at("2026-01-01T08:00:00.000Z"),
  submissionDeadline: at("2099-01-01T08:00:00.000Z"),
  editingDeadline: at("2099-02-01T08:00:00.000Z"),
  scoringStartAt: at("2099-03-01T08:00:00.000Z"),
  scoringDeadline: at("2099-04-01T08:00:00.000Z"),
  finalFileDeadline: at("2099-05-01T08:00:00.000Z"),
  editingEnabled: true,
  commentsEnabled: true,
  commentsSentToAuthor: true,
  finalFileUploadEnabled: true,
  reviewersPerAbstract: 2,
  divergenceThreshold: 6,
  maxThemesPerAbstract: 2,
  distributeByTheme: true,
  modeLocked: true,
  bookFontFamily: "Arial",
  bookFontSize: 11,
  bookLineSpacing: 1.5,
  bookOrder: "BY_CODE",
  bookIncludeAuthorNames: true,
  additionalFieldsSchema: [
    { id: "hospital", type: "text", label: "Hôpital", required: false },
  ],
  languages: { default: "fr", enabled: ["fr", "en"] },
  createdAt: at("2026-01-01T08:00:00.000Z"),
  updatedAt: at("2026-01-02T08:00:00.000Z"),
};

const publicConfigData: PublicConfigData = {
  eventId: "e1",
  eventName: "Congrès national",
  clientId: "c1",
  config: configRow,
  themes: [
    {
      id: themeId,
      label: "Cardiologie",
      description: "Cœur et vaisseaux",
      translations: { en: { label: "Cardiology" } },
    },
    { id: "t2", label: "Neurologie", description: null, translations: null },
  ],
};

const content = {
  mode: "STRUCTURED",
  title: "Étude <em>rétrospective</em>",
  introduction: "<p>Intro</p>",
  objective: "<p>Objectif</p>",
  methods: "<p>Méthodes</p>",
  results: "<p>Résultats</p>",
  conclusion: "<p>Conclusion</p>",
};

const abstractRow: AbstractRow = {
  id: "abs1",
  eventId: "e1",
  authorFirstName: "Ada",
  authorLastName: "Lovelace",
  authorAffiliation: "CHU Tunis",
  authorEmail: "Ada@Example.com",
  authorEmailNormalized: "ada@example.com",
  authorPhone: "+216 20 000 000",
  requestedType: "ORAL_COMMUNICATION",
  content,
  coAuthors: [{ firstName: "Grace", lastName: "Hopper", affiliation: "Navy" }],
  additionalFieldsData: { hospital: "Charles Nicolle" },
  code: "OC1-01",
  codeNumber: 1,
  status: "UNDER_REVIEW",
  contentVersion: 3,
  finalType: "POSTER",
  averageScore: 14.5,
  reviewCount: 2,
  presentedAt: null,
  presentedBy: null,
  finalFileKey: "abstracts/e1/abs1/final.pdf",
  finalFileKind: "PDF",
  finalFileSize: 123_456,
  finalFileUploadedAt: at("2026-06-03T08:00:00.000Z"),
  editToken: token,
  lastEditedAt: at("2026-06-02T08:00:00.000Z"),
  linkBaseUrl: "https://events.example.com",
  registrationId: null,
  createdAt: at("2026-06-01T08:00:00.000Z"),
  updatedAt: at("2026-06-02T08:00:00.000Z"),
};

const abstractForToken: AbstractForToken = {
  ...abstractRow,
  themes: [{ id: themeId, label: "Cardiologie" }],
  config: {
    editingEnabled: true,
    editingDeadline: at("2099-02-01T08:00:00.000Z"),
    finalFileUploadEnabled: true,
    finalFileDeadline: at("2099-05-01T08:00:00.000Z"),
  },
};

const submitBody: SubmitAbstractInput = {
  authorFirstName: "Ada",
  authorLastName: "Lovelace",
  authorAffiliation: "CHU Tunis",
  authorEmail: "Ada@Example.com",
  authorPhone: "+216 20 000 000",
  coAuthors: [{ firstName: "Grace", lastName: "Hopper", affiliation: "Navy" }],
  requestedType: "ORAL_COMMUNICATION",
  themeIds: [themeId],
  content: {
    mode: "STRUCTURED",
    title: "Étude",
    introduction: "Intro",
    objective: "Objectif",
    methods: "Méthodes",
    results: "Résultats",
    conclusion: "Conclusion",
  },
  additionalFieldsData: { hospital: "Charles Nicolle" },
  registrationId: null,
  linkBaseUrl: "https://events.example.com",
};

const inviteRaw = "b".repeat(64);
const invite = {
  id: "inv1",
  userId: "u1",
  eventId: "e1",
  tokenHash: hashCommitteeInviteToken(inviteRaw),
  usedAt: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt: at("2026-06-01T08:00:00.000Z"),
  createdBy: "admin1",
  user: {
    id: "u1",
    email: "reviewer@example.com",
    name: "Dr Reviewer",
    active: true,
    role: UserRole.SCIENTIFIC_COMMITTEE,
  },
  event: { name: "Congrès national" },
};

const request = () =>
  ({ query: {}, headers: { "x-abstract-token": token }, ip: "203.0.113.9" }) as unknown as FastifyRequest;

function stubDb() {
  db.findPublicConfigData.mockResolvedValue(publicConfigData);
  db.findEventConfigForSubmit.mockResolvedValue({
    event: { id: "e1", name: "Congrès national", slug: "congres", clientId: "c1" },
    config: configRow,
  } satisfies EventConfigForSubmit);
  db.findActiveThemeIds.mockResolvedValue([themeId]);
  db.findAbstractThemeIds.mockResolvedValue([themeId]);
  db.findDuplicateAuthorEmail.mockResolvedValue(false);
  db.findEventClientId.mockResolvedValue({ clientId: "c1" });
  db.submitAbstractTxn.mockResolvedValue({ ok: true, createdAt: at("2026-06-01T08:00:00.000Z") });
  db.findAbstractForToken.mockResolvedValue(abstractForToken);
  db.findAbstractForEdit.mockResolvedValue({ ...abstractRow, config: configRow } satisfies AbstractForEdit);
  db.editAbstractTxn.mockResolvedValue({ ok: true });
  db.findCommitteeInviteByHash.mockResolvedValue(invite);
  db.findAbstractMembership.mockResolvedValue({ active: true });
  db.claimCommitteeInvite.mockResolvedValue(true);
  db.deleteUnusedCommitteeInvites.mockResolvedValue(undefined);
  db.insertCommitteeInvite.mockResolvedValue({ id: "inv2" });
  db.supersedeCommitteeInvite.mockResolvedValue(undefined);
  db.insertAuditLog.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubDb();
});

const abstracts = new AbstractsService({
  publicLinkAllowedOrigins: ["https://events.example.com"],
} as Config);
// The final-file upload ends with `return this.abstracts.getAbstractByToken(…)`;
// the storage side is covered by abstracts.final-file.*.test.ts.
const finalFile = {
  uploadAbstractFinalFile: (id: string, tok: string) => abstracts.getAbstractByToken(id, tok),
} as unknown as AbstractsFinalFileService;
const publicController = new AbstractsPublicController(abstracts, finalFile);

const inviteController = new CommitteeInviteController(
  new CommitteeInviteService(
    {
      urls: { adminAppUrl: "https://admin.example" },
      security: { committeeInvite: { tokenTtlDays: 7 } },
    } as Config,
    { sendInviteEmail: vi.fn(async () => true) } as unknown as CommitteeEmailsService,
  ),
);

// Payloads the route handlers produce today.
async function todaysPayloads(): Promise<Array<[string, z.ZodType, unknown]>> {
  const configEnabled = await publicController.getConfig({ slug: "congres" });
  db.findPublicConfigData.mockResolvedValueOnce({ ...publicConfigData, config: null, themes: [] });
  const configDisabled = await publicController.getConfig({ slug: "congres" });
  const submitted = await publicController.submit({ slug: "congres" }, submitBody, request());
  const byToken = await publicController.getByToken({ id: "abs1" }, {}, request());
  const edited = await publicController.edit({ id: "abs1" }, {}, submitBody, request());
  const uploaded = await publicController.uploadFinalFile(
    { id: "abs1" },
    {},
    request() as Parameters<AbstractsPublicController["uploadFinalFile"]>[2],
  );
  const verified = await inviteController.verify({ token: inviteRaw });
  const passwordSet = await inviteController.setPassword({ token: inviteRaw, password: "Str0ng!Passw0rd" });
  const resent = await inviteController.resend({ token: inviteRaw });

  return [
    ["abstracts config (enabled)", PublicAbstractConfigResponseSchema, configEnabled],
    ["abstracts config (not configured)", PublicAbstractConfigResponseSchema, configDisabled],
    ["abstract submit", AbstractSubmittedResponseSchema, submitted],
    ["abstract by token", PublicAbstractResponseSchema, byToken],
    ["abstract edit", PublicAbstractResponseSchema, edited],
    ["abstract final file", PublicAbstractResponseSchema, uploaded],
    ["committee invite verify", CommitteeInviteVerifyResponseSchema, verified],
    ["committee invite set password", CommitteeInvitePasswordSetResponseSchema, passwordSet],
    ["committee invite resend", CommitteeInviteResendResponseSchema, resent],
  ];
}

describe("public abstracts response contracts match today's route payloads", () => {
  it("strip nothing, keep the bytes and validate, route by route", async () => {
    const payloads = await todaysPayloads();
    expect(payloads).toHaveLength(9);
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

  it("the fixtures reach every optional branch (dates, final file, themes, invite delivery)", async () => {
    const payloads = Object.fromEntries(
      (await todaysPayloads()).map(([route, , payload]) => [route, JSON.stringify(payload)]),
    );
    expect(payloads["abstracts config (enabled)"]).toContain('"submissionStart":"2026-01-01T08:00:00.000Z"');
    expect(payloads["abstracts config (enabled)"]).toContain('"translations":{"en":{"label":"Cardiology"}}');
    expect(payloads["abstracts config (not configured)"]).toBe('{"enabled":false}');
    expect(payloads["abstract by token"]).toContain('"kind":"PDF","size":123456');
    expect(payloads["abstract by token"]).toContain('"code":"OC1-01"');
    expect(db.supersedeCommitteeInvite).toHaveBeenCalledWith("inv2");
  });

  it("a stored column the services don't pick (edit token, storage key) could not leak", async () => {
    const byToken = (await todaysPayloads()).find(([route]) => route === "abstract by token")?.[2];
    const withRowColumns = {
      ...(byToken as object),
      editToken: token,
      finalFileKey: abstractRow.finalFileKey,
      finalFile: { ...(byToken as { finalFile: object }).finalFile, key: abstractRow.finalFileKey },
    };
    const { value, stripped } = projectOntoContract(PublicAbstractResponseSchema, withRowColumns);
    expect(stripped).toEqual(["finalFile.key", "editToken", "finalFileKey"]);
    expect(JSON.stringify(value)).toBe(JSON.stringify(byToken));
  });
});

// ============================================================================
// Coverage: every enveloped route of these controllers declares a contract.
// ============================================================================

describe("public abstracts response contract coverage", () => {
  it.each([
    ["AbstractsPublicController", AbstractsPublicController],
    ["CommitteeInviteController", CommitteeInviteController],
  ] as const)("%s: every route has a contract unless it skips the envelope", (_name, controller) => {
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
  });
});
