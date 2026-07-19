import { describe, it, expect } from "vitest";
import {
  FinalizeAbstractSchema,
  ReviewAbstractSchema,
  AdditionalFieldsSchema,
} from "./abstracts";

// H1: CONFERENCE final type must be accepted end-to-end at finalize time,
// same as ORAL_COMMUNICATION/POSTER — the schema was the sole remaining
// blocker even though code prefixes, book sort order, and the finalize txn
// already supported it.
describe("FinalizeAbstractSchema finalType", () => {
  it("accepts CONFERENCE on the ACCEPTED branch", () => {
    expect(
      FinalizeAbstractSchema.safeParse({
        decision: "ACCEPTED",
        finalType: "CONFERENCE",
      }).success,
    ).toBe(true);
  });

  it("accepts CONFERENCE on the PENDING branch", () => {
    expect(
      FinalizeAbstractSchema.safeParse({
        decision: "PENDING",
        finalType: "CONFERENCE",
      }).success,
    ).toBe(true);
  });

  it("still accepts ORAL_COMMUNICATION and POSTER on the ACCEPTED branch", () => {
    expect(
      FinalizeAbstractSchema.safeParse({
        decision: "ACCEPTED",
        finalType: "ORAL_COMMUNICATION",
      }).success,
    ).toBe(true);
    expect(
      FinalizeAbstractSchema.safeParse({
        decision: "ACCEPTED",
        finalType: "POSTER",
      }).success,
    ).toBe(true);
  });

  it("rejects a bogus finalType", () => {
    expect(
      FinalizeAbstractSchema.safeParse({
        decision: "ACCEPTED",
        finalType: "KEYNOTE",
      }).success,
    ).toBe(false);
  });
});

// H3: review score scale is 0..25 (plan requirement), not 0..20.
describe("ReviewAbstractSchema score", () => {
  it("accepts 25", () => {
    expect(ReviewAbstractSchema.safeParse({ score: 25 }).success).toBe(true);
  });

  it("rejects 25.5 (above max)", () => {
    expect(ReviewAbstractSchema.safeParse({ score: 25.5 }).success).toBe(
      false,
    );
  });

  it("rejects 26 (above max)", () => {
    expect(ReviewAbstractSchema.safeParse({ score: 26 }).success).toBe(false);
  });

  it("rejects a negative score", () => {
    expect(ReviewAbstractSchema.safeParse({ score: -1 }).success).toBe(false);
  });

  it("accepts 0.5-increment scores within range", () => {
    expect(ReviewAbstractSchema.safeParse({ score: 22.5 }).success).toBe(
      true,
    );
  });
});

// H15: additive optional `force` flag lets the backend gate dropped field
// ids without breaking existing callers that never send it.
describe("AdditionalFieldsSchema force flag", () => {
  const field = { id: "f1", type: "text" as const };

  it("still accepts a request with no force field (backward compatible)", () => {
    expect(AdditionalFieldsSchema.safeParse({ fields: [field] }).success).toBe(
      true,
    );
  });

  it("accepts an explicit force=true", () => {
    expect(
      AdditionalFieldsSchema.safeParse({ fields: [field], force: true }).success,
    ).toBe(true);
  });

  it("rejects a non-boolean force value", () => {
    expect(
      AdditionalFieldsSchema.safeParse({ fields: [field], force: "yes" })
        .success,
    ).toBe(false);
  });
});
