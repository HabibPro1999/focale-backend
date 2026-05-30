/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { faker } from "@faker-js/faker";
import { Prisma } from "@/generated/prisma/client.js";
import { countWords } from "./abstracts.service.js";
import { abstractHtmlToText, sanitizeAbstractHtml } from "./abstracts.html.js";
import {
  verifyAbstractToken,
  generateAbstractToken,
} from "./abstract-token.js";

// Mock audit
vi.mock("@shared/utils/audit.js", () => ({
  auditLog: vi.fn(),
}));

// Mock module gate
vi.mock("@clients", () => ({
  assertClientModuleEnabled: vi.fn(),
}));

import {
  getPublicConfig,
  getAbstractByToken,
  submitAbstract,
  editAbstract,
} from "./abstracts.service.js";

// ============================================================================
// Factories
// ============================================================================

const clientId = faker.string.uuid();
const eventId = faker.string.uuid();
const configId = faker.string.uuid();
const slug = "test-congress";

function makeEvent(overrides = {}) {
  return {
    id: eventId,
    name: "Test Congress",
    slug,
    clientId,
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: configId,
    eventId,
    submissionMode: "FREE_TEXT" as const,
    globalWordLimit: 500,
    sectionWordLimits: null,
    submissionDeadline: null,
    editingDeadline: null,
    scoringDeadline: null,
    finalFileDeadline: null,
    editingEnabled: true,
    commentsEnabled: false,
    commentsSentToAuthor: false,
    finalFileUploadEnabled: false,
    reviewersPerAbstract: 2,
    divergenceThreshold: 6,
    distributeByTheme: false,
    modeLocked: false,
    bookFontFamily: "Arial",
    bookFontSize: 11,
    bookLineSpacing: 1.5,
    bookOrder: "BY_CODE" as const,
    bookIncludeAuthorNames: true,
    additionalFieldsSchema: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSubmitBody(overrides: Record<string, unknown> = {}) {
  return {
    authorFirstName: "Ahmed",
    authorLastName: "Salah",
    authorAffiliation: "CHU Tunis",
    authorEmail: "ahmed@example.com",
    authorPhone: "+21612345678",
    coAuthors: [],
    requestedType: "ORAL_COMMUNICATION" as const,
    themeIds: [faker.string.uuid()],
    content: {
      mode: "FREE_TEXT" as const,
      title: "My Abstract",
      body: "Some body text",
    },
    additionalFieldsData: {},
    registrationId: null as string | null,
    linkBaseUrl: "https://events.example.com",
    ...overrides,
  };
}

function makeAbstract(overrides: Record<string, unknown> = {}) {
  return {
    id: faker.string.uuid(),
    eventId,
    authorFirstName: "Ahmed",
    authorLastName: "Salah",
    authorAffiliation: "CHU Tunis",
    authorEmail: "ahmed@example.com",
    authorPhone: "+21612345678",
    requestedType: "ORAL_COMMUNICATION" as const,
    content: { mode: "FREE_TEXT", title: "My Abstract", body: "text" },
    coAuthors: [],
    additionalFieldsData: {},
    code: null,
    codeNumber: null,
    status: "SUBMITTED" as const,
    contentVersion: 1,
    finalType: null,
    averageScore: null,
    reviewCount: 0,
    finalFileKey: null,
    finalFileKind: null,
    finalFileSize: null,
    finalFileUploadedAt: null,
    editToken: generateAbstractToken(),
    lastEditedAt: null,
    linkBaseUrl: "https://events.example.com",
    registrationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function prismaUniqueError(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.2.0",
    meta,
  });
}

// ============================================================================
// Word counter tests
// ============================================================================

describe("countWords", () => {
  it("returns 0 for empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("returns 0 for whitespace-only", () => {
    expect(countWords("   \n\t  ")).toBe(0);
  });

  it("counts normal text", () => {
    expect(countWords("Hello world foo bar")).toBe(4);
  });

  it("handles consecutive whitespace", () => {
    expect(countWords("Hello   world   foo")).toBe(3);
  });

  it("handles unicode whitespace (non-breaking space)", () => {
    expect(countWords("Hello\u00A0world")).toBe(2);
  });

  it("handles long single word", () => {
    expect(countWords("superlongword")).toBe(1);
  });
});

describe("abstract rich-text helpers", () => {
  it("keeps only the supported formatting tags", () => {
    expect(
      sanitizeAbstractHtml(
        '<p class="x">Safe <b>bold</b> <i>italic</i> <u>under</u><script>alert(1)</script><span>plain</span></p>',
      ),
    ).toBe("<p>Safe <strong>bold</strong> <em>italic</em> <u>under</u>alert(1)plain</p>");
  });

  it("extracts visible text for counting and exports", () => {
    expect(abstractHtmlToText("<p>One <strong>two</strong></p><ul><li>three</li></ul>")).toBe(
      "One two\n\nthree",
    );
  });

  it("does not glue adjacent formatted words together when counting", () => {
    expect(abstractHtmlToText("<strong>one</strong><strong>two</strong>")).toBe("one two");
  });

  it("keeps inequalities and angle brackets in plain prose intact", () => {
    expect(abstractHtmlToText("p < 0.05 and n > 30")).toBe("p < 0.05 and n > 30");
    expect(sanitizeAbstractHtml("effect when x < 5 and y > 10")).toBe(
      "effect when x &lt; 5 and y &gt; 10",
    );
  });

  it("drops out-of-range and control-char numeric entities instead of crashing", () => {
    expect(() => sanitizeAbstractHtml("<p>&#x110000;&#0;ok</p>")).not.toThrow();
    expect(sanitizeAbstractHtml("<p>&#x110000;&#0;ok</p>")).toBe("<p>ok</p>");
  });
});

// ============================================================================
// Token tests
// ============================================================================

describe("verifyAbstractToken", () => {
  it("returns true for matching tokens", () => {
    const token = generateAbstractToken();
    expect(verifyAbstractToken(token, token)).toBe(true);
  });

  it("returns false for mismatching tokens", () => {
    const stored = generateAbstractToken();
    const provided = generateAbstractToken();
    expect(verifyAbstractToken(stored, provided)).toBe(false);
  });

  it("returns false for length mismatch", () => {
    const stored = generateAbstractToken();
    expect(verifyAbstractToken(stored, "short")).toBe(false);
  });

  it("is timing-safe (does not throw on different lengths)", () => {
    const stored = generateAbstractToken();
    expect(() => verifyAbstractToken(stored, "")).not.toThrow();
    expect(verifyAbstractToken(stored, "")).toBe(false);
  });
});

// ============================================================================
// getPublicConfig
// ============================================================================

describe("getPublicConfig", () => {
  it("returns enabled=false when no config exists", async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      id: eventId,
      name: "Test",
      clientId,
      abstractConfig: null,
    } as any);

    const result = await getPublicConfig(slug);
    expect(result.enabled).toBe(false);
  });

  it("returns config with active themes", async () => {
    const themes = [{ id: faker.string.uuid(), label: "Theme A" }];
    prismaMock.event.findUnique.mockResolvedValue({
      id: eventId,
      name: "Test Congress",
      clientId,
      abstractConfig: {
        ...makeConfig(),
        themes,
      },
    } as any);

    const result = await getPublicConfig(slug);
    expect(result.enabled).toBe(true);
    expect(result).toHaveProperty("themes", themes);
    expect(result).toHaveProperty("submissionMode", "FREE_TEXT");
  });

  it("keeps public submissions open when mode is locked", async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      id: eventId,
      name: "Test Congress",
      clientId,
      abstractConfig: {
        ...makeConfig({ modeLocked: true }),
        themes: [],
      },
    } as any);

    const result = await getPublicConfig(slug);

    expect(result.enabled).toBe(true);
    expect(result.acceptingSubmissions).toBe(true);
  });
});

