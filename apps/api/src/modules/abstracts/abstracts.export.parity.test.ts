import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminAbstractRow } from "@app/db";

// 3.7b output parity: the streamed abstracts export must read back exactly
// like the pre-3.7b in-memory workbook (verbatim in __testing__/) on the same
// abstracts. The db seam is faked: the plan (ids, reviewer-column count) and
// the rows in small pages; the real SQL is covered by
// report-export-reads.db.test.ts.

const PAGE = 2;

vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withExportStatementTimeout: vi.fn((fn: (tx: unknown) => unknown) => fn({ tx: true })),
  getAbstractsExportPlan: vi.fn(),
  iterateAbstractsForExport: vi.fn(),
}));

import * as db from "@app/db";
import { collect, readBack } from "../../core/exports/__testing__/export-output";
import { prepareAbstractsExport } from "./abstracts.export.service";
import { legacyExportAbstractsWorkbook } from "./__testing__/legacy-abstracts-export";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;

const EVENT_ID = "event-1";
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 0, day, hour, 30));
// 23:30 UTC on 31 Dec is 00:30 on 1 Jan in Tunis.
const LATE_UTC = new Date("2025-12-31T23:30:00Z");

let reviewSeq = 0;
function review(
  abstractId: string,
  score: number | null,
  reviewer: { name: string | null; email: string },
) {
  reviewSeq += 1;
  return {
    id: `review-${reviewSeq}`,
    abstractId,
    eventId: EVENT_ID,
    reviewerId: `reviewer-${reviewSeq}`,
    score,
    comment: null,
    scoredAt: score === null ? null : at(3),
    active: true,
    createdAt: at(2),
    updatedAt: at(2),
    reviewer: { id: `reviewer-${reviewSeq}`, ...reviewer },
  };
}

function abstract(n: number, values: Record<string, unknown> = {}): AdminAbstractRow {
  const id = `abs-${String(n).padStart(2, "0")}`;
  return {
    id,
    eventId: EVENT_ID,
    code: `OC-${String(n).padStart(2, "0")}`,
    codeNumber: n,
    content: { mode: "FREE_TEXT", title: `Résumé ${n}`, body: "Texte" },
    coAuthors: [],
    requestedType: "ORAL_COMMUNICATION",
    finalType: "ORAL_COMMUNICATION",
    status: "SUBMITTED",
    authorFirstName: `Prénom ${n}`,
    authorLastName: `Nom ${n}`,
    authorAffiliation: `Hôpital ${n}`,
    authorEmail: `a${n}@example.test`,
    authorPhone: `+216 20 000 0${n}`,
    presentedAt: null,
    createdAt: at(n),
    updatedAt: at(n),
    lastEditedAt: null,
    themes: [],
    reviews: [],
    ...values,
  } as unknown as AdminAbstractRow;
}

/** Export order (code, then newest first), as the plan returned it. */
const abstracts: AdminAbstractRow[] = [
  abstract(1, {
    content: { mode: "FREE_TEXT", title: "=SUM(A1:A2)", body: "Notes" },
    status: "ACCEPTED",
    presentedAt: LATE_UTC,
    themes: [
      { id: "t1", label: "Cardiologie", sortOrder: 1 },
      { id: "t2", label: "", sortOrder: 2 },
      { id: "t3", label: "Imagerie", sortOrder: 3 },
    ],
    coAuthors: [
      { firstName: "Leila", lastName: "Ben Salah", affiliation: "CHU Sahloul" },
      { firstName: "Omar", lastName: "Trabelsi" },
    ],
    reviews: [
      review("abs-01", 16, { name: "Reviewer One", email: "one@example.test" }),
      review("abs-01", 14, { name: "", email: "two@example.test" }),
      review("abs-01", 15, { name: null, email: "three@example.test" }),
    ],
  }),
  abstract(2, {
    requestedType: "POSTER",
    finalType: null,
    status: "UNDER_REVIEW",
    authorAffiliation: null,
    reviews: [
      review("abs-02", 12, { name: "Reviewer Four", email: "four@example.test" }),
      review("abs-02", null, { name: "Reviewer Five", email: "five@example.test" }),
    ],
  }),
  abstract(3, {
    content: { mode: "STRUCTURED", title: "   ", sections: [] },
    status: "REJECTED",
    lastEditedAt: LATE_UTC,
    reviews: [review("abs-03", 0, { name: "Reviewer Six", email: "six@example.test" })],
  }),
  abstract(4, { status: "PENDING", authorPhone: "" }),
  abstract(5, {
    code: null,
    content: null,
    status: "REVIEW_COMPLETE",
    reviews: [
      review("abs-05", 20, { name: "ورشة", email: "ar@example.test" }),
      review("abs-05", 7.5, { name: "Reviewer Seven", email: "seven@example.test" }),
    ],
  }),
];

