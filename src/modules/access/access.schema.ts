import { z } from "zod";
import {
  ConditionSchema as AccessConditionSchema,
  type Condition as AccessCondition,
} from "@shared/schemas/condition.schema.js";

export { AccessConditionSchema };
export type { AccessCondition };

const hasUpdateField = (data: Record<string, unknown>) =>
  Object.values(data).some((value) => value !== undefined);

// ============================================================================
// Enums
// ============================================================================

export const AccessTypeSchema = z.enum([
  "WORKSHOP",
  "DINNER",
  "SESSION",
  "NETWORKING",
  "ACCOMMODATION",
  "TRANSPORT",
  "OTHER",
  "ADDON",
]);

// ============================================================================
// Create/Update Schemas
// ============================================================================

export const CreateEventAccessSchema = z
  .strictObject({
    eventId: z.string().uuid(),
    type: AccessTypeSchema.default("OTHER"),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional().nullable(),
    location: z.string().max(500).optional().nullable(),

    // Scheduling
    startsAt: z.coerce.date().optional().nullable(),
    endsAt: z.coerce.date().optional().nullable(),

    // Pricing
    price: z.number().int().min(0).default(0),
    currency: z.string().length(3).default("TND"),

    // Capacity
    maxCapacity: z.number().int().positive().optional().nullable(),

    // Availability
    availableFrom: z.coerce.date().optional().nullable(),
    availableTo: z.coerce.date().optional().nullable(),

    // Conditions (form-based prerequisites)
    conditions: z.array(AccessConditionSchema).optional().nullable(),
    conditionLogic: z.enum(["AND", "OR"]).default("AND"),

    // Access-based prerequisites (array of access IDs)
    requiredAccessIds: z.array(z.string().uuid()).optional().default([]),

    // Display
    sortOrder: z.number().int().default(0),
    active: z.boolean().default(true),

    // Custom grouping (for OTHER type - allows custom group labels)
    groupLabel: z.string().max(100).optional().nullable(),

    // Companion option (show +1 question in registration form)
    allowCompanion: z.boolean().default(false),
    includedInBase: z.boolean().default(false),
    companionPrice: z.number().int().min(0).default(0),
  })
  .refine(
    (data) => {
      if (data.startsAt && data.endsAt) {
        return data.endsAt >= data.startsAt;
      }
      return true;
    },
    { message: "End time must be after start time", path: ["endsAt"] },
  );

export const UpdateEventAccessSchema = z
  .strictObject({
    type: AccessTypeSchema.optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional().nullable(),
    location: z.string().max(500).optional().nullable(),
    startsAt: z.coerce.date().optional().nullable(),
    endsAt: z.coerce.date().optional().nullable(),
    price: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    maxCapacity: z.number().int().positive().optional().nullable(),
    availableFrom: z.coerce.date().optional().nullable(),
    availableTo: z.coerce.date().optional().nullable(),
    conditions: z.array(AccessConditionSchema).optional().nullable(),
    conditionLogic: z.enum(["AND", "OR"]).optional(),
    requiredAccessIds: z.array(z.string().uuid()).optional(),
    sortOrder: z.number().int().optional(),
    active: z.boolean().optional(),
    groupLabel: z.string().max(100).optional().nullable(),
    allowCompanion: z.boolean().optional(),
    includedInBase: z.boolean().optional(),
    companionPrice: z.number().int().min(0).optional(),
  })
  .refine(hasUpdateField, {
    message: "At least one field must be provided for update",
  });

// ============================================================================
// Query Schemas
// ============================================================================

export const ListEventAccessQuerySchema = z.strictObject({
  active: z.preprocess(
    (v) => (v === "true" ? true : v === "false" ? false : undefined),
    z.boolean().optional(),
  ),
  type: AccessTypeSchema.optional(),
});

export const EventAccessIdParamSchema = z.strictObject({
  id: z.string().uuid(),
});

export const EventIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

// ============================================================================
// Grouped Access Response (Hierarchical: Date → Time Slots)
// ============================================================================

export const TimeSlotSchema = z.object({
  startsAt: z.date().nullable(),
  endsAt: z.date().nullable(),
  selectionType: z.enum(["single", "multiple"]),
  items: z.array(z.unknown()),
});

// Groups access items by date (day)
export const DateGroupSchema = z.object({
  dateKey: z.string(), // ISO date string (e.g., "2026-04-16") or "no-date"
  label: z.string(), // Formatted display label (e.g., "Jeudi 16 avril")
  slots: z.array(TimeSlotSchema),
});

export const GroupedAccessResponseSchema = z.object({
  groups: z.array(DateGroupSchema),
  addonGroup: z
    .object({
      items: z.array(z.unknown()),
    })
    .nullable(),
});

// ============================================================================
// Selection Schema (for registration)
// ============================================================================

export const AccessSelectionSchema = z.strictObject({
  accessId: z.string().uuid(),
  quantity: z.number().int().min(1).default(1),
});

// ============================================================================
// Public API Schemas
// ============================================================================

export const GetGroupedAccessBodySchema = z.strictObject({
  formData: z
    .record(z.string(), z.unknown())
    .refine((obj) => Object.keys(obj).length <= 100, "Too many fields")
    .optional()
    .default({}),
  selectedAccessIds: z.array(z.string().uuid()).optional().default([]),
});

export const ValidateAccessSelectionsBodySchema = z.strictObject({
  formData: z
    .record(z.string(), z.unknown())
    .refine((obj) => Object.keys(obj).length <= 100, "Too many fields"),
  selections: z.array(AccessSelectionSchema),
});

// ============================================================================
// Types
// ============================================================================

export type AccessType = z.infer<typeof AccessTypeSchema>;
export type CreateEventAccessInput = z.infer<typeof CreateEventAccessSchema>;
export type UpdateEventAccessInput = z.infer<typeof UpdateEventAccessSchema>;
export type AccessSelection = z.infer<typeof AccessSelectionSchema>;
export type TimeSlot = z.infer<typeof TimeSlotSchema>;
export type DateGroup = z.infer<typeof DateGroupSchema>;

export type GroupedAccessResponse = z.infer<typeof GroupedAccessResponseSchema>;
export type GetGroupedAccessBody = z.infer<typeof GetGroupedAccessBodySchema>;
export type ValidateAccessSelectionsBody = z.infer<
  typeof ValidateAccessSelectionsBodySchema
>;
