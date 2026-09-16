import { describe, expect, it } from "vitest";
import {
  BulkSendEmailSchema,
  CreateEmailTemplateSchema,
  UpdateEmailTemplateSchema,
} from "./email.schema.js";

const tiptapDocument = {
  type: "doc" as const,
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello" }],
    },
  ],
};

describe("Email template schemas", () => {
  it("accepts automatic abstract template create payloads", () => {
    const result = CreateEmailTemplateSchema.safeParse({
      eventId: "11111111-1111-4111-8111-111111111111",
      name: "Abstract Decision",
      subject: "Abstract Decision",
      content: tiptapDocument,
      category: "AUTOMATIC",
      trigger: null,
      abstractTrigger: "ABSTRACT_DECISION",
      isActive: true,
    });

    expect(result.success).toBe(true);
  });

  it("rejects automatic create payloads without a trigger", () => {
    const result = CreateEmailTemplateSchema.safeParse({
      eventId: "11111111-1111-4111-8111-111111111111",
      name: "Broken Automatic",
      subject: "Broken Automatic",
      content: tiptapDocument,
      category: "AUTOMATIC",
      trigger: null,
      abstractTrigger: null,
      isActive: true,
    });

    expect(result.success).toBe(false);
  });

  it("rejects automatic create payloads with both trigger types", () => {
    const result = CreateEmailTemplateSchema.safeParse({
      eventId: "11111111-1111-4111-8111-111111111111",
      name: "Ambiguous Automatic",
      subject: "Ambiguous Automatic",
      content: tiptapDocument,
      category: "AUTOMATIC",
      trigger: "REGISTRATION_CREATED",
      abstractTrigger: "ABSTRACT_DECISION",
      isActive: true,
    });

    expect(result.success).toBe(false);
  });

  it("rejects manual create payloads with abstract triggers", () => {
    const result = CreateEmailTemplateSchema.safeParse({
      eventId: "11111111-1111-4111-8111-111111111111",
      name: "Manual",
      subject: "Manual",
      content: tiptapDocument,
      category: "MANUAL",
      trigger: null,
      abstractTrigger: "ABSTRACT_DECISION",
      isActive: true,
    });

    expect(result.success).toBe(false);
  });

  it("accepts abstractTrigger on partial update payloads", () => {
    const result = UpdateEmailTemplateSchema.safeParse({
      trigger: null,
      abstractTrigger: "ABSTRACT_DECISION",
    });

    expect(result.success).toBe(true);
  });
});

describe("BulkSendEmailSchema", () => {
  const abstractId = "22222222-2222-4222-8222-222222222222";
  const themeId = "33333333-3333-4333-8333-333333333333";

  it("defaults to the registrant audience with dedupe enabled", () => {
    const result = BulkSendEmailSchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      audience: "registrants",
      dedupeByEmail: true,
    });
  });

  it("accepts the abstracts audience with filters", () => {
    const result = BulkSendEmailSchema.safeParse({
      audience: "abstracts",
      abstractFilters: {
        status: ["ACCEPTED", "PENDING"],
        themeId,
        presentationType: "POSTER",
      },
      dedupeByEmail: false,
    });

    expect(result.success).toBe(true);
    expect(result.data?.dedupeByEmail).toBe(false);
  });

  it("accepts the abstracts audience with explicit abstract ids", () => {
    const result = BulkSendEmailSchema.safeParse({
      audience: "abstracts",
      abstractIds: [abstractId],
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown abstract statuses", () => {
    const result = BulkSendEmailSchema.safeParse({
      audience: "abstracts",
      abstractFilters: { status: ["WITHDRAWN"] },
    });

    expect(result.success).toBe(false);
  });

  it("rejects CONFERENCE as a presentation type filter", () => {
    const result = BulkSendEmailSchema.safeParse({
      audience: "abstracts",
      abstractFilters: { presentationType: "CONFERENCE" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects abstract filters on a non-abstract audience", () => {
    const result = BulkSendEmailSchema.safeParse({
      audience: "registrants",
      abstractIds: [abstractId],
    });

    expect(result.success).toBe(false);
  });

  it("keeps registrant payloads valid", () => {
    const result = BulkSendEmailSchema.safeParse({
      audience: "registrants",
      registrationIds: [abstractId],
      filters: { paymentStatus: ["PAID"] },
    });

    expect(result.success).toBe(true);
  });
});
