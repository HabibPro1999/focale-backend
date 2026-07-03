import { describe, it, expect, beforeEach, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";
import type {
  Condition as ContractsCondition,
  FormField as ContractsFormField,
  FormStep as ContractsFormStep,
} from "@app/contracts";
import type {
  Condition as SharedCondition,
  FormField as SharedFormField,
  FormStep as SharedFormStep,
} from "@app/shared";
import type { Form, FormWithEvent } from "@app/db";
import {
  FormsService,
  createDefaultSponsorSchema,
} from "./forms.service";
import { AppException } from "../../core/app-exception";

// ---------------------------------------------------------------------------
// Compile-time contract: the @app/contracts zod-derived FormField/FormStep must
// remain structurally assignable to @app/shared's hand-kept validator shapes
// (the validator consumes forms through the shared types). Breaks the build if
// they drift apart.
// ---------------------------------------------------------------------------
type _AssertFieldSync = ContractsFormField extends SharedFormField ? true : never;
type _AssertStepSync = ContractsFormStep extends SharedFormStep ? true : never;
type _AssertConditionSync = ContractsCondition extends SharedCondition ? true : never;
const _fieldSync: _AssertFieldSync = true;
const _stepSync: _AssertStepSync = true;
const _conditionSync: _AssertConditionSync = true;
void _fieldSync;
void _stepSync;
void _conditionSync;

// ---------------------------------------------------------------------------
// Mock the db query layer (@app/db). The service owns orchestration + error
// mapping; the raw SQL lives in packages/db and is exercised at the DB tier.
// ---------------------------------------------------------------------------
vi.mock("@app/db", () => ({
  eventExists: vi.fn(),
  formExistsByEventAndType: vi.fn(),
  insertForm: vi.fn(),
  findFormById: vi.fn(),
  findFormByIdWithEvent: vi.fn(),
  findRegistrationFormByEventSlug: vi.fn(),
  findSponsorFormByEventSlug: vi.fn(),
  findSponsorFormByEventId: vi.fn(),
  countRegistrationsByFormId: vi.fn(),
  countSponsorshipBatchesByFormId: vi.fn(),
  deleteFormById: vi.fn(),
  updateForm: vi.fn(),
  listForms: vi.fn(),
  updateSponsorFormSchemaModeChange: vi.fn(),
  updateSponsorshipSettingsModeChange: vi.fn(),
}));

import {
  eventExists,
  formExistsByEventAndType,
  insertForm,
  findFormById,
  findFormByIdWithEvent,
  findRegistrationFormByEventSlug,
  findSponsorFormByEventSlug,
  findSponsorFormByEventId,
  countRegistrationsByFormId,
  countSponsorshipBatchesByFormId,
  deleteFormById,
  updateForm as dbUpdateForm,
  listForms as dbListForms,
  updateSponsorFormSchemaModeChange,
  updateSponsorshipSettingsModeChange,
} from "@app/db";

const eventId = "11111111-1111-4111-8111-111111111111";
const formId = "22222222-2222-4222-8222-222222222222";

function mockForm(overrides: Partial<Form> = {}): Form {
  return {
    id: formId,
    eventId,
    type: "REGISTRATION",
    name: "Form",
    schema: { steps: [{ id: "step-1", title: "Info", fields: [] }] },
    schemaVersion: 1,
    successTitle: null,
    successMessage: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Form;
}

function mockFormWithEvent(overrides: Partial<Form> = {}): FormWithEvent {
  return {
    ...mockForm(overrides),
    event: { clientId: "client-123", status: "OPEN", endDate: new Date() },
  };
}

async function expectAppError(
  p: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).getStatus()).toBe(status);
  expect((err as AppException).getResponse()).toMatchObject({ code });
}

