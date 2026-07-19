import { describe, expect, it } from "vitest";
import {
  CreateEmailTemplateSchema,
  CreateEmailTemplateBodySchema,
  UpdateEmailTemplateSchema,
} from "./email";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const content = { type: "doc" as const, content: [] };
const base = {
  eventId,
  name: "Welcome",
  subject: "Hello",
  content,
};

describe("CreateEmailTemplateSchema trigger XOR refine", () => {
  it("accepts an automatic template with an abstractTrigger (and no trigger)", () => {
    const parsed = CreateEmailTemplateSchema.safeParse({
      ...base,
      category: "AUTOMATIC",
      abstractTrigger: "ABSTRACT_SUBMISSION_ACK",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an automatic template with a (registration) trigger", () => {
    const parsed = CreateEmailTemplateSchema.safeParse({
      ...base,
      category: "AUTOMATIC",
      trigger: "REGISTRATION_CREATED",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an automatic template with neither trigger set", () => {
    const parsed = CreateEmailTemplateSchema.safeParse({
      ...base,
      category: "AUTOMATIC",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an automatic template with BOTH triggers set", () => {
    const parsed = CreateEmailTemplateSchema.safeParse({
      ...base,
      category: "AUTOMATIC",
      trigger: "REGISTRATION_CREATED",
      abstractTrigger: "ABSTRACT_SUBMISSION_ACK",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a MANUAL template that includes an abstractTrigger", () => {
    const parsed = CreateEmailTemplateSchema.safeParse({
      ...base,
      category: "MANUAL",
      abstractTrigger: "ABSTRACT_SUBMISSION_ACK",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a MANUAL template with no triggers", () => {
    const parsed = CreateEmailTemplateSchema.safeParse({
      ...base,
      category: "MANUAL",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("CreateEmailTemplateBodySchema", () => {
  it("rejects an eventId in the body (strict object)", () => {
    const parsed = CreateEmailTemplateBodySchema.safeParse({
      eventId,
      name: "x",
      subject: "y",
      content,
      category: "MANUAL",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a body without eventId and enforces the XOR refine", () => {
    const ok = CreateEmailTemplateBodySchema.safeParse({
      name: "x",
      subject: "y",
      content,
      category: "MANUAL",
    });
    expect(ok.success).toBe(true);

    const bad = CreateEmailTemplateBodySchema.safeParse({
      name: "x",
      subject: "y",
      content,
      category: "AUTOMATIC",
    });
    expect(bad.success).toBe(false);
  });
});

describe("UpdateEmailTemplateSchema", () => {
  it("accepts a partial update containing only abstractTrigger (no XOR at the update layer)", () => {
    const parsed = UpdateEmailTemplateSchema.safeParse({
      abstractTrigger: "ABSTRACT_SUBMISSION_ACK",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty update (at least one field required)", () => {
    const parsed = UpdateEmailTemplateSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("treats an explicit null description as a provided field", () => {
    const parsed = UpdateEmailTemplateSchema.safeParse({ description: null });
    expect(parsed.success).toBe(true);
  });

  // M11: optimistic-concurrency precondition.
  describe("expectedUpdatedAt", () => {
    it("accepts an update alongside a valid ISO datetime", () => {
      const parsed = UpdateEmailTemplateSchema.safeParse({
        name: "New",
        expectedUpdatedAt: "2026-07-19T00:00:00.000Z",
      });
      expect(parsed.success).toBe(true);
    });

    it("is optional — omitting it stays backward compatible", () => {
      const parsed = UpdateEmailTemplateSchema.safeParse({ name: "New" });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.expectedUpdatedAt).toBeUndefined();
    });

    it("rejects a non-ISO-datetime value", () => {
      const parsed = UpdateEmailTemplateSchema.safeParse({
        name: "New",
        expectedUpdatedAt: "not-a-date",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects a body containing only the precondition (nothing to update)", () => {
      const parsed = UpdateEmailTemplateSchema.safeParse({
        expectedUpdatedAt: "2026-07-19T00:00:00.000Z",
      });
      expect(parsed.success).toBe(false);
    });
  });
});
