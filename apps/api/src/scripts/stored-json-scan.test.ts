import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readStoredJsonbPage: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/db")>();
  return { ...actual, readStoredJsonbPage: mocks.readStoredJsonbPage };
});

import { formatStoredJsonReport, loadStoredJsonReport } from "./stored-json-scan";

const SECRET = "registrant-secret-value";
const zone = {
  id: "z1",
  x: 10,
  y: 20,
  width: 50,
  height: 10,
  variable: "fullName",
  fontSize: null,
  fontWeight: "bold",
  color: "#000000",
  textAlign: "center",
};
const { fontWeight: _fontWeight, ...zoneWithoutWeight } = zone;

/** Rows per column name; pages are served by keyset (ids after `afterId`). */
function serve(rows: Record<string, { id: string; value: unknown }[]>) {
  mocks.readStoredJsonbPage.mockImplementation(
    async (entry: { name: string }, afterId: string | undefined, limit: number) =>
      (rows[entry.name] ?? []).filter((row) => afterId === undefined || row.id > afterId).slice(0, limit),
  );
}

beforeEach(() => vi.clearAllMocks());

describe("loadStoredJsonReport", () => {
  it("scans every typed column page by page and counts invalid rows per issue code", async () => {
    serve({
      "event_pricing.rules": [
        { id: "p1", value: [] },
        { id: "p2", value: [{ name: SECRET }] },
      ],
      "certificate_templates.zones": [
        { id: "t1", value: [zone] },
        { id: "t2", value: [zoneWithoutWeight] },
        { id: "t3", value: [{ ...zone, legacyNote: SECRET }] },
      ],
      "forms.schema": [{ id: "f1", value: { fields: [] } }],
      "email_logs.context_snapshot": [
        { id: "e1", value: null },
        { id: "e2", value: { firstName: SECRET } },
        { id: "e3", value: [SECRET] },
      ],
    });

    const report = await loadStoredJsonReport({ batchSize: 2 });

    expect(report.columns.map((c) => [c.column, c.scanned, c.invalid, c.byCode])).toEqual([
      ["event_pricing.rules", 2, 1, { invalid_type: 1 }],
      ["certificate_templates.zones", 3, 2, { missing_default: 1, unrecognized_keys: 1 }],
      ["forms.schema", 1, 1, { invalid_type: 1 }],
      ["email_logs.context_snapshot", 3, 1, { invalid_type: 1 }],
    ]);
    // Keyset paging: 2 rows per page, the next page starts after the last id.
    expect(
      mocks.readStoredJsonbPage.mock.calls
        .filter(([entry]) => (entry as { name: string }).name === "certificate_templates.zones")
        .map(([, afterId, limit]) => [afterId, limit]),
    ).toEqual([
      [undefined, 2],
      ["t2", 2],
    ]);
    expect(report.columns[1]!.findings).toEqual([
      { column: "certificate_templates.zones", id: "t2", issues: [{ path: "[0].fontWeight", code: "missing_default" }] },
      { column: "certificate_templates.zones", id: "t3", issues: [{ path: "[0].legacyNote", code: "unrecognized_keys" }] },
    ]);

    const lines = formatStoredJsonReport(report);
    expect(lines).toContain("[certificate_templates.zones] id t2: [0].fontWeight (missing_default)");
    expect(lines).toContain(
      "certificate_templates.zones: scanned 3 row(s), 2 invalid (missing_default 1, unrecognized_keys 1)",
    );
    expect(lines.at(-1)).toBe(
      "5 stored document(s) do not match their schema: JSONB_VALIDATION=enforce would refuse them. Nothing was changed.",
    );
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("lists at most the first findings of a column but counts them all", async () => {
    serve({
      "forms.schema": ["f1", "f2", "f3"].map((id) => ({ id, value: null })),
    });

    const report = await loadStoredJsonReport({ findingsPerColumn: 1 });
    const forms = report.columns.find((c) => c.column === "forms.schema")!;

    expect(forms.invalid).toBe(3);
    expect(forms.findings.map((f) => f.id)).toEqual(["f1"]);
    expect(formatStoredJsonReport(report)).toContain("[forms.schema] ... 2 more invalid row(s) not listed");
  });

  it("says so when nothing would be refused", async () => {
    serve({});
    const lines = formatStoredJsonReport(await loadStoredJsonReport());
    expect(lines).toEqual([
      "event_pricing.rules: scanned 0 row(s), 0 invalid",
      "certificate_templates.zones: scanned 0 row(s), 0 invalid",
      "forms.schema: scanned 0 row(s), 0 invalid",
      "email_logs.context_snapshot: scanned 0 row(s), 0 invalid",
      "Every typed JSON document matches its schema: JSONB_VALIDATION=enforce would refuse nothing. Nothing was changed.",
    ]);
  });
});