const service = new FormsService();

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// createForm
// ============================================================================
describe("createForm", () => {
  it("creates a form with a provided schema (passed through)", async () => {
    const form = mockForm();
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
    vi.mocked(eventExists).mockResolvedValue(true);
    vi.mocked(formExistsByEventAndType).mockResolvedValue(false);
    vi.mocked(insertForm).mockResolvedValue({ ok: true, form });

    const result = await service.createForm(input);

    expect(result).toEqual(form);
    expect(insertForm).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId,
        name: "Registration Form",
        schema: input.schema,
      }),
    );
  });

  it("creates a form with the default schema when none provided", async () => {
    vi.mocked(eventExists).mockResolvedValue(true);
    vi.mocked(formExistsByEventAndType).mockResolvedValue(false);
    vi.mocked(insertForm).mockResolvedValue({ ok: true, form: mockForm() });

    await service.createForm({ eventId, name: "Default Form" });

    expect(insertForm).toHaveBeenCalledWith(
      expect.objectContaining({
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
    );
  });

  it("rejects a supplied registration schema without steps", async () => {
    vi.mocked(eventExists).mockResolvedValue(true);
    vi.mocked(formExistsByEventAndType).mockResolvedValue(false);

    await expectAppError(
      service.createForm({ eventId, name: "x", schema: {} as never }),
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
    expect(insertForm).not.toHaveBeenCalled();
  });

  it("persists successTitle/successMessage verbatim", async () => {
    vi.mocked(eventExists).mockResolvedValue(true);
    vi.mocked(formExistsByEventAndType).mockResolvedValue(false);
    vi.mocked(insertForm).mockResolvedValue({ ok: true, form: mockForm() });

    await service.createForm({
      eventId,
      name: "x",
      successTitle: "Thank you!",
      successMessage: "Confirmed.",
    });

    expect(insertForm).toHaveBeenCalledWith(
      expect.objectContaining({
        successTitle: "Thank you!",
        successMessage: "Confirmed.",
      }),
    );
  });

  it("throws 404 when the event does not exist", async () => {
    vi.mocked(eventExists).mockResolvedValue(false);
    await expectAppError(
      service.createForm({ eventId, name: "x" }),
      404,
      ErrorCodes.NOT_FOUND,
    );
  });

  it("throws 409 when a registration form already exists", async () => {
    vi.mocked(eventExists).mockResolvedValue(true);
    vi.mocked(formExistsByEventAndType).mockResolvedValue(true);
    await expectAppError(
      service.createForm({ eventId, name: "x" }),
      409,
      ErrorCodes.CONFLICT,
    );
  });

  it("maps a losing insert race (23505) to a generic 409", async () => {
    vi.mocked(eventExists).mockResolvedValue(true);
    vi.mocked(formExistsByEventAndType).mockResolvedValue(false);
    vi.mocked(insertForm).mockResolvedValue({ ok: false, reason: "conflict" });
    await expectAppError(
      service.createForm({ eventId, name: "x" }),
      409,
      ErrorCodes.CONFLICT,
    );
  });
});

// ============================================================================
// reads
// ============================================================================
describe("getFormById", () => {
  it("returns the form-with-event and queries by id", async () => {
    const form = mockFormWithEvent();
    vi.mocked(findFormByIdWithEvent).mockResolvedValue(form);
    const result = await service.getFormById(formId);
    expect(result).toEqual(form);
    expect(findFormByIdWithEvent).toHaveBeenCalledWith(formId);
  });

  it("returns null when not found", async () => {
    vi.mocked(findFormByIdWithEvent).mockResolvedValue(null);
    expect(await service.getFormById("missing")).toBeNull();
  });
});

describe("getFormByEventSlug", () => {
  it("delegates to the db query by slug", async () => {
    vi.mocked(findRegistrationFormByEventSlug).mockResolvedValue(null);
    await service.getFormByEventSlug("my-slug");
    expect(findRegistrationFormByEventSlug).toHaveBeenCalledWith("my-slug");
  });
});

describe("getSponsorFormByEventSlug", () => {
  it("delegates to the db query by slug", async () => {
    vi.mocked(findSponsorFormByEventSlug).mockResolvedValue(null);
    await service.getSponsorFormByEventSlug("my-slug");
    expect(findSponsorFormByEventSlug).toHaveBeenCalledWith("my-slug");
  });
});

describe("getSponsorFormByEventId", () => {
  it("delegates to the db query by eventId", async () => {
    const form = mockForm({ type: "SPONSOR" });
    vi.mocked(findSponsorFormByEventId).mockResolvedValue(form);
    expect(await service.getSponsorFormByEventId(eventId)).toEqual(form);
    expect(findSponsorFormByEventId).toHaveBeenCalledWith(eventId);
  });

  it("returns null when none exists", async () => {
    vi.mocked(findSponsorFormByEventId).mockResolvedValue(null);
    expect(await service.getSponsorFormByEventId(eventId)).toBeNull();
  });
});

// ============================================================================
// updateForm
// ============================================================================
describe("updateForm", () => {
  it("updates name only (no schema keys)", async () => {
    vi.mocked(findFormById).mockResolvedValue(mockForm({ name: "Old" }));
    const updated = mockForm({ name: "New Name" });
    vi.mocked(dbUpdateForm).mockResolvedValue(updated);

    const result = await service.updateForm(formId, { name: "New Name" });

    expect(result.name).toBe("New Name");
    expect(dbUpdateForm).toHaveBeenCalledWith(formId, { name: "New Name" });
  });

  it("updates success messages only", async () => {
    vi.mocked(findFormById).mockResolvedValue(mockForm());
    vi.mocked(dbUpdateForm).mockResolvedValue(mockForm());

    await service.updateForm(formId, {
      successTitle: "New Title",
      successMessage: "New Message",
    });

    expect(dbUpdateForm).toHaveBeenCalledWith(formId, {
      successTitle: "New Title",
      successMessage: "New Message",
    });
  });

  it("increments schemaVersion when the schema changes", async () => {
    vi.mocked(findFormById).mockResolvedValue(
      mockForm({ schema: { steps: [{ id: "old", title: "Old", fields: [] }] } }),
    );
    vi.mocked(countRegistrationsByFormId).mockResolvedValue(0);
    vi.mocked(dbUpdateForm).mockResolvedValue(mockForm({ schemaVersion: 2 }));

    const newSchema = { steps: [{ id: "new", title: "New", fields: [] }] };
    await service.updateForm(formId, { schema: newSchema });

    expect(dbUpdateForm).toHaveBeenCalledWith(
      formId,
      expect.objectContaining({
        schema: newSchema,
        incrementSchemaVersion: true,
      }),
    );
  });

  it("sends an empty patch (no version bump) when the schema is unchanged", async () => {
    const existingSchema = { steps: [{ id: "step-1", title: "Info", fields: [] }] };
    vi.mocked(findFormById).mockResolvedValue(mockForm({ schema: existingSchema }));
    vi.mocked(dbUpdateForm).mockResolvedValue(mockForm({ schema: existingSchema }));

    await service.updateForm(formId, { schema: existingSchema });

    expect(dbUpdateForm).toHaveBeenCalledWith(formId, {});
  });

  it("throws 404 when the form is missing", async () => {
    vi.mocked(findFormById).mockResolvedValue(null);
    await expectAppError(
      service.updateForm("missing", { name: "x" }),
      404,
      ErrorCodes.NOT_FOUND,
    );
  });

  it("counts registrations when removing fields", async () => {
    vi.mocked(findFormById).mockResolvedValue(
      mockForm({
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
      }),
    );
    vi.mocked(countRegistrationsByFormId).mockResolvedValue(5);
    vi.mocked(dbUpdateForm).mockResolvedValue(mockForm({ schemaVersion: 2 }));

    await service.updateForm(formId, {
      schema: {
        steps: [
          {
            id: "step-1",
            title: "Info",
            fields: [{ id: "field-to-keep", type: "email" as const, label: "Email" }],
          },
        ],
      },
    });

    expect(countRegistrationsByFormId).toHaveBeenCalledWith(formId);
  });

  it("rejects a stepless registration schema and never writes", async () => {
    vi.mocked(findFormById).mockResolvedValue(mockForm({ type: "REGISTRATION" }));
    await expectAppError(
      service.updateForm(formId, { schema: {} as never }),
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
    expect(dbUpdateForm).not.toHaveBeenCalled();
  });

  it("routes a sponsorship-mode change through the serializable db fn", async () => {
    const currentSchema = createDefaultSponsorSchema();
    const nextSchema = {
      ...currentSchema,
      sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" as const },
    };
    const form = mockForm({ type: "SPONSOR", schema: currentSchema as never });
    const updated = mockForm({ type: "SPONSOR", schema: nextSchema as never });

    vi.mocked(findFormById).mockResolvedValue(form);
    vi.mocked(updateSponsorFormSchemaModeChange).mockResolvedValue({
      ok: true,
      form: updated,
    });

    await expect(
      service.updateForm(formId, { schema: nextSchema }),
    ).resolves.toEqual(updated);

    expect(updateSponsorFormSchemaModeChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: formId, newMode: "LINKED_ACCOUNT" }),
    );
    expect(dbUpdateForm).not.toHaveBeenCalled();
  });

  it("maps a serializable-path lock conflict to 409", async () => {
    const currentSchema = createDefaultSponsorSchema();
    const nextSchema = {
      ...currentSchema,
      sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" as const },
    };
    vi.mocked(findFormById).mockResolvedValue(
      mockForm({ type: "SPONSOR", schema: currentSchema as never }),
    );
    vi.mocked(updateSponsorFormSchemaModeChange).mockResolvedValue({
      ok: false,
      reason: "locked",
    });

    await expectAppError(
      service.updateForm(formId, { schema: nextSchema }),
      409,
      ErrorCodes.CONFLICT,
    );
  });
});

