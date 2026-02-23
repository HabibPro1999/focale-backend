import { describe, it, expect } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockClient,
  createMockEvent,
  createMockForm,
  createMockRegistration,
  createMockEventPricing,
  createMockEventAccess,
} from "../../../tests/helpers/factories.js";
import {
  BASE_VARIABLES,
  getAvailableVariables,
  buildEmailContext,
  buildEmailContextWithAccess,
  resolveVariables,
  resolveVariablesHtml,
  sanitizeForHtml,
  sanitizeUrl,
  getSampleEmailContext,
} from "./email-variable.service.js";
import type { EmailContext } from "./email.types.js";
import type { Prisma } from "@/generated/prisma/client.js";

// ============================================================================
// Test Data Types
// ============================================================================

type RegistrationWithRelations = Prisma.RegistrationGetPayload<{
  include: {
    event: {
      include: { client: true };
    };
    form: true;
  };
}>;

// ============================================================================
// Test Data Factories
// ============================================================================

function createRegistrationWithRelations(
  overrides: Partial<RegistrationWithRelations> = {},
): RegistrationWithRelations {
  const client = createMockClient();
  const event = createMockEvent({ clientId: client.id });
  const form = createMockForm({ eventId: event.id });
  const registration = createMockRegistration({
    eventId: event.id,
    formId: form.id,
  });

  const formData = registration.formData as Record<string, unknown> | null;
  return {
    ...registration,
    firstName: (formData?.firstName as string) || "John",
    lastName: (formData?.lastName as string) || "Doe",
    phone: (formData?.phone as string) || null,
    submittedAt: new Date(),
    accessTypeIds: [],
    currency: "TND",
    event: {
      ...event,
      client,
    },
    form,
    ...overrides,
  } as RegistrationWithRelations;
}

// ============================================================================
// Tests
// ============================================================================

