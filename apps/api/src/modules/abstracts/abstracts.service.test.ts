import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SubmitAbstractInput } from "@app/contracts";
import type { AbstractConfigRow } from "@app/db";

// ---------------------------------------------------------------------------
// Mock the db query layer + the client module gate. @app/shared stays real
// (countWords, HTML helpers, validateFormData, newId all exercise real code).
// ---------------------------------------------------------------------------
vi.mock("@app/db", () => ({
  findPublicConfigData: vi.fn(),
  findEventConfigForSubmit: vi.fn(),
  findActiveThemeIds: vi.fn(),
  findDuplicateAuthorEmail: vi.fn(),
  findAbstractForToken: vi.fn(),
  findAbstractForEdit: vi.fn(),
  submitAbstractTxn: vi.fn(),
  editAbstractTxn: vi.fn(),
}));
vi.mock("../clients/module-gates", () => ({
  assertClientModuleEnabled: vi.fn(),
}));

import {
  findPublicConfigData,
  findEventConfigForSubmit,
  findActiveThemeIds,
  findDuplicateAuthorEmail,
  findAbstractForToken,
  findAbstractForEdit,
  submitAbstractTxn,
  editAbstractTxn,
} from "@app/db";
import { AbstractsService, countWords } from "./abstracts.service";
import { AppException } from "./app-exception";
import {
  abstractHtmlToText,
  sanitizeAbstractHtml,
} from "./abstracts.html";
import {
  generateAbstractToken,
  verifyAbstractToken,
} from "./abstracts.token";

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const eventId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";
const configId = "33333333-3333-4333-8333-333333333333";
const themeId = "44444444-4444-4444-8444-444444444444";
const slug = "test-congress";

function makeConfig(overrides: Partial<AbstractConfigRow> = {}): AbstractConfigRow {
  return {
    id: configId,
    eventId,
    submissionMode: "FREE_TEXT",
    globalWordLimit: 500,
    sectionWordLimits: null,
    submissionStartAt: null,
    submissionDeadline: null,
    editingDeadline: null,
    scoringStartAt: null,
    scoringDeadline: null,
    finalFileDeadline: null,
    editingEnabled: true,
    commentsEnabled: false,
    commentsSentToAuthor: false,
    finalFileUploadEnabled: false,
    reviewersPerAbstract: 2,
    divergenceThreshold: 6,
    maxThemesPerAbstract: null,
    distributeByTheme: false,
    modeLocked: false,
    bookFontFamily: "Arial",
    bookFontSize: 11,
    bookLineSpacing: 1.5,
    bookOrder: "BY_CODE",
    bookIncludeAuthorNames: true,
    additionalFieldsSchema: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSubmitBody(overrides: Record<string, unknown> = {}): SubmitAbstractInput {
  return {
    authorFirstName: "Ahmed",
    authorLastName: "Salah",
    authorAffiliation: "CHU Tunis",
    authorEmail: "ahmed@example.com",
    authorPhone: "+21612345678",
    coAuthors: [],
    requestedType: "ORAL_COMMUNICATION",
    themeIds: [themeId],
    content: { mode: "FREE_TEXT", title: "My Abstract", body: "Some body text" },
    additionalFieldsData: {},
    registrationId: null,
    linkBaseUrl: "https://events.example.com",
    ...overrides,
  } as SubmitAbstractInput;
}

async function expectAppError(
  p: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).getStatus()).toBe(status);
  expect((err as AppException).getResponse()).toMatchObject({ code });
}

const service = new AbstractsService();

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Pure helpers
// ===========================================================================
describe("countWords", () => {
  it("returns 0 for empty / whitespace-only", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t  ")).toBe(0);
  });
  it("counts normal + consecutive-whitespace text", () => {
    expect(countWords("Hello world foo bar")).toBe(4);
    expect(countWords("Hello   world   foo")).toBe(3);
  });
  it("treats unicode non-breaking space as a separator", () => {
    expect(countWords("Hello world")).toBe(2);
  });
  it("counts a long single word as one", () => {
    expect(countWords("superlongword")).toBe(1);
  });
});

