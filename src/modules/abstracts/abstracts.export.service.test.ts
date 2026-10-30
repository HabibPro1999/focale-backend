import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { exportAbstractsWorkbook } from "./abstracts.export.service.js";

const eventId = "event-1";
const eventSlug = "my-event";

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-1",
    abstractId: "abs-1",
    eventId,
    reviewerId: "reviewer-1",
    score: null,
    comment: null,
    scoredAt: null,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    reviewer: { name: "Reviewer", email: "reviewer@example.com" },
    ...overrides,
  };
}

function makeAbstract(overrides: Record<string, unknown> = {}) {
  return {
    id: "abs-1",
    eventId,
    code: "OC1-01",
    codeNumber: 1,
    content: { mode: "FREE_TEXT", title: "Untitled abstract", body: "Notes" },
    coAuthors: [],
    requestedType: "ORAL_COMMUNICATION",
    finalType: "ORAL_COMMUNICATION",
    status: "ACCEPTED",
    authorFirstName: "Ada",
    authorLastName: "Lovelace",
    authorAffiliation: "Analytical Institute",
    authorEmail: "ada@example.com",
    authorPhone: "+21612345678",
    presentedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    lastEditedAt: null,
    themes: [{ theme: { label: "Cardiology" } }],
    reviews: [],
    ...overrides,
  };
}

async function loadWorkbook(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  const workbookData = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(workbookData);
  return workbook;
}

describe("exportAbstractsWorkbook", () => {
  it("builds a workbook with the expected header, dynamic reviewer columns, scored count, and formula escaping", async () => {
    const abstractA = makeAbstract({
      id: "abs-1",
      code: "OC1-01",
      content: { mode: "FREE_TEXT", title: '=SUM(A1:A2)', body: "Notes" },
      reviews: [
        makeReview({
          id: "review-1",
          score: 16,
          scoredAt: new Date("2026-01-03T00:00:00.000Z"),
          reviewer: { name: "Reviewer One", email: "one@example.com" },
        }),
        makeReview({
          id: "review-2",
          score: 14,
          scoredAt: new Date("2026-01-03T01:00:00.000Z"),
          reviewer: { name: "Reviewer Two", email: "two@example.com" },
        }),
        makeReview({
          id: "review-3",
          score: 15,
          scoredAt: new Date("2026-01-03T02:00:00.000Z"),
          reviewer: { name: "Reviewer Three", email: "three@example.com" },
        }),
      ],
    });

    const abstractB = makeAbstract({
      id: "abs-2",
      code: null,
      content: { mode: "FREE_TEXT", title: "Poster Title", body: "Notes" },
      requestedType: "POSTER",
      finalType: null,
      status: "UNDER_REVIEW",
      authorFirstName: "Grace",
      authorLastName: "Hopper",
      authorAffiliation: null,
      authorEmail: "grace@example.com",
      authorPhone: "+21698765432",
      coAuthors: [{ firstName: "John", lastName: "Doe", affiliation: "MIT" }],
      themes: [],
      reviews: [
        makeReview({
          id: "review-4",
          score: 12,
          scoredAt: new Date("2026-01-04T00:00:00.000Z"),
          reviewer: { name: "Reviewer Four", email: "four@example.com" },
        }),
        makeReview({
          id: "review-5",
          score: null,
          scoredAt: null,
          reviewer: { name: "Reviewer Five", email: "five@example.com" },
        }),
      ],
    });

    prismaMock.abstract.findMany.mockResolvedValue([
      abstractA,
      abstractB,
    ] as never);

    const result = await exportAbstractsWorkbook(eventId, {}, eventSlug);

    expect(result.filename).toMatch(/^my-event-resumes-\d{4}-\d{2}-\d{2}\.xlsx$/);

    const workbook = await loadWorkbook(result.data);
    const sheet = workbook.getWorksheet("Résumés")!;

    // Header row: 17 base columns + 3 dynamic Évaluateur/Note pairs (max reviews = 3) + 3 trailing columns.
    const headerValues = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(headerValues).toEqual([
      "Code",
      "Titre",
      "Type demandé",
      "Type final",
      "Statut",
      "Thèmes",
      "Auteur (nom)",
      "Auteur (prénom)",
      "Email",
      "Téléphone",
      "Affiliation",
      "Auteurs (tous)",
      "Note moyenne",
      "Nb évaluateurs",
      "Note min",
      "Note max",
      "Écart",
      "Évaluateur 1",
      "Note 1",
      "Évaluateur 2",
      "Note 2",
      "Évaluateur 3",
      "Note 3",
      "Présenté le",
      "Soumis le",
      "Modifié le (auteur)",
    ]);

    // Row 2 = abstract A (3 scored reviews) — title starting with "=" must be escaped.
    expect(sheet.getCell("B2").value).toBe("'=SUM(A1:A2)");
    expect(sheet.getCell("N2").value).toBe(3); // Nb évaluateurs

    // Row 3 = abstract B (1 of 2 reviews scored).
    expect(sheet.getCell("N3").value).toBe(1); // Nb évaluateurs
    expect(sheet.getCell("R3").value).toBe("Reviewer Four"); // Évaluateur 1
    expect(sheet.getCell("S3").value).toBe(12); // Note 1
    expect(sheet.getCell("T3").value).toBe("Reviewer Five"); // Évaluateur 2
    expect(sheet.getCell("U3").value).toBe(""); // Note 2 (unscored)
    expect(sheet.getCell("V3").value).toBe(""); // Évaluateur 3 (no third review)
  });

  it("falls back to the reviewer email when the reviewer has no name, and reports the author edit date", async () => {
    prismaMock.abstract.findMany.mockResolvedValue([
      makeAbstract({
        lastEditedAt: new Date("2026-01-05T00:00:00.000Z"),
        reviews: [
          makeReview({
            score: 11,
            scoredAt: new Date("2026-01-05T00:00:00.000Z"),
            reviewer: { name: null, email: "anon@example.com" },
          }),
        ],
      }),
    ] as never);

    const result = await exportAbstractsWorkbook(eventId, {}, eventSlug);
    const workbook = await loadWorkbook(result.data);
    const sheet = workbook.getWorksheet("Résumés")!;

    // 17 base + 1 reviewer pair => Évaluateur 1 is column R, and the three
    // trailing date columns are T/U/V.
    expect(sheet.getCell("R2").value).toBe("anon@example.com");
    expect(sheet.getCell("V2").value).toContain("05/01/2026");
  });

  it("returns an empty-body workbook (no dynamic reviewer columns) when no abstracts match", async () => {
    prismaMock.abstract.findMany.mockResolvedValue([] as never);

    const result = await exportAbstractsWorkbook(eventId, {}, eventSlug);
    const workbook = await loadWorkbook(result.data);
    const sheet = workbook.getWorksheet("Résumés")!;

    const headerValues = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(headerValues).toEqual([
      "Code",
      "Titre",
      "Type demandé",
      "Type final",
      "Statut",
      "Thèmes",
      "Auteur (nom)",
      "Auteur (prénom)",
      "Email",
      "Téléphone",
      "Affiliation",
      "Auteurs (tous)",
      "Note moyenne",
      "Nb évaluateurs",
      "Note min",
      "Note max",
      "Écart",
      "Présenté le",
      "Soumis le",
      "Modifié le (auteur)",
    ]);
    expect(sheet.rowCount).toBe(1);
  });
});