// ============================================================================
// updateSponsorshipSettings
// ============================================================================
describe("updateSponsorshipSettings", () => {
  it("routes a mode change through the serializable db fn", async () => {
    const currentSchema = createDefaultSponsorSchema();
    const form = mockForm({ type: "SPONSOR", schema: currentSchema as never });
    const updated = mockForm({ type: "SPONSOR" });

    vi.mocked(findFormById).mockResolvedValue(form);
    vi.mocked(updateSponsorshipSettingsModeChange).mockResolvedValue({
      ok: true,
      form: updated,
    });

    await expect(
      service.updateSponsorshipSettings(formId, {
        sponsorshipMode: "LINKED_ACCOUNT",
      }),
    ).resolves.toEqual(updated);

    expect(updateSponsorshipSettingsModeChange).toHaveBeenCalledWith(formId, {
      sponsorshipMode: "LINKED_ACCOUNT",
    });
  });

  it("throws 400 for a non-sponsor form", async () => {
    vi.mocked(findFormById).mockResolvedValue(mockForm({ type: "REGISTRATION" }));
    await expectAppError(
      service.updateSponsorshipSettings(formId, { sponsorshipMode: "CODE" }),
      400,
      ErrorCodes.BAD_REQUEST,
    );
  });

  it("shallow-merges settings without a mode change (no serializable txn)", async () => {
    const currentSchema = createDefaultSponsorSchema(); // mode CODE
    vi.mocked(findFormById).mockResolvedValue(
      mockForm({ type: "SPONSOR", schema: currentSchema as never }),
    );
    vi.mocked(dbUpdateForm).mockResolvedValue(mockForm({ type: "SPONSOR" }));

    await service.updateSponsorshipSettings(formId, {
      sponsorshipMode: "CODE",
      autoApproveSponsorship: true,
    });

    expect(updateSponsorshipSettingsModeChange).not.toHaveBeenCalled();
    expect(dbUpdateForm).toHaveBeenCalledWith(
      formId,
      expect.objectContaining({
        schema: expect.objectContaining({
          sponsorshipSettings: expect.objectContaining({
            sponsorshipMode: "CODE",
            autoApproveSponsorship: true,
          }),
        }),
      }),
    );
  });
});

