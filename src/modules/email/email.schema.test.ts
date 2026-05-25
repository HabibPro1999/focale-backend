import { describe, expect, it } from "vitest";
import {
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