describe("abstract rich-text helpers", () => {
  it("keeps only supported formatting tags", () => {
    expect(
      sanitizeAbstractHtml(
        '<p class="x">Safe <b>bold</b> <i>italic</i> <u>under</u><script>alert(1)</script><span>plain</span></p>',
      ),
    ).toBe("<p>Safe <strong>bold</strong> <em>italic</em> <u>under</u>alert(1)plain</p>");
  });
  it("extracts visible text and does not glue adjacent words", () => {
    expect(
      abstractHtmlToText("<p>One <strong>two</strong></p><ul><li>three</li></ul>"),
    ).toBe("One two\n\nthree");
    expect(abstractHtmlToText("<strong>one</strong><strong>two</strong>")).toBe(
      "one two",
    );
  });
  it("keeps inequalities in prose intact", () => {
    expect(abstractHtmlToText("p < 0.05 and n > 30")).toBe("p < 0.05 and n > 30");
    expect(sanitizeAbstractHtml("effect when x < 5 and y > 10")).toBe(
      "effect when x &lt; 5 and y &gt; 10",
    );
  });
  it("drops out-of-range / control-char entities without crashing", () => {
    expect(() => sanitizeAbstractHtml("<p>&#x110000;&#0;ok</p>")).not.toThrow();
    expect(sanitizeAbstractHtml("<p>&#x110000;&#0;ok</p>")).toBe("<p>ok</p>");
  });
});

describe("verifyAbstractToken", () => {
  it("true for matching, false for mismatch / length mismatch (no throw)", () => {
    const token = generateAbstractToken();
    expect(verifyAbstractToken(token, token)).toBe(true);
    expect(verifyAbstractToken(token, generateAbstractToken())).toBe(false);
    expect(verifyAbstractToken(token, "short")).toBe(false);
    expect(() => verifyAbstractToken(token, "")).not.toThrow();
    expect(verifyAbstractToken(token, "")).toBe(false);
  });
});

// ===========================================================================
// getPublicConfig
// ===========================================================================
describe("getPublicConfig", () => {
  it("returns enabled=false when no config exists", async () => {
    mock(findPublicConfigData).mockResolvedValue({
      eventId,
      eventName: "Test",
      clientId,
      config: null,
      themes: [],
    });
    const result = await service.getPublicConfig(slug);
    expect(result.enabled).toBe(false);
  });

  it("returns config with active themes", async () => {
    const themes = [{ id: themeId, label: "Theme A", description: null }];
    mock(findPublicConfigData).mockResolvedValue({
      eventId,
      eventName: "Test Congress",
      clientId,
      config: makeConfig(),
      themes,
    });
    const result = await service.getPublicConfig(slug);
    expect(result).toMatchObject({
      enabled: true,
      themes,
      submissionMode: "FREE_TEXT",
    });
  });

  it("keeps public submissions open when mode is locked", async () => {
    mock(findPublicConfigData).mockResolvedValue({
      eventId,
      eventName: "Test Congress",
      clientId,
      config: makeConfig({ modeLocked: true }),
      themes: [],
    });
    const result = await service.getPublicConfig(slug);
    expect(result).toMatchObject({ enabled: true, acceptingSubmissions: true });
  });

  it("404s when the event is missing", async () => {
    mock(findPublicConfigData).mockResolvedValue(null);
    await expectAppError(service.getPublicConfig(slug), 404, "RES_3001");
  });
});

