import { z } from "zod";

// ============================================================================
// Shared Types
// ============================================================================

export const AccessConditionSchema = z
  .object({
    fieldId: z.string().min(1),
    operator: z.enum(["equals", "not_equals"]),
    value: z.union([z.string(), z.number()]),
  })
  .strict();

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
]);

// ============================================================================
// Create/Update Schemas
// ============================================================================

export const CreateEventAccessSchema = z
  .object({
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
  })
  .strict()
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
  .object({
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
  })
  .strict();

// ============================================================================
// Query Schemas
// ============================================================================

export const ListEventAccessQuerySchema = z
  .object({
    active: z.preprocess(
      (v) => (v === "true" ? true : v === "false" ? false : undefined),
      z.boolean().optional(),
    ),
    type: AccessTypeSchema.optional(),
  })
  .strict();

export const EventAccessIdParamSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export { EventIdParamSchema } from "@shared/schemas/params.js";

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
});

// ============================================================================
// Selection Schema (for registration)
// ============================================================================

export const AccessSelectionSchema = z
  .object({
    accessId: z.string().uuid(),
    quantity: z.number().int().min(1).default(1),
  })
  .strict();

// ============================================================================
// Public API Schemas
// ============================================================================

export const GetGroupedAccessBodySchema = z
  .object({
    formData: z.record(z.string(), z.any()).optional().default({}),
    selectedAccessIds: z.array(z.string().uuid()).optional().default([]),
  })
  .strict();

export const ValidateAccessSelectionsBodySchema = z
  .object({
    formData: z.record(z.string(), z.any()),
    selections: z.array(AccessSelectionSchema),
  })
  .strict();

// ============================================================================
// Types
// ============================================================================

export type AccessType = z.infer<typeof AccessTypeSchema>;
export type AccessCondition = z.infer<typeof AccessConditionSchema>;
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
