import { describe, it, expect } from "vitest";
import { CreateEventSchema, UpdateEventSchema } from "./events.schema.js";

describe("Events Schema — slug normalization (Fix 3)", () => {
  const baseValidInput = {
    clientId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    name: "Test Event",
    startDate: new Date("2025-06-01"),
    endDate: new Date("2025-06-03"),
    basePrice: 0,
    currency: "TND",
    status: "CLOSED" as const,
  };

  describe("CreateEventSchema", () => {
    it("should lowercase an uppercase slug", () => {
      const result = CreateEventSchema.safeParse({
        ...baseValidInput,
        slug: "My-Event-2025",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slug).toBe("my-event-2025");
      }
    });

    it("should trim whitespace from slug", () => {
      const result = CreateEventSchema.safeParse({
        ...baseValidInput,
        slug: "  my-event  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slug).toBe("my-event");
      }
    });

    it("should lowercase and trim combined", () => {
      const result = CreateEventSchema.safeParse({
        ...baseValidInput,
        slug: "  Medical-Conference-2025  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slug).toBe("medical-conference-2025");
      }
    });

    it("should pass through an already valid lowercase slug unchanged", () => {
      const result = CreateEventSchema.safeParse({
        ...baseValidInput,
        slug: "already-lowercase",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slug).toBe("already-lowercase");
      }
    });

    it("should still reject a slug with invalid characters after normalization", () => {
      const result = CreateEventSchema.safeParse({
        ...baseValidInput,
        slug: "invalid slug with spaces",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("UpdateEventSchema", () => {
    it("should lowercase slug on update", () => {
      const result = UpdateEventSchema.safeParse({
        slug: "UPPER-CASE-SLUG",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slug).toBe("upper-case-slug");
      }
    });

    it("should trim slug on update", () => {
      const result = UpdateEventSchema.safeParse({
        slug: "  trimmed-slug  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slug).toBe("trimmed-slug");
      }
    });

    it("should allow update without slug (optional field)", () => {
      const result = UpdateEventSchema.safeParse({ name: "New Name" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.slug).toBeUndefined();
      }
    });
  });
});
