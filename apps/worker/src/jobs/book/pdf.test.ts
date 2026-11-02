import { describe, expect, it } from "vitest";
import { getAdditionalFieldLines } from "./pdf";

// H9 regression: additionalFieldsData (e.g. keywords) never made it into the
// printed abstract book. getAdditionalFieldLines is the pure renderer-side
// core — schema + data in, labelled lines out — unit-testable without
// rendering a PDF.

describe("getAdditionalFieldLines (H9)", () => {
  const checkboxField = {
    id: "keywords",
    type: "checkbox",
    label: "Keywords",
    options: [
      { id: "kw_ai", label: "AI" },
      { id: "kw_bio", label: "Biology" },
    ],
  };
  const booleanField = { id: "consent", type: "text", label: "Consent given" };
  const textField = { id: "notes", type: "text", label: "Notes" };

  it("joins a multi-select (checkbox) field's option ids into labels", () => {
    const lines = getAdditionalFieldLines(
      [checkboxField],
      { keywords: ["kw_ai", "kw_bio"] },
    );
    expect(lines).toEqual([{ label: "Keywords", text: "AI, Biology" }]);
  });

  it("formats a boolean value as Yes/No", () => {
    const lines = getAdditionalFieldLines([booleanField], { consent: true });
    expect(lines).toEqual([{ label: "Consent given", text: "Yes" }]);
    expect(
      getAdditionalFieldLines([booleanField], { consent: false }),
    ).toEqual([{ label: "Consent given", text: "No" }]);
  });

  it("skips a field with no answer in the data", () => {
    const lines = getAdditionalFieldLines([textField], {});
    expect(lines).toEqual([]);
  });

  it("skips empty-string and empty-array answers", () => {
    expect(getAdditionalFieldLines([textField], { notes: "   " })).toEqual([]);
    expect(getAdditionalFieldLines([checkboxField], { keywords: [] })).toEqual(
      [],
    );
  });

  it("skips a data key that has no matching field in the current schema (unknown/orphaned id)", () => {
    const lines = getAdditionalFieldLines([textField], {
      notes: "kept",
      stale_field_from_old_schema: "should never print",
    });
    expect(lines).toEqual([{ label: "Notes", text: "kept" }]);
  });

  it("escapes/strips HTML the same way content text is neutralised", () => {
    const lines = getAdditionalFieldLines([textField], {
      notes: "<script>alert(1)</script>Sneaky &amp; bold",
    });
    expect(lines).toEqual([{ label: "Notes", text: "alert(1) Sneaky & bold" }]);
  });

  it("falls back to the field id when no label is configured", () => {
    const lines = getAdditionalFieldLines(
      [{ id: "raw_field", type: "text" }],
      { raw_field: "value" },
    );
    expect(lines).toEqual([{ label: "raw_field", text: "value" }]);
  });

  it("preserves schema field order in the output", () => {
    const lines = getAdditionalFieldLines(
      [textField, checkboxField],
      { keywords: ["kw_ai"], notes: "hi" },
    );
    expect(lines.map((l) => l.label)).toEqual(["Notes", "Keywords"]);
  });

  it("skips display-only (heading/paragraph) and file fields even if data holds a value", () => {
    const lines = getAdditionalFieldLines(
      [
        { id: "h1", type: "heading", label: "Section" },
        { id: "p1", type: "paragraph", label: "Blurb" },
        { id: "f1", type: "file", label: "Attachment" },
      ],
      { h1: "x", p1: "y", f1: "some-upload-id" },
    );
    expect(lines).toEqual([]);
  });

  it("resolves dropdown/radio option ids to their labels", () => {
    const lines = getAdditionalFieldLines(
      [
        {
          id: "country",
          type: "dropdown",
          label: "Country",
          options: [{ id: "tn", label: "Tunisia" }],
        },
      ],
      { country: "tn" },
    );
    expect(lines).toEqual([{ label: "Country", text: "Tunisia" }]);
  });

  it("returns [] when schema is not an array or data is not an object", () => {
    expect(getAdditionalFieldLines(null, { notes: "x" })).toEqual([]);
    expect(getAdditionalFieldLines([textField], null)).toEqual([]);
    expect(getAdditionalFieldLines([textField], "not-an-object")).toEqual([]);
  });
});