// ============================================================================
// listForms
// ============================================================================
describe("listForms", () => {
  it("returns paginated results", async () => {
    vi.mocked(dbListForms).mockResolvedValue({
      data: [mockForm({ name: "1" }), mockForm({ name: "2" })],
      total: 2,
    });
    const result = await service.listForms({ page: 1, limit: 10 });
    expect(result.data).toHaveLength(2);
    expect(result.meta).toMatchObject({
      total: 2,
      page: 1,
      limit: 10,
      totalPages: 1,
    });
  });

  it("filters by eventId", async () => {
    vi.mocked(dbListForms).mockResolvedValue({ data: [], total: 0 });
    await service.listForms({ page: 1, limit: 10, eventId });
    expect(dbListForms).toHaveBeenCalledWith(
      expect.objectContaining({ eventId }),
      0,
      10,
    );
  });

  it("filters by type", async () => {
    vi.mocked(dbListForms).mockResolvedValue({ data: [], total: 0 });
    await service.listForms({ page: 1, limit: 10, type: "SPONSOR" });
    expect(dbListForms).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SPONSOR" }),
      0,
      10,
    );
  });

  it("filters by search", async () => {
    vi.mocked(dbListForms).mockResolvedValue({ data: [], total: 0 });
    await service.listForms({ page: 1, limit: 10, search: "registration" });
    expect(dbListForms).toHaveBeenCalledWith(
      expect.objectContaining({ search: "registration" }),
      0,
      10,
    );
  });

  it("computes pagination offsets and totals", async () => {
    vi.mocked(dbListForms).mockResolvedValue({ data: [mockForm()], total: 25 });
    const result = await service.listForms({ page: 2, limit: 10 });
    expect(dbListForms).toHaveBeenCalledWith(expect.anything(), 10, 10);
    expect(result.meta.page).toBe(2);
    expect(result.meta.totalPages).toBe(3);
  });
});