// ============================================================================
// submitAbstract
// ============================================================================

describe("submitAbstract", () => {
  const themeId = faker.string.uuid();

  function mockSubmitSetup(configOverrides: Record<string, unknown> = {}) {
    prismaMock.event.findUnique.mockResolvedValue({
      ...makeEvent(),
      abstractConfig: {
        ...makeConfig(configOverrides),
      },
    } as any);

    prismaMock.abstractTheme.findMany.mockResolvedValue([
      {
        id: themeId,
        configId,
        label: "Theme A",
        sortOrder: 0,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    const abstract = makeAbstract();
    const abstractCreate = vi.fn().mockResolvedValue(abstract);
    const revisionCreate = vi.fn();
    // Mock transaction
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      const txClient = {
        abstract: { create: abstractCreate },
        abstractRevision: { create: revisionCreate },
        abstractThemeOnAbstract: { createMany: vi.fn() },
        auditLog: { create: vi.fn() },
      };
      return fn(txClient);
    });

    return { abstract, abstractCreate, revisionCreate };
  }

  it("happy path: creates abstract and returns correct response", async () => {
    const { abstract, abstractCreate, revisionCreate } = mockSubmitSetup();
    const body = makeSubmitBody({
      themeIds: [themeId],
      registrationId: faker.string.uuid(),
      coAuthors: [{ firstName: "Co", lastName: "Author", affiliation: "Lab" }],
      additionalFieldsData: { institution: "Hospital" },
    });

    const result = await submitAbstract(slug, body, "203.0.113.10");

    expect(result.id).toBe(abstract.id);
    expect(result.status).toBe("SUBMITTED");
    expect(result.token).toHaveLength(64);
    expect(result.statusUrl).toContain(`/abstracts/${abstract.id}/`);
    expect(abstractCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorAffiliation: body.authorAffiliation,
      }),
    });
    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        abstractId: abstract.id,
        revisionNo: 1,
        editedBy: "PUBLIC",
        editedIpAddress: "203.0.113.10",
        snapshot: expect.objectContaining({
          authorFirstName: body.authorFirstName,
          authorLastName: body.authorLastName,
          authorAffiliation: body.authorAffiliation,
          authorEmail: body.authorEmail,
          authorPhone: body.authorPhone,
          coAuthors: body.coAuthors,
          content: body.content,
          additionalFieldsData: {},
          requestedType: body.requestedType,
          themeIds: [themeId],
          registrationId: body.registrationId,
        }),
      }),
    });
    expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "email.abstract",
          dedupeKey: `email:abstract:ABSTRACT_SUBMISSION_ACK:${abstract.id}`,
          payload: {
            trigger: "ABSTRACT_SUBMISSION_ACK",
            abstractId: abstract.id,
          },
        }),
      }),
    );
  });

  it("maps DB duplicate author-email races to the existing conflict", async () => {
    mockSubmitSetup();
    prismaMock.$transaction.mockRejectedValueOnce(
      prismaUniqueError({
        target: ["event_id", "author_email_normalized"],
      }) as never,
    );
    const body = makeSubmitBody({ themeIds: [themeId] });

    await expect(submitAbstract(slug, body)).rejects.toMatchObject({
      statusCode: 409,
      code: "ABS_18010",
      message:
        "An abstract has already been submitted for this first-author email",
    });
    expect(prismaMock.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("rejects when submission deadline has passed", async () => {
    mockSubmitSetup({ submissionDeadline: new Date("2020-01-01") });
    const body = makeSubmitBody({ themeIds: [themeId] });

    await expect(submitAbstract(slug, body)).rejects.toMatchObject({
      statusCode: 409,
      code: "ABS_18001",
    });
  });

  it("rejects when content mode mismatches config", async () => {
    mockSubmitSetup({ submissionMode: "STRUCTURED" });
    const body = makeSubmitBody({
      themeIds: [themeId],
      content: { mode: "FREE_TEXT", title: "T", body: "B" },
    });

    await expect(submitAbstract(slug, body)).rejects.toMatchObject({
      statusCode: 409,
      code: "ABS_18002",
    });
  });

  it("rejects invalid theme IDs (422)", async () => {
    mockSubmitSetup();
    // Override theme lookup to return empty
    prismaMock.abstractTheme.findMany.mockResolvedValue([]);
    const invalidThemeId = faker.string.uuid();
    const body = makeSubmitBody({ themeIds: [invalidThemeId] });

    await expect(submitAbstract(slug, body)).rejects.toMatchObject({
      statusCode: 422,
      code: "ABS_18004",
    });
  });

  it("rejects when mandatory additional field is missing (422)", async () => {
    mockSubmitSetup({
      additionalFieldsSchema: [
        {
          id: "institution",
          type: "text",
          label: "Institution",
          required: true,
        },
      ],
    });
    const body = makeSubmitBody({
      themeIds: [themeId],
      additionalFieldsData: {},
    });

    await expect(submitAbstract(slug, body)).rejects.toMatchObject({
      statusCode: 422,
      code: "ABS_18005",
    });
  });

  it("rejects when word limit is exceeded (422)", async () => {
    mockSubmitSetup({ globalWordLimit: 5 });
    const body = makeSubmitBody({
      themeIds: [themeId],
      content: {
        mode: "FREE_TEXT",
        title: "Title",
        body: "one two three four five six seven eight",
      },
    });

    await expect(submitAbstract(slug, body)).rejects.toMatchObject({
      statusCode: 422,
      code: "ABS_18003",
    });
  });

  it("sanitizes rich abstract HTML before persisting it", async () => {
    const { abstractCreate, revisionCreate } = mockSubmitSetup();
    const body = makeSubmitBody({
      themeIds: [themeId],
      content: {
        mode: "FREE_TEXT",
        title: "Title",
        body: '<p>Hello <strong>world</strong><img src=x onerror=alert(1)> <span style="color:red">plain</span></p>',
      },
    });

    await submitAbstract(slug, body);

    const expectedContent = {
      mode: "FREE_TEXT",
      title: "Title",
      body: "<p>Hello <strong>world</strong> plain</p>",
    };
    expect(abstractCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expectedContent,
      }),
    });
    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        snapshot: expect.objectContaining({
          content: expectedContent,
        }),
      }),
    });
  });

  it("counts rich abstract HTML by visible text for word limits", async () => {
    const { abstract } = mockSubmitSetup({ globalWordLimit: 2 });
    const body = makeSubmitBody({
      themeIds: [themeId],
      content: {
        mode: "FREE_TEXT",
        title: "Title",
        body: "<p>one <strong>two</strong></p>",
      },
    });

    const result = await submitAbstract(slug, body);

    expect(result.id).toBe(abstract.id);
  });

  it("enforces a configured zero word limit", async () => {
    mockSubmitSetup({ globalWordLimit: 0 });
    const body = makeSubmitBody({
      themeIds: [themeId],
      content: {
        mode: "FREE_TEXT",
        title: "Title",
        body: "one",
      },
    });

    await expect(submitAbstract(slug, body)).rejects.toMatchObject({
      statusCode: 422,
      code: "ABS_18003",
    });
  });
});