// ===========================================================================
// submitAbstract
// ===========================================================================
describe("submitAbstract", () => {
  function setup(configOverrides: Partial<AbstractConfigRow> = {}) {
    mock(findEventConfigForSubmit).mockResolvedValue({
      event: { id: eventId, name: "Test Congress", slug, clientId },
      config: makeConfig(configOverrides),
    });
    mock(findActiveThemeIds).mockResolvedValue([themeId]);
    mock(findDuplicateAuthorEmail).mockResolvedValue(false);
    mock(submitAbstractTxn).mockResolvedValue({ ok: true, createdAt: new Date() });
  }

  it("happy path: persists sanitized content, returns token + statusUrl", async () => {
    setup();
    const result = await service.submitAbstract(
      slug,
      makeSubmitBody({ registrationId: eventId }),
      "203.0.113.10",
    );

    expect(result.status).toBe("SUBMITTED");
    expect(result.token).toHaveLength(64);
    expect(result.statusUrl).toContain(`/abstracts/${result.id}/`);

    const call = mock(submitAbstractTxn).mock.calls[0][0];
    expect(call.id).toBe(result.id);
    expect(call.submissionAckDedupeKey).toBe(
      `email:abstract:ABSTRACT_SUBMISSION_ACK:${result.id}`,
    );
    expect(call.themeIds).toEqual([themeId]);
    expect(call.revisionSnapshot).toMatchObject({
      authorEmail: "ahmed@example.com",
      themeIds: [themeId],
      registrationId: eventId,
    });
  });

  it("sanitizes rich HTML before persisting", async () => {
    setup();
    await service.submitAbstract(
      slug,
      makeSubmitBody({
        content: {
          mode: "FREE_TEXT",
          title: "Title",
          body: '<p>Hello <strong>world</strong><img src=x onerror=alert(1)> <span style="color:red">plain</span></p>',
        },
      }),
    );
    const call = mock(submitAbstractTxn).mock.calls[0][0];
    expect(call.content).toEqual({
      mode: "FREE_TEXT",
      title: "Title",
      body: "<p>Hello <strong>world</strong> plain</p>",
    });
  });

  it("pre-check duplicate author-email → 409 ABS_18010, no txn", async () => {
    setup();
    mock(findDuplicateAuthorEmail).mockResolvedValue(true);
    await expectAppError(
      service.submitAbstract(slug, makeSubmitBody()),
      409,
      "ABS_18010",
    );
    expect(submitAbstractTxn).not.toHaveBeenCalled();
  });

  it("DB duplicate-email race → 409 ABS_18010", async () => {
    setup();
    mock(submitAbstractTxn).mockResolvedValue({ ok: false, reason: "duplicate_email" });
    await expectAppError(
      service.submitAbstract(slug, makeSubmitBody()),
      409,
      "ABS_18010",
    );
  });

  it("rejects when the submission deadline has passed (ABS_18001)", async () => {
    setup({ submissionDeadline: new Date("2020-01-01") });
    await expectAppError(
      service.submitAbstract(slug, makeSubmitBody()),
      409,
      "ABS_18001",
    );
    expect(submitAbstractTxn).not.toHaveBeenCalled();
  });

  it("rejects a content-mode mismatch (ABS_18002)", async () => {
    setup({ submissionMode: "STRUCTURED" });
    await expectAppError(
      service.submitAbstract(
        slug,
        makeSubmitBody({ content: { mode: "FREE_TEXT", title: "T", body: "B" } }),
      ),
      409,
      "ABS_18002",
    );
  });

  it("rejects invalid theme IDs (422 ABS_18004)", async () => {
    setup();
    mock(findActiveThemeIds).mockResolvedValue([]);
    await expectAppError(
      service.submitAbstract(slug, makeSubmitBody()),
      422,
      "ABS_18004",
    );
  });

  it("rejects a missing mandatory additional field (422 ABS_18005)", async () => {
    setup({
      additionalFieldsSchema: [
        { id: "institution", type: "text", label: "Institution", required: true },
      ],
    });
    await expectAppError(
      service.submitAbstract(slug, makeSubmitBody({ additionalFieldsData: {} })),
      422,
      "ABS_18005",
    );
  });

  it("rejects an exceeded word limit, including a configured zero (422 ABS_18003)", async () => {
    setup({ globalWordLimit: 5 });
    await expectAppError(
      service.submitAbstract(
        slug,
        makeSubmitBody({
          content: {
            mode: "FREE_TEXT",
            title: "Title",
            body: "one two three four five six seven eight",
          },
        }),
      ),
      422,
      "ABS_18003",
    );

    setup({ globalWordLimit: 0 });
    await expectAppError(
      service.submitAbstract(
        slug,
        makeSubmitBody({
          content: { mode: "FREE_TEXT", title: "Title", body: "one" },
        }),
      ),
      422,
      "ABS_18003",
    );
  });

  it("counts rich HTML by visible text for word limits", async () => {
    setup({ globalWordLimit: 2 });
    const result = await service.submitAbstract(
      slug,
      makeSubmitBody({
        content: { mode: "FREE_TEXT", title: "Title", body: "<p>one <strong>two</strong></p>" },
      }),
    );
    expect(result.status).toBe("SUBMITTED");
  });
});