describe("Email Variable Service", () => {
  describe("BASE_VARIABLES", () => {
    it("should contain registration variables", () => {
      const registrationVars = BASE_VARIABLES.filter(
        (v) => v.category === "registration",
      );
      expect(registrationVars.length).toBeGreaterThan(0);
      expect(registrationVars.some((v) => v.id === "firstName")).toBe(true);
      expect(registrationVars.some((v) => v.id === "lastName")).toBe(true);
      expect(registrationVars.some((v) => v.id === "email")).toBe(true);
    });

    it("should contain event variables", () => {
      const eventVars = BASE_VARIABLES.filter((v) => v.category === "event");
      expect(eventVars.length).toBeGreaterThan(0);
      expect(eventVars.some((v) => v.id === "eventName")).toBe(true);
      expect(eventVars.some((v) => v.id === "eventDate")).toBe(true);
    });

    it("should contain payment variables", () => {
      const paymentVars = BASE_VARIABLES.filter(
        (v) => v.category === "payment",
      );
      expect(paymentVars.length).toBeGreaterThan(0);
      expect(paymentVars.some((v) => v.id === "totalAmount")).toBe(true);
      expect(paymentVars.some((v) => v.id === "paymentStatus")).toBe(true);
    });

    it("should contain link variables", () => {
      const linkVars = BASE_VARIABLES.filter((v) => v.category === "links");
      expect(linkVars.length).toBeGreaterThan(0);
      expect(linkVars.some((v) => v.id === "registrationLink")).toBe(true);
    });

    it("should contain bank variables", () => {
      const bankVars = BASE_VARIABLES.filter((v) => v.category === "bank");
      expect(bankVars.length).toBeGreaterThan(0);
      expect(bankVars.some((v) => v.id === "bankName")).toBe(true);
      expect(bankVars.some((v) => v.id === "bankAccountNumber")).toBe(true);
    });

    it("should have example values for all variables", () => {
      BASE_VARIABLES.forEach((variable) => {
        expect(variable.example).toBeDefined();
        expect(typeof variable.example).toBe("string");
      });
    });
  });

  describe("getAvailableVariables", () => {
    const eventId = "event-123";

    it("should return base variables when no form exists", async () => {
      prismaMock.form.findFirst.mockResolvedValue(null);

      const result = await getAvailableVariables(eventId);

      expect(result.length).toBe(BASE_VARIABLES.length);
    });

    it("should include form field variables when form exists", async () => {
      const mockForm = createMockForm({
        eventId,
        schema: {
          steps: [
            {
              id: "step-1",
              title: "Details",
              fields: [
                { id: "specialty", type: "dropdown", label: "Specialty" },
                { id: "institution", type: "text", label: "Institution" },
              ],
            },
          ],
        },
      });

      prismaMock.form.findFirst.mockResolvedValue(mockForm);

      const result = await getAvailableVariables(eventId);

      expect(result.length).toBe(BASE_VARIABLES.length + 2);
      expect(result.some((v) => v.id === "form_specialty")).toBe(true);
      expect(result.some((v) => v.id === "form_institution")).toBe(true);
    });

    it("should skip non-data fields (heading, paragraph, divider)", async () => {
      const mockForm = createMockForm({
        eventId,
        schema: {
          steps: [
            {
              id: "step-1",
              title: "Info",
              fields: [
                { id: "heading-1", type: "heading", label: "Section Header" },
                { id: "paragraph-1", type: "paragraph", label: "Instructions" },
                { id: "divider-1", type: "divider" },
                { id: "name", type: "text", label: "Name" },
              ],
            },
          ],
        },
      });

      prismaMock.form.findFirst.mockResolvedValue(mockForm);

      const result = await getAvailableVariables(eventId);

      expect(result.some((v) => v.id === "form_heading-1")).toBe(false);
      expect(result.some((v) => v.id === "form_paragraph-1")).toBe(false);
      expect(result.some((v) => v.id === "form_divider-1")).toBe(false);
      expect(result.some((v) => v.id === "form_name")).toBe(true);
    });

    it("should set category to form for dynamic fields", async () => {
      const mockForm = createMockForm({
        eventId,
        schema: {
          steps: [
            {
              id: "step-1",
              title: "Details",
              fields: [
                { id: "custom_field", type: "text", label: "Custom Field" },
              ],
            },
          ],
        },
      });

      prismaMock.form.findFirst.mockResolvedValue(mockForm);

      const result = await getAvailableVariables(eventId);
      const customField = result.find((v) => v.id === "form_custom_field");

      expect(customField?.category).toBe("form");
    });

    it("should provide appropriate examples for different field types", async () => {
      const mockForm = createMockForm({
        eventId,
        schema: {
          steps: [
            {
              id: "step-1",
              title: "Details",
              fields: [
                { id: "user_email", type: "email", label: "Email" },
                { id: "user_phone", type: "phone", label: "Phone" },
                { id: "age", type: "number", label: "Age" },
                { id: "birth_date", type: "date", label: "Birth Date" },
                { id: "notes", type: "textarea", label: "Notes" },
              ],
            },
          ],
        },
      });

      prismaMock.form.findFirst.mockResolvedValue(mockForm);

      const result = await getAvailableVariables(eventId);

      expect(result.find((v) => v.id === "form_user_email")?.example).toBe(
        "user@example.com",
      );
      expect(result.find((v) => v.id === "form_user_phone")?.example).toBe(
        "+216 12 345 678",
      );
      expect(result.find((v) => v.id === "form_age")?.example).toBe("42");
      expect(result.find((v) => v.id === "form_birth_date")?.example).toBe(
        "March 15, 2025",
      );
      expect(result.find((v) => v.id === "form_notes")?.example).toBe(
        "Long text content...",
      );
    });
  });

  describe("buildEmailContext", () => {
    it("should build context from registration with all fields", () => {
      const registration = createRegistrationWithRelations({
        email: "john.doe@example.com",
        totalAmount: 250,
        paidAmount: 100,
        sponsorshipAmount: 50,
        paymentStatus: "PENDING",
        formData: {
          firstName: "John",
          lastName: "Doe",
          phone: "+216 12 345 678",
          specialty: "Cardiology",
        },
      });
      // Override firstName and lastName directly on the registration object
      // since buildEmailContext uses these fields first before falling back to formData
      (registration as RegistrationWithRelations).firstName = "John";
      (registration as RegistrationWithRelations).lastName = "Doe";
      (registration as RegistrationWithRelations).phone = "+216 12 345 678";

      const context = buildEmailContext(registration);

      expect(context.firstName).toBe("John");
      expect(context.lastName).toBe("Doe");
      expect(context.fullName).toBe("John Doe");
      expect(context.email).toBe("john.doe@example.com");
      expect(context.phone).toBe("+216 12 345 678");
      expect(context.eventName).toBe(registration.event.name);
      expect(context.totalAmount).toContain("250");
      expect(context.paidAmount).toContain("100");
      expect(context.paymentStatus).toBe("Pending");
      expect(context.form_specialty).toBe("Cardiology");
    });

    it("should handle missing optional fields gracefully", () => {
      const registration = createRegistrationWithRelations({
        firstName: null,
        lastName: null,
        phone: null,
        formData: {},
      });
      (registration as RegistrationWithRelations).event.location = null;

      const context = buildEmailContext(registration);

      expect(context.firstName).toBe("");
      expect(context.lastName).toBe("");
      expect(context.fullName).toBe("Registrant");
      expect(context.phone).toBe("");
      expect(context.eventLocation).toBe("");
    });

    it("should format payment status correctly", () => {
      const testCases = [
        { status: "PENDING", expected: "Pending" },
        { status: "PAID", expected: "Confirmed" },
        { status: "REFUNDED", expected: "Refunded" },
        { status: "WAIVED", expected: "Waived" },
      ];

      testCases.forEach(({ status, expected }) => {
        const registration = createRegistrationWithRelations({
          paymentStatus: status as RegistrationWithRelations["paymentStatus"],
        });

        const context = buildEmailContext(registration);
        expect(context.paymentStatus).toBe(expected);
      });
    });

    it("should calculate amount due correctly", () => {
      const registration = createRegistrationWithRelations({
        totalAmount: 500,
        paidAmount: 200,
        sponsorshipAmount: 100,
      });

      const context = buildEmailContext(registration);

      // amountDue = totalAmount - sponsorshipAmount - paidAmount = 500 - 100 - 200 = 200
      expect(context.amountDue).toContain("200");
    });

    it("should format dates correctly", () => {
      const registration = createRegistrationWithRelations();
      registration.event.startDate = new Date("2025-04-20");
      registration.event.endDate = new Date("2025-04-22");
      registration.submittedAt = new Date("2025-03-15");

      const context = buildEmailContext(registration);

      expect(context.eventDate).toBe("April 20, 2025");
      expect(context.eventEndDate).toBe("April 22, 2025");
      expect(context.registrationDate).toBe("March 15, 2025");
    });

    it("should include organizer information from client", () => {
      const registration = createRegistrationWithRelations();
      registration.event.client = {
        ...registration.event.client,
        name: "Test Organization",
        email: "contact@testorg.com",
        phone: "+216 71 000 000",
      };

      const context = buildEmailContext(registration);

      expect(context.organizerName).toBe("Test Organization");
      expect(context.organizerEmail).toBe("contact@testorg.com");
      expect(context.organizerPhone).toBe("+216 71 000 000");
    });

    it("should add form_ prefix to dynamic form fields", () => {
      const registration = createRegistrationWithRelations({
        formData: {
          dietary_requirements: "Vegetarian",
          custom_question: "Custom answer",
        },
      });

      const context = buildEmailContext(registration);

      expect(context.form_dietary_requirements).toBe("Vegetarian");
      expect(context.form_custom_question).toBe("Custom answer");
    });

    it("should format boolean form values", () => {
      const registration = createRegistrationWithRelations({
        formData: {
          newsletter_opt_in: true,
          terms_accepted: false,
        },
      });

      const context = buildEmailContext(registration);

      expect(context.form_newsletter_opt_in).toBe("Yes");
      expect(context.form_terms_accepted).toBe("No");
    });

    it("should format array form values as comma-separated", () => {
      const registration = createRegistrationWithRelations({
        formData: {
          interests: ["Technology", "Medicine", "Research"],
        },
      });

      const context = buildEmailContext(registration);

      expect(context.form_interests).toBe("Technology, Medicine, Research");
    });
  });

  describe("buildEmailContextWithAccess", () => {
    it("should include bank details from pricing", async () => {
      const registration = createRegistrationWithRelations();
      const mockPricing = createMockEventPricing({
        eventId: registration.eventId,
        bankName: "Test Bank",
        bankAccountName: "Test Account Holder",
        bankAccountNumber: "TN59 1234 5678 9012",
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const context = await buildEmailContextWithAccess(registration);

      expect(context.bankName).toBe("Test Bank");
      expect(context.bankAccountName).toBe("Test Account Holder");
      expect(context.bankAccountNumber).toBe("TN59 1234 5678 9012");
    });

    it("should resolve access type IDs to names", async () => {
      const registration = createRegistrationWithRelations({
        accessTypeIds: ["access-1", "access-2", "access-3"],
      });

      const mockAccessTypes = [
        createMockEventAccess({
          id: "access-1",
          name: "Workshop A",
          type: "WORKSHOP",
        }),
        createMockEventAccess({
          id: "access-2",
          name: "Gala Dinner",
          type: "DINNER",
        }),
        createMockEventAccess({
          id: "access-3",
          name: "Workshop B",
          type: "WORKSHOP",
        }),
      ];

      prismaMock.eventPricing.findUnique.mockResolvedValue(null);
      prismaMock.eventAccess.findMany.mockResolvedValue(mockAccessTypes);

      const context = await buildEmailContextWithAccess(registration);

      expect(context.selectedAccess).toBe(
        "Workshop A, Gala Dinner, Workshop B",
      );
      expect(context.selectedWorkshops).toBe("Workshop A, Workshop B");
      expect(context.selectedDinners).toBe("Gala Dinner");
    });

    it("should handle empty access type IDs", async () => {
      const registration = createRegistrationWithRelations({
        accessTypeIds: [],
      });

      prismaMock.eventPricing.findUnique.mockResolvedValue(null);

      const context = await buildEmailContextWithAccess(registration);

      expect(context.selectedAccess).toBe("");
      expect(context.selectedWorkshops).toBe("");
      expect(context.selectedDinners).toBe("");
    });

    it("should handle missing pricing gracefully", async () => {
      const registration = createRegistrationWithRelations();

      prismaMock.eventPricing.findUnique.mockResolvedValue(null);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const context = await buildEmailContextWithAccess(registration);

      expect(context.bankName).toBe("");
      expect(context.bankAccountName).toBe("");
      expect(context.bankAccountNumber).toBe("");
    });
  });

  describe("resolveVariables", () => {
    const sampleContext: EmailContext = {
      firstName: "John",
      lastName: "Doe",
      fullName: "John Doe",
      email: "john@example.com",
      phone: "+216 12 345 678",
      totalAmount: "250 TND",
      paidAmount: "250 TND",
      amountDue: "0 TND",
      paymentStatus: "Confirmed",
      paymentMethod: "Bank Transfer",
      eventName: "Medical Conference",
      eventDate: "April 20, 2025",
      eventEndDate: "April 22, 2025",
      eventLocation: "Tunis",
      eventDescription: "Annual conference",
      registrationId: "reg-123",
      registrationDate: "March 15, 2025",
      registrationNumber: "REG123",
      selectedAccess: "Workshop A, Gala Dinner",
      selectedWorkshops: "Workshop A",
      selectedDinners: "Gala Dinner",
      registrationLink: "https://example.com/reg",
      editRegistrationLink: "https://example.com/edit",
      paymentLink: "https://example.com/pay",
      organizerName: "Medical Events Co.",
      organizerEmail: "contact@medical.com",
      organizerPhone: "+216 71 000 000",
      bankName: "Test Bank",
      bankAccountName: "Test Holder",
      bankAccountNumber: "TN59 1234",
    };

    it("should replace single variable", () => {
      const template = "Hello {{firstName}}!";
      const result = resolveVariables(template, sampleContext);
      expect(result).toBe("Hello John!");
    });

    it("should replace multiple variables", () => {
      const template =
        "Hello {{firstName}} {{lastName}}, welcome to {{eventName}}!";
      const result = resolveVariables(template, sampleContext);
      expect(result).toBe("Hello John Doe, welcome to Medical Conference!");
    });

    it("should handle missing variables by returning empty string", () => {
      const template = "Hello {{nonExistentVar}}!";
      const result = resolveVariables(template, sampleContext);
      expect(result).toBe("Hello !");
    });

    it("should handle mixed existing and non-existing variables", () => {
      const template = "{{firstName}} - {{missing}} - {{lastName}}";
      const result = resolveVariables(template, sampleContext);
      expect(result).toBe("John -  - Doe");
    });

    it("should sanitize HTML in variable values", () => {
      const contextWithHtml = {
        ...sampleContext,
        firstName: '<script>alert("xss")</script>',
      };
      const template = "Hello {{firstName}}";
      // resolveVariables is plain replacement (no HTML escaping); use resolveVariablesHtml for HTML content
      const htmlResult = resolveVariablesHtml(template, contextWithHtml);
      expect(htmlResult).toBe(
        "Hello &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
      );
      // resolveVariables returns the raw value (safe for subject/plain text)
      const plainResult = resolveVariables(template, contextWithHtml);
      expect(plainResult).toBe('Hello <script>alert("xss")</script>');
    });

    it("should handle empty template", () => {
      const result = resolveVariables("", sampleContext);
      expect(result).toBe("");
    });

    it("should handle template with no variables", () => {
      const template = "Hello, this is a plain text message.";
      const result = resolveVariables(template, sampleContext);
      expect(result).toBe("Hello, this is a plain text message.");
    });

    it("should handle variables with underscores", () => {
      const contextWithFormField = {
        ...sampleContext,
        form_custom_field: "Custom Value",
      };
      const template = "Value: {{form_custom_field}}";
      const result = resolveVariables(template, contextWithFormField);
      expect(result).toBe("Value: Custom Value");
    });
  });

  describe("sanitizeForHtml", () => {
    it("should escape angle brackets", () => {
      expect(sanitizeForHtml("<div>")).toBe("&lt;div&gt;");
    });

    it("should escape ampersands", () => {
      expect(sanitizeForHtml("A & B")).toBe("A &amp; B");
    });

    it("should escape quotes", () => {
      expect(sanitizeForHtml('"quoted"')).toBe("&quot;quoted&quot;");
      expect(sanitizeForHtml("'single'")).toBe("&#039;single&#039;");
    });

    it("should handle null and undefined", () => {
      expect(sanitizeForHtml(null)).toBe("");
      expect(sanitizeForHtml(undefined)).toBe("");
    });

    it("should convert numbers to strings", () => {
      expect(sanitizeForHtml(123)).toBe("123");
    });

    it("should handle complex HTML injection attempts", () => {
      const malicious =
        '<script>document.cookie</script><img onerror="alert(1)" src="x">';
      const sanitized = sanitizeForHtml(malicious);
      // The function escapes HTML characters, making the tags inert
      expect(sanitized).not.toContain("<script>");
      expect(sanitized).toContain("&lt;script&gt;");
      // Quotes are escaped, preventing attribute injection
      expect(sanitized).not.toContain('"alert(1)"');
      expect(sanitized).toContain("&quot;alert(1)&quot;");
    });
  });

  describe("sanitizeUrl", () => {
    it("should allow http URLs", () => {
      expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
    });

    it("should allow https URLs", () => {
      expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
    });

    it("should block javascript: URLs", () => {
      expect(sanitizeUrl("javascript:alert(1)")).toBe("#blocked");
    });

    it("should block JavaScript: URLs (case insensitive)", () => {
      expect(sanitizeUrl("JAVASCRIPT:alert(1)")).toBe("#blocked");
      expect(sanitizeUrl("JavaScript:alert(1)")).toBe("#blocked");
    });

    it("should block data: URLs", () => {
      expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe(
        "#blocked",
      );
    });

    it("should block vbscript: URLs", () => {
      expect(sanitizeUrl('vbscript:msgbox("test")')).toBe("#blocked");
    });

    it("should handle URLs with leading whitespace", () => {
      expect(sanitizeUrl("  javascript:alert(1)")).toBe("#blocked");
      // Leading whitespace is trimmed before returning
      expect(sanitizeUrl("  https://example.com")).toBe("https://example.com");
    });

    it("should allow relative URLs", () => {
      expect(sanitizeUrl("/path/to/page")).toBe("/path/to/page");
      expect(sanitizeUrl("./relative")).toBe("./relative");
    });

    it("should allow mailto: URLs", () => {
      expect(sanitizeUrl("mailto:test@example.com")).toBe(
        "mailto:test@example.com",
      );
    });
  });

  describe("getSampleEmailContext", () => {
    it("should return a complete sample context", () => {
      const sample = getSampleEmailContext();

      expect(sample.firstName).toBe("John");
      expect(sample.lastName).toBe("Doe");
      expect(sample.email).toBe("john.doe@example.com");
      expect(sample.eventName).toBe("Medical Conference 2025");
    });

    it("should include all required context fields", () => {
      const sample = getSampleEmailContext();

      // Registration fields
      expect(sample.firstName).toBeDefined();
      expect(sample.lastName).toBeDefined();
      expect(sample.fullName).toBeDefined();
      expect(sample.email).toBeDefined();
      expect(sample.phone).toBeDefined();

      // Event fields
      expect(sample.eventName).toBeDefined();
      expect(sample.eventDate).toBeDefined();
      expect(sample.eventLocation).toBeDefined();

      // Payment fields
      expect(sample.totalAmount).toBeDefined();
      expect(sample.paidAmount).toBeDefined();
      expect(sample.paymentStatus).toBeDefined();

      // Links
      expect(sample.registrationLink).toBeDefined();
      expect(sample.paymentLink).toBeDefined();

      // Bank details
      expect(sample.bankName).toBeDefined();
      expect(sample.bankAccountNumber).toBeDefined();
    });

    it("should return realistic sample data", () => {
      const sample = getSampleEmailContext();

      expect(sample.totalAmount).toContain("TND");
      expect(sample.paymentStatus).toBe("Confirmed");
      expect(sample.registrationLink).toContain("https://");
    });
  });
});