// ============================================================================
// editAbstract
// ============================================================================

describe("getAbstractByToken", () => {
  it("reports editing as locked after a final decision", async () => {
    const token = generateAbstractToken();
    prismaMock.abstract.findUnique.mockResolvedValue(
      makeAbstract({
        editToken: token,
        status: "ACCEPTED",
        themes: [{ theme: { id: faker.string.uuid(), label: "Theme A" } }],
        event: {
          abstractConfig: {
            editingEnabled: true,
            editingDeadline: null,
            finalFileUploadEnabled: false,
            finalFileDeadline: null,
          },
        },
      }) as any,
    );

    const result = await getAbstractByToken(faker.string.uuid(), token);

    expect(result.editing.allowed).toBe(false);
  });
});

describe("editAbstract", () => {
  const themeId = faker.string.uuid();

  function mockEditSetup(
    abstractOverrides: Record<string, unknown> = {},
    configOverrides: Record<string, unknown> = {},
  ) {
    const editToken = generateAbstractToken();
    const abstract = makeAbstract({
      editToken,
      event: {
        ...makeEvent(),
        abstractConfig: {
          ...makeConfig(configOverrides),
        },
      },
      ...abstractOverrides,
    });

    prismaMock.abstract.findUnique.mockResolvedValue(abstract as any);

    prismaMock.abstractTheme.findMany.mockResolvedValue([
      {
        id: themeId,
        configId,
        label: "Theme A",
        sortOrder: 0,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    const revisionCreate = vi.fn();
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      const txClient = {
        abstractRevision: {
          findFirst: vi.fn().mockResolvedValue({ revisionNo: 1 }),
          create: revisionCreate,
        },
        abstract: {
          update: vi.fn().mockResolvedValue({
            ...abstract,
            contentVersion: 2,
            lastEditedAt: new Date(),
          }),
        },
        abstractThemeOnAbstract: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        auditLog: { create: vi.fn() },
      };
      return fn(txClient);
    });

    // Mock the getAbstractByToken call after edit
    prismaMock.abstract.findUnique
      .mockResolvedValueOnce(abstract as any) // First call: edit lookup
      .mockResolvedValueOnce({
        ...abstract,
        contentVersion: 2,
        lastEditedAt: new Date(),
        themes: [{ theme: { id: themeId, label: "Theme A" } }],
        event: {
          abstractConfig: {
            editingEnabled: true,
            editingDeadline: null,
            finalFileUploadEnabled: false,
            finalFileDeadline: null,
          },
        },
      } as any);

    return { abstract, editToken, revisionCreate };
  }

  it("happy path: edits and increments revision", async () => {
    const { abstract, editToken, revisionCreate } = mockEditSetup();
    const body = makeSubmitBody({
      themeIds: [themeId],
      registrationId: faker.string.uuid(),
      coAuthors: [{ firstName: "Edited", lastName: "Co" }],
      additionalFieldsData: { institution: "Edited Hospital" },
    });

    const result = await editAbstract(
      abstract.id,
      editToken,
      body,
      "203.0.113.11",
    );

    expect(result.id).toBe(abstract.id);
    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        abstractId: abstract.id,
        revisionNo: 2,
        editedBy: "PUBLIC",
        editedIpAddress: "203.0.113.11",
        snapshot: expect.objectContaining({
          authorFirstName: body.authorFirstName,
          authorLastName: body.authorLastName,
          authorAffiliation: body.authorAffiliation,
          authorEmail: body.authorEmail,
          authorPhone: body.authorPhone,
          coAuthors: body.coAuthors,
          content: body.content,
          additionalFieldsData: {},
          requestedType: body.requestedType,
          themeIds: [themeId],
          registrationId: body.registrationId,
        }),
      }),
    });
    expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "email.abstract",
          dedupeKey: `email:abstract:ABSTRACT_EDIT_ACK:${abstract.id}:2`,
          payload: {
            trigger: "ABSTRACT_EDIT_ACK",
            abstractId: abstract.id,
          },
        }),
      }),
    );
  });

  it("maps DB duplicate author-email races during edit to the existing conflict", async () => {
    const { abstract, editToken } = mockEditSetup();
    prismaMock.$transaction.mockRejectedValueOnce(
      prismaUniqueError({
        target: "abstracts_event_id_author_email_normalized_key",
      }) as never,
    );
    const body = makeSubmitBody({ themeIds: [themeId] });

    await expect(
      editAbstract(abstract.id, editToken, body),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ABS_18010",
      message:
        "An abstract has already been submitted for this first-author email",
    });
    expect(prismaMock.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("rejects when editing is disabled (409)", async () => {
    const { abstract, editToken } = mockEditSetup(
      {},
      { editingEnabled: false },
    );
    const body = makeSubmitBody({ themeIds: [themeId] });

    await expect(
      editAbstract(abstract.id, editToken, body),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ABS_18006",
    });
  });

  it("rejects when editing deadline has passed (409)", async () => {
    const { abstract, editToken } = mockEditSetup(
      {},
      { editingDeadline: new Date("2020-01-01") },
    );
    const body = makeSubmitBody({ themeIds: [themeId] });

    await expect(
      editAbstract(abstract.id, editToken, body),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ABS_18007",
    });
  });

  it("rejects when status is ACCEPTED (409)", async () => {
    const { abstract, editToken } = mockEditSetup({ status: "ACCEPTED" });
    const body = makeSubmitBody({ themeIds: [themeId] });

    await expect(
      editAbstract(abstract.id, editToken, body),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ABS_18008",
    });
  });

  it("rejects when status is REJECTED (409)", async () => {
    const { abstract, editToken } = mockEditSetup({ status: "REJECTED" });
    const body = makeSubmitBody({ themeIds: [themeId] });

    await expect(
      editAbstract(abstract.id, editToken, body),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ABS_18008",
    });
  });
});