function serve(rows: AdminAbstractRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  m.getAbstractsExportPlan!.mockResolvedValue({
    ids: rows.map((row) => row.id),
    maxReviews: rows.reduce((max, row) => Math.max(max, row.reviews.length), 0),
  });
  m.iterateAbstractsForExport!.mockImplementation(async function* (ids: readonly string[]) {
    for (let i = 0; i < ids.length; i += PAGE) {
      yield ids.slice(i, i + PAGE).map((id) => byId.get(id)!);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-02T10:15:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  ["with scored, unscored and missing reviews", abstracts],
  ["with no reviews at all", abstracts.map((row) => ({ ...row, reviews: [] }))],
  ["when no abstract matches", []],
])("abstracts export parity %s", (_label, rows) => {
  it("reads back like the in-memory workbook", async () => {
    serve(rows);
    const filters = { status: "ACCEPTED" as const };

    const download = await prepareAbstractsExport(EVENT_ID, filters, "congres-2026");
    const expected = await legacyExportAbstractsWorkbook(rows, "congres-2026");

    expect(download.filename).toBe(expected.filename);
    expect(m.getAbstractsExportPlan).toHaveBeenCalledWith(EVENT_ID, filters, { tx: true });
    expect(await readBack(await collect(download))).toEqual(await readBack(expected.data));
  });
});

describe("abstracts export reads", () => {
  it("reads the rows by the plan's ids, a page at a time, under the download's signal", async () => {
    serve(abstracts);
    const download = await prepareAbstractsExport(EVENT_ID, {}, "congres-2026");
    await collect(download);

    expect(m.iterateAbstractsForExport).toHaveBeenCalledTimes(1);
    const [ids, options] = m.iterateAbstractsForExport!.mock.calls[0] as [
      string[],
      { signal: AbortSignal },
    ];
    expect(ids).toEqual(abstracts.map((row) => row.id));
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the plan's reviewer columns when a review is added after it was read", async () => {
    serve(abstracts);
    const extra = {
      ...abstracts[1]!,
      reviews: [
        ...abstracts[1]!.reviews,
        review("abs-02", 9, { name: "Late Reviewer", email: "late@example.test" }),
        review("abs-02", 8, { name: "Later Reviewer", email: "later@example.test" }),
      ],
    };
    m.iterateAbstractsForExport!.mockImplementation(async function* () {
      yield [abstracts[0]!, extra];
    });

    const [sheet] = await readBack(
      await collect(await prepareAbstractsExport(EVENT_ID, {}, "congres-2026")),
    );
    const header = sheet!.rows[0] as { cells: Array<{ value: unknown }> };
    const second = sheet!.rows[2] as { cells: Array<{ value: unknown }> };
    // 17 base + 3 reviewer pairs + 3 dates, whatever row 3 now carries.
    expect(header.cells).toHaveLength(17 + 3 * 2 + 3);
    expect(second.cells).toHaveLength(17 + 3 * 2 + 3);
    expect(second.cells.map((cell) => cell.value)).not.toContain("Later Reviewer");
  });
});