// ===========================================================================
// getAbstractByToken
// ===========================================================================
describe("getAbstractByToken", () => {
  function makeStored(token: string, overrides: Record<string, unknown> = {}) {
    return {
      id: "abs-1",
      eventId,
      status: "SUBMITTED",
      code: null,
      authorFirstName: "A",
      authorLastName: "B",
      authorAffiliation: "Aff",
      authorEmail: "a@b.com",
      authorPhone: "+1",
      coAuthors: [],
      requestedType: "ORAL_COMMUNICATION",
      finalType: null,
      content: {},
      additionalFieldsData: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      lastEditedAt: null,
      finalFileKind: null,
      finalFileSize: null,
      finalFileUploadedAt: null,
      finalFileKey: null,
      editToken: token,
      themes: [{ id: themeId, label: "Theme A" }],
      config: {
        editingEnabled: true,
        editingDeadline: null,
        finalFileUploadEnabled: false,
        finalFileDeadline: null,
      },
      ...overrides,
    };
  }

  it("reports editing locked after a final decision", async () => {
    const token = generateAbstractToken();
    mock(findAbstractForToken).mockResolvedValue(makeStored(token, { status: "ACCEPTED" }));
    const result = await service.getAbstractByToken("abs-1", token);
    expect(result.editing.allowed).toBe(false);
  });

  it("404s a well-formed but wrong token", async () => {
    const token = generateAbstractToken();
    mock(findAbstractForToken).mockResolvedValue(makeStored(token));
    await expectAppError(
      service.getAbstractByToken("abs-1", generateAbstractToken()),
      404,
      "RES_3001",
    );
  });
});

// ===========================================================================
// editAbstract
// ===========================================================================
describe("editAbstract", () => {
  function setup(
    abstractOverrides: Record<string, unknown> = {},
    configOverrides: Partial<AbstractConfigRow> = {},
  ) {
    const editToken = generateAbstractToken();
    const abstract = {
      id: "abs-1",
      eventId,
      status: "SUBMITTED",
      registrationId: null,
      editToken,
      config: makeConfig(configOverrides),
      ...abstractOverrides,
    };
    mock(findAbstractForEdit).mockResolvedValue(abstract);
    mock(findActiveThemeIds).mockResolvedValue([themeId]);
    mock(findDuplicateAuthorEmail).mockResolvedValue(false);
    mock(editAbstractTxn).mockResolvedValue({ ok: true });
    // Final read after edit.
    mock(findAbstractForToken).mockResolvedValue({
      id: "abs-1",
      eventId,
      status: "SUBMITTED",
      code: null,
      authorFirstName: "A",
      authorLastName: "B",
      authorAffiliation: "Aff",
      authorEmail: "a@b.com",
      authorPhone: "+1",
      coAuthors: [],
      requestedType: "POSTER",
      finalType: null,
      content: {},
      additionalFieldsData: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      lastEditedAt: new Date(),
      finalFileKind: null,
      finalFileSize: null,
      finalFileUploadedAt: null,
      finalFileKey: null,
      editToken,
      themes: [{ id: themeId, label: "Theme A" }],
      config: {
        editingEnabled: true,
        editingDeadline: null,
        finalFileUploadEnabled: false,
        finalFileDeadline: null,
      },
    });
    return { editToken };
  }

  it("happy path: edits and delegates to the txn", async () => {
    const { editToken } = setup();
    const result = await service.editAbstract(
      "abs-1",
      editToken,
      makeSubmitBody({ registrationId: eventId }),
      "203.0.113.11",
    );
    expect(result.id).toBe("abs-1");
    const call = mock(editAbstractTxn).mock.calls[0][0];
    expect(call.id).toBe("abs-1");
    expect(call.themeIds).toEqual([themeId]);
    expect(call.registrationId).toBe(eventId);
  });

  it("DB duplicate-email race during edit → 409 ABS_18010", async () => {
    const { editToken } = setup();
    mock(editAbstractTxn).mockResolvedValue({ ok: false, reason: "duplicate_email" });
    await expectAppError(
      service.editAbstract("abs-1", editToken, makeSubmitBody()),
      409,
      "ABS_18010",
    );
  });

  it("rejects when editing is disabled (409 ABS_18006)", async () => {
    const { editToken } = setup({}, { editingEnabled: false });
    await expectAppError(
      service.editAbstract("abs-1", editToken, makeSubmitBody()),
      409,
      "ABS_18006",
    );
  });

  it("rejects when the editing deadline has passed (409 ABS_18007)", async () => {
    const { editToken } = setup({}, { editingDeadline: new Date("2020-01-01") });
    await expectAppError(
      service.editAbstract("abs-1", editToken, makeSubmitBody()),
      409,
      "ABS_18007",
    );
  });

  it("rejects ACCEPTED / REJECTED abstracts (409 ABS_18008)", async () => {
    for (const status of ["ACCEPTED", "REJECTED"]) {
      const { editToken } = setup({ status });
      await expectAppError(
        service.editAbstract("abs-1", editToken, makeSubmitBody()),
        409,
        "ABS_18008",
      );
    }
  });
});
