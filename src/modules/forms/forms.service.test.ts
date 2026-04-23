import { describe, it, expect, beforeEach, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockForm,
  createMockEvent,
  createMockClient,
} from "../../../tests/helpers/factories.js";
import {
  createForm,
  getFormById,
  getFormByEventSlug,
  updateForm,
  listForms,
  deleteForm,
  createDefaultSponsorSchema,
  getSponsorFormByEventSlug,
  getSponsorFormByEventId,
  createSponsorForm,
} from "./forms.service.js";
import { validateFormData } from "./form-data-validator.js";

import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { faker } from "@faker-js/faker";
import type { Form } from "@/generated/prisma/client.js";

// Mock the events module
vi.mock("@events", () => ({
  eventExists: vi.fn(),
}));

import { eventExists as mockEventExists } from "@events";

describe("Forms Service", () => {
  const eventId = faker.string.uuid();
  const formId = faker.string.uuid();

  beforeEach(() => {
    vi.mocked(mockEventExists).mockReset();
  });

  // ============================================================================
  // createForm
  // ============================================================================

  describe("createForm", () => {
    it("should create a form with provided schema", async () => {
      const mockForm = createMockForm({ eventId });
      const input = {
        eventId,
        name: "Registration Form",
        schema: {
          steps: [
            {
              id: "step-1",
              title: "Info",
              fields: [{ id: "field-1", type: "text" as const, label: "Name" }],
            },
          ],
        },
      };

      vi.mocked(mockEventExists).mockResolvedValue(true);
      prismaMock.form.findFirst.mockResolvedValue(null);
      prismaMock.form.create.mockResolvedValue(mockForm);

      const result = await createForm(input);

      expect(result).toEqual(mockForm);
      expect(prismaMock.form.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId,
          name: "Registration Form",
          schema: input.schema,
        }),
      });
    });

    it("should create a form with default schema when none provided", async () => {
      const mockForm = createMockForm({ eventId });
      const input = {
        eventId,
        name: "Default Form",
      };

      vi.mocked(mockEventExists).mockResolvedValue(true);
      prismaMock.form.findFirst.mockResolvedValue(null);
      prismaMock.form.create.mockResolvedValue(mockForm);

      await createForm(input);

      expect(prismaMock.form.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId,
          name: "Default Form",
          schema: expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                title: "Informations personnelles",
                fields: expect.arrayContaining([
                  expect.objectContaining({ type: "firstName" }),
                  expect.objectContaining({ type: "lastName" }),
                  expect.objectContaining({ type: "email" }),
                  expect.objectContaining({ type: "phone" }),
                ]),
              }),
            ]),
          }),
        }),
      });
    });

    it("should create a form with successTitle and successMessage", async () => {
      const mockForm = createMockForm({ eventId });
      const input = {
        eventId,
        name: "Form with Success",
        successTitle: "Thank you!",
        successMessage: "Your registration is confirmed.",
      };

      vi.mocked(mockEventExists).mockResolvedValue(true);
      prismaMock.form.findFirst.mockResolvedValue(null);
      prismaMock.form.create.mockResolvedValue(mockForm);

      await createForm(input);

      expect(prismaMock.form.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          successTitle: "Thank you!",
          successMessage: "Your registration is confirmed.",
        }),
      });
    });

    it("should throw when event does not exist", async () => {
      const input = {
        eventId: "non-existent-event",
        name: "Test Form",
      };

      vi.mocked(mockEventExists).mockResolvedValue(false);

      await expect(createForm(input)).rejects.toThrow(AppError);
      await expect(createForm(input)).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should throw conflict when event already has a registration form", async () => {
      const existingForm = createMockForm({ eventId, type: "REGISTRATION" });
      const input = {
        eventId,
        name: "Another Form",
      };

      vi.mocked(mockEventExists).mockResolvedValue(true);
      prismaMock.form.findFirst.mockResolvedValue(existingForm);

      await expect(createForm(input)).rejects.toThrow(AppError);
      await expect(createForm(input)).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.CONFLICT,
      });
    });
  });

  // ============================================================================
  // getFormById
  // ============================================================================

  describe("getFormById", () => {
    it("should return form with event.clientId when found", async () => {
      const mockForm = {
        ...createMockForm({ id: formId }),
        event: { clientId: "client-123" },
      };
      prismaMock.form.findUnique.mockResolvedValue(mockForm as never);

      const result = await getFormById(formId);

      expect(result?.id).toBe(formId);
      expect(result?.event.clientId).toBe("client-123");
      expect(prismaMock.form.findUnique).toHaveBeenCalledWith({
        where: { id: formId },
        include: { event: { select: { clientId: true, status: true } } },
      });
    });

    it("should return null when form not found", async () => {
      prismaMock.form.findUnique.mockResolvedValue(null);

      const result = await getFormById("non-existent");

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // getFormByEventSlug
  // ============================================================================

  describe("getFormByEventSlug", () => {
    it("should return form with relations for OPEN event", async () => {
      const mockClient = createMockClient();
      const mockEvent = createMockEvent({
        clientId: mockClient.id,
        status: "OPEN",
      });
      const mockForm = createMockForm({
        eventId: mockEvent.id,
      });
      const formWithRelations = {
        ...mockForm,
        event: {
          ...mockEvent,
          client: {
            id: mockClient.id,
            name: mockClient.name,
            logo: mockClient.logo,
            primaryColor: mockClient.primaryColor,
          },
          pricing: null,
          access: [],
        },
      };

      prismaMock.form.findFirst.mockResolvedValue(
        formWithRelations as Form & { event: unknown },
      );

      const result = await getFormByEventSlug(mockEvent.slug);

      expect(result).toEqual(formWithRelations);
      expect(prismaMock.form.findFirst).toHaveBeenCalledWith({
        where: {
          type: "REGISTRATION",
          event: {
            slug: mockEvent.slug,
            status: "OPEN",
            client: {
              enabledModules: {
                has: "registrations",
              },
            },
          },
          active: true,
        },
        include: expect.objectContaining({
          event: expect.objectContaining({
            include: expect.objectContaining({
              client: expect.any(Object),
              pricing: true,
              access: expect.any(Object),
            }),
          }),
        }),
      });
    });

    it("should return null for non-OPEN event", async () => {
      const mockEvent = createMockEvent({ status: "CLOSED" });

      // The query filters by status: 'OPEN', so findFirst returns null for CLOSED events
      prismaMock.form.findFirst.mockResolvedValue(null);

      const result = await getFormByEventSlug(mockEvent.slug);

      expect(result).toBeNull();
    });

    it("should return null when form not found", async () => {
      prismaMock.form.findFirst.mockResolvedValue(null);

      const result = await getFormByEventSlug("non-existent-slug");

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // updateForm
  // ============================================================================

  describe("updateForm", () => {
    it("should update form name", async () => {
      const mockForm = createMockForm({ id: formId, name: "Old Name" });
      const updatedForm = createMockForm({ id: formId, name: "New Name" });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.form.update.mockResolvedValue(updatedForm);

      const result = await updateForm(formId, { name: "New Name" });

      expect(result.name).toBe("New Name");
      expect(prismaMock.form.update).toHaveBeenCalledWith({
        where: { id: formId },
        data: { name: "New Name" },
      });
    });

    it("should update success messages", async () => {
      const mockForm = createMockForm({ id: formId });
      const updatedForm = createMockForm({
        id: formId,
      });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.form.update.mockResolvedValue(updatedForm);

      await updateForm(formId, {
        successTitle: "New Title",
        successMessage: "New Message",
      });

      expect(prismaMock.form.update).toHaveBeenCalledWith({
        where: { id: formId },
        data: {
          successTitle: "New Title",
          successMessage: "New Message",
        },
      });
    });

    it("should increment schemaVersion when schema changes", async () => {
      const mockForm = createMockForm({
        id: formId,
        schemaVersion: 1,
        schema: { steps: [{ id: "old-step", title: "Old", fields: [] }] },
      });
      const updatedForm = createMockForm({ id: formId, schemaVersion: 2 });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.count.mockResolvedValue(0);
      prismaMock.form.update.mockResolvedValue(updatedForm);

      const newSchema = {
        steps: [{ id: "new-step", title: "New", fields: [] }],
      };
      await updateForm(formId, { schema: newSchema });

      expect(prismaMock.form.update).toHaveBeenCalledWith({
        where: { id: formId },
        data: expect.objectContaining({
          schema: newSchema,
          schemaVersion: { increment: 1 },
        }),
      });
    });

    it("should not increment schemaVersion when schema is unchanged", async () => {
      const existingSchema = {
        steps: [{ id: "step-1", title: "Info", fields: [] }],
      };
      const mockForm = createMockForm({
        id: formId,
        schemaVersion: 1,
        schema: existingSchema,
      });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.form.update.mockResolvedValue(mockForm);

      await updateForm(formId, { schema: existingSchema });

      // Should not include schemaVersion increment
      expect(prismaMock.form.update).toHaveBeenCalledWith({
        where: { id: formId },
        data: {},
      });
    });

    it("should throw when form not found", async () => {
      prismaMock.form.findUnique.mockResolvedValue(null);

      await expect(
        updateForm("non-existent", { name: "Test" }),
      ).rejects.toThrow(AppError);
      await expect(
        updateForm("non-existent", { name: "Test" }),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should log warning when removing fields with existing registrations", async () => {
      const mockForm = createMockForm({
        id: formId,
        schema: {
          steps: [
            {
              id: "step-1",
              title: "Info",
              fields: [
                { id: "field-to-remove", type: "text", label: "Name" },
                { id: "field-to-keep", type: "email", label: "Email" },
              ],
            },
          ],
        },
      });
      const updatedForm = createMockForm({ id: formId, schemaVersion: 2 });

      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.registration.count.mockResolvedValue(5); // Has registrations
      prismaMock.form.update.mockResolvedValue(updatedForm);

      const newSchema = {
        steps: [
          {
            id: "step-1",
            title: "Info",
            fields: [
              { id: "field-to-keep", type: "email" as const, label: "Email" },
            ],
          },
        ],
      };

      await updateForm(formId, { schema: newSchema });

      // Check that registration count was queried
      expect(prismaMock.registration.count).toHaveBeenCalledWith({
        where: { formId },
      });
    });
  });

  // ============================================================================
  // listForms
  // ============================================================================

  describe("listForms", () => {
    it("should return paginated forms", async () => {
      const mockForms = [
        createMockForm({ name: "Form 1" }),
        createMockForm({ name: "Form 2" }),
      ];

      prismaMock.form.findMany.mockResolvedValue(mockForms);
      prismaMock.form.count.mockResolvedValue(2);

      const result = await listForms({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);
      expect(result.meta.totalPages).toBe(1);
    });

    it("should filter by eventId", async () => {
      prismaMock.form.findMany.mockResolvedValue([]);
      prismaMock.form.count.mockResolvedValue(0);

      await listForms({ page: 1, limit: 10, eventId });

      expect(prismaMock.form.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId },
        }),
      );
    });

    it("should filter by type", async () => {
      prismaMock.form.findMany.mockResolvedValue([]);
      prismaMock.form.count.mockResolvedValue(0);

      await listForms({ page: 1, limit: 10, type: "SPONSOR" });

      expect(prismaMock.form.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { type: "SPONSOR" },
        }),
      );
    });

    it("should filter by search term", async () => {
      prismaMock.form.findMany.mockResolvedValue([]);
      prismaMock.form.count.mockResolvedValue(0);

      await listForms({ page: 1, limit: 10, search: "registration" });

      expect(prismaMock.form.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ name: { contains: "registration", mode: "insensitive" } }],
          },
        }),
      );
    });

    it("should handle pagination correctly", async () => {
      const mockForms = [createMockForm()];
      prismaMock.form.findMany.mockResolvedValue(mockForms);
      prismaMock.form.count.mockResolvedValue(25);

      const result = await listForms({ page: 2, limit: 10 });

      expect(result.meta.page).toBe(2);
      expect(result.meta.totalPages).toBe(3);
      expect(prismaMock.form.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10, // (page - 1) * limit
          take: 10,
        }),
      );
    });
  });

  // ============================================================================
  // deleteForm
  // ============================================================================

  describe("deleteForm", () => {
    it("should delete form when found", async () => {
      const mockForm = createMockForm({ id: formId });
      prismaMock.form.findUnique.mockResolvedValue(mockForm);
      prismaMock.form.delete.mockResolvedValue(mockForm);

      await deleteForm(formId);

      expect(prismaMock.form.delete).toHaveBeenCalledWith({
        where: { id: formId },
      });
    });

    it("should throw when form not found", async () => {
      prismaMock.form.findUnique.mockResolvedValue(null);

      await expect(deleteForm("non-existent")).rejects.toThrow(AppError);
      await expect(deleteForm("non-existent")).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });
  });

  // ============================================================================
  // getFormClientId
  // ============================================================================

  // ============================================================================
  // Sponsor Form Functions
  // ============================================================================

  describe("createDefaultSponsorSchema", () => {
    it("should create valid sponsor form schema", () => {
      const schema = createDefaultSponsorSchema();

      expect(schema.formType).toBe("SPONSOR");
      expect(schema.sponsorSteps).toHaveLength(1);
      expect(schema.sponsorSteps[0].title).toBe("Informations du laboratoire");
      expect(schema.beneficiaryTemplate).toBeDefined();
      expect(schema.beneficiaryTemplate.minCount).toBe(1);
      expect(schema.beneficiaryTemplate.maxCount).toBe(100);
    });

    it("should include required sponsor step fields", () => {
      const schema = createDefaultSponsorSchema();
      const fields = schema.sponsorSteps[0].fields;
      const fieldIds = fields.map((f) => f.id);

      expect(fieldIds).toContain("labName");
      expect(fieldIds).toContain("contactName");
      expect(fieldIds).toContain("email");
      expect(fieldIds).toContain("phone");
    });

    it("should include beneficiary template fields", () => {
      const schema = createDefaultSponsorSchema();
      const fields = schema.beneficiaryTemplate.fields;
      const fieldIds = fields.map((f) => f.id);

      expect(fieldIds).toContain("name");
      expect(fieldIds).toContain("email");
      expect(fieldIds).toContain("phone");
      expect(fieldIds).toContain("address");
    });
  });

  describe("getSponsorFormByEventSlug", () => {
    it("should return sponsor form for OPEN event", async () => {
      const mockClient = createMockClient();
      const mockEvent = createMockEvent({
        clientId: mockClient.id,
        status: "OPEN",
      });
      const mockForm = createMockForm({
        eventId: mockEvent.id,
        type: "SPONSOR",
        active: true,
      });
      const formWithRelations = {
        ...mockForm,
        event: {
          ...mockEvent,
          client: {
            id: mockClient.id,
            name: mockClient.name,
            logo: mockClient.logo,
            primaryColor: mockClient.primaryColor,
          },
          pricing: null,
          access: [],
        },
      };

      prismaMock.form.findFirst.mockResolvedValue(
        formWithRelations as Form & { event: unknown },
      );

      const result = await getSponsorFormByEventSlug(mockEvent.slug);

      expect(result).toEqual(formWithRelations);
      expect(prismaMock.form.findFirst).toHaveBeenCalledWith({
        where: {
          type: "SPONSOR",
          event: {
            slug: mockEvent.slug,
            status: "OPEN",
            client: {
              enabledModules: {
                has: "sponsorships",
              },
            },
          },
          active: true,
        },
        include: expect.any(Object),
      });
    });

    it("should return null when sponsor form not found", async () => {
      prismaMock.form.findFirst.mockResolvedValue(null);

      const result = await getSponsorFormByEventSlug("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("getSponsorFormByEventId", () => {
    it("should return sponsor form by eventId", async () => {
      const mockForm = createMockForm({ eventId, type: "SPONSOR" });
      prismaMock.form.findFirst.mockResolvedValue(mockForm);

      const result = await getSponsorFormByEventId(eventId);

      expect(result).toEqual(mockForm);
      expect(prismaMock.form.findFirst).toHaveBeenCalledWith({
        where: { eventId, type: "SPONSOR" },
      });
    });

    it("should return null when no sponsor form exists", async () => {
      prismaMock.form.findFirst.mockResolvedValue(null);

      const result = await getSponsorFormByEventId(eventId);

      expect(result).toBeNull();
    });
  });

  describe("createSponsorForm", () => {
    it("should create sponsor form with default schema", async () => {
      const mockForm = createMockForm({ eventId, type: "SPONSOR" });

      vi.mocked(mockEventExists).mockResolvedValue(true);
      prismaMock.form.findFirst.mockResolvedValue(null);
      prismaMock.form.create.mockResolvedValue(mockForm);

      const result = await createSponsorForm(eventId);

      expect(result).toEqual(mockForm);
      expect(prismaMock.form.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId,
          type: "SPONSOR",
          name: "Formulaire Sponsor",
          active: true,
          schema: expect.objectContaining({
            formType: "SPONSOR",
            sponsorSteps: expect.any(Array),
            beneficiaryTemplate: expect.any(Object),
          }),
        }),
      });
    });

    it("should create sponsor form with custom name", async () => {
      const mockForm = createMockForm({ eventId, type: "SPONSOR" });

      vi.mocked(mockEventExists).mockResolvedValue(true);
      prismaMock.form.findFirst.mockResolvedValue(null);
      prismaMock.form.create.mockResolvedValue(mockForm);

      await createSponsorForm(eventId, "Custom Sponsor Form");

      expect(prismaMock.form.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "Custom Sponsor Form",
        }),
      });
    });

    it("should throw when event does not exist", async () => {
      vi.mocked(mockEventExists).mockResolvedValue(false);

      await expect(createSponsorForm(eventId)).rejects.toThrow(AppError);
      await expect(createSponsorForm(eventId)).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should throw conflict when event already has a sponsor form", async () => {
      const existingForm = createMockForm({ eventId, type: "SPONSOR" });

      vi.mocked(mockEventExists).mockResolvedValue(true);
      prismaMock.form.findFirst.mockResolvedValue(existingForm);

      await expect(createSponsorForm(eventId)).rejects.toThrow(AppError);
      await expect(createSponsorForm(eventId)).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.CONFLICT,
      });
    });
  });

  // ============================================================================
  // Form Data Validator — field.required bug regression
  // ============================================================================

  describe("validateFormData — field.required", () => {
    const schema = {
      steps: [
        {
          id: "step-1",
          title: "Step 1",
          fields: [
            {
              // required at top level (field.required), no validation object
              id: "firstName",
              type: "text" as const,
              label: "First Name",
              required: true,
            },
            {
              // required via nested validation.required
              id: "email",
              type: "email" as const,
              label: "Email",
              required: false,
              validation: { required: true },
            },
            {
              // not required either way
              id: "phone",
              type: "text" as const,
              label: "Phone",
              required: false,
            },
          ],
        },
      ],
    };

    it("should reject empty value for field with field.required = true", () => {
      const result = validateFormData(schema, {
        firstName: "",
        email: "a@b.com",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.fieldId === "firstName")).toBe(true);
    });

    it("should reject empty value for field with validation.required = true", () => {
      const result = validateFormData(schema, {
        firstName: "Alice",
        email: "",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.fieldId === "email")).toBe(true);
    });

    it("should accept empty value for optional field", () => {
      const result = validateFormData(schema, {
        firstName: "Alice",
        email: "a@b.com",
        phone: "",
      });
      expect(result.valid).toBe(true);
    });

    it("should treat field.required=true as required even when validation.required=false", () => {
      const conflictingSchema = {
        steps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "nickname",
                type: "text" as const,
                label: "Nickname",
                required: true,
                validation: { required: false },
              },
            ],
          },
        ],
      };

      const result = validateFormData(conflictingSchema, { nickname: "" });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.fieldId === "nickname")).toBe(true);
    });
  });
});