// ============================================================================
// deleteForm
// ============================================================================
describe("deleteForm", () => {
  it("deletes when found and no registrations", async () => {
    vi.mocked(findFormById).mockResolvedValue(mockForm());
    vi.mocked(countRegistrationsByFormId).mockResolvedValue(0);
    vi.mocked(deleteFormById).mockResolvedValue();

    await service.deleteForm(formId);

    expect(deleteFormById).toHaveBeenCalledWith(formId);
  });

  it("throws 404 when the form is missing", async () => {
    vi.mocked(findFormById).mockResolvedValue(null);
    await expectAppError(
      service.deleteForm("missing"),
      404,
      ErrorCodes.NOT_FOUND,
    );
  });

  it("throws 409 when registrations exist", async () => {
    vi.mocked(findFormById).mockResolvedValue(mockForm());
    vi.mocked(countRegistrationsByFormId).mockResolvedValue(3);
    await expectAppError(service.deleteForm(formId), 409, ErrorCodes.CONFLICT);
    expect(deleteFormById).not.toHaveBeenCalled();
  });
});

// ============================================================================
// createDefaultSponsorSchema
// ============================================================================
describe("createDefaultSponsorSchema", () => {
  it("produces the canonical sponsor schema shape", () => {
    const schema = createDefaultSponsorSchema();
    expect(schema.formType).toBe("SPONSOR");
    expect(schema.sponsorSteps).toHaveLength(1);
    expect(schema.sponsorSteps[0].title).toBe("Informations du laboratoire");
    expect(schema.beneficiaryTemplate.minCount).toBe(1);
    expect(schema.beneficiaryTemplate.maxCount).toBe(100);

    expect(schema.sponsorSteps[0].fields.map((f) => f.id)).toEqual(
      expect.arrayContaining(["labName", "contactName", "email", "phone"]),
    );
    expect(schema.beneficiaryTemplate.fields.map((f) => f.id)).toEqual(
      expect.arrayContaining(["name", "email", "phone", "address"]),
    );
  });
});

// ============================================================================
// isSponsorshipModeLocked
// ============================================================================
describe("isSponsorshipModeLocked", () => {
  it("is locked once any batch exists", async () => {
    vi.mocked(countSponsorshipBatchesByFormId).mockResolvedValue(1);
    expect(await service.isSponsorshipModeLocked(formId)).toBe(true);
    expect(countSponsorshipBatchesByFormId).toHaveBeenCalledWith(formId);
  });

  it("is unlocked with zero batches", async () => {
    vi.mocked(countSponsorshipBatchesByFormId).mockResolvedValue(0);
    expect(await service.isSponsorshipModeLocked(formId)).toBe(false);
  });
});

// ============================================================================
// createSponsorForm
// ============================================================================
describe("createSponsorForm", () => {
  it("creates with the default schema and fallback name", async () => {
    const form = mockForm({ type: "SPONSOR" });
    vi.mocked(eventExists).mockResolvedValue(true);
    vi.mocked(formExistsByEventAndType).mockResolvedValue(false);
    vi.mocked(insertForm).mockResolvedValue({ ok: true, form });

    expect(await service.createSponsorForm(eventId)).toEqual(form);
    expect(insertForm).toHaveBeenCalledWith(
      expect.objectContaining({
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
    );
  });

  it("creates with a custom name", async () => {
    vi.mocked(eventExists).mockResolvedValue(true);
    vi.mocked(formExistsByEventAndType).mockResolvedValue(false);
    vi.mocked(insertForm).mockResolvedValue({
      ok: true,
      form: mockForm({ type: "SPONSOR" }),
    });

    await service.createSponsorForm(eventId, "Custom Sponsor Form");
    expect(insertForm).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Custom Sponsor Form" }),
    );
  });

  it("throws 404 when the event is missing", async () => {
    vi.mocked(eventExists).mockResolvedValue(false);
    await expectAppError(
      service.createSponsorForm(eventId),
      404,
      ErrorCodes.NOT_FOUND,
    );
  });

  it("throws 409 when a sponsor form already exists", async () => {
    vi.mocked(eventExists).mockResolvedValue(true);
    vi.mocked(formExistsByEventAndType).mockResolvedValue(true);
    await expectAppError(
      service.createSponsorForm(eventId),
      409,
      ErrorCodes.CONFLICT,
    );
  });
});
