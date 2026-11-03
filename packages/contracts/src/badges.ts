import { z } from "zod";
import { hasUpdateField } from "./zod-helpers";

// Badges module Zod contracts. A badge template is an event's printable
// registrant badge: a page in millimetres, an optional background image and
// its zones (variable text, and exactly one check-in QR code). It is rendered
// as a PDF for print and as an email attachment (REGISTRATION_BADGE).

// ============================================================================
// Page size
// ============================================================================

/** Smallest and largest page side, in millimetres. */
export const BADGE_MIN_MM = 40;
export const BADGE_MAX_MM = 210;

/**
 * The page sizes the admin offers at create (width x height, millimetres).
 * Only `widthMm`/`heightMm` are stored: a preset is a UI convenience, and
 * CUSTOM is any pair within BADGE_MIN_MM..BADGE_MAX_MM.
 */
export const BADGE_SIZE_PRESETS = {
  CARD: { widthMm: 90, heightMm: 55 },
  CR80: { widthMm: 85.6, heightMm: 54 },
  A6: { widthMm: 105, heightMm: 148 },
  LANYARD: { widthMm: 100, heightMm: 140 },
} as const;
export type BadgeSizePreset = keyof typeof BADGE_SIZE_PRESETS | "CUSTOM";
export const DEFAULT_BADGE_SIZE = BADGE_SIZE_PRESETS.CARD;

const BadgeSideMmSchema = z.number().min(BADGE_MIN_MM).max(BADGE_MAX_MM);

// ============================================================================
// Zones
// ============================================================================

/** Position and size in percent of the page, top-left origin (as certificates). */
const zoneBoxShape = {
  id: z.string().min(1).max(64),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(0).max(100),
  height: z.number().min(0).max(100),
};

/**
 * Variable text. `variable` is an email variable id (`fullName`,
 * `registrationNumber`, `form_<fieldId>`, ...), resolved from the email
 * context of the registration; a missing or empty value draws nothing.
 * The text fields are the certificate zone's.
 */
export const BadgeTextZoneSchema = z.strictObject({
  kind: z.literal("text"),
  ...zoneBoxShape,
  variable: z.string().min(1).max(200),
  fontSize: z.number().min(1).nullable(), // null = auto-fit
  fontWeight: z.enum(["normal", "bold"]).default("normal"),
  color: z.string().default("#000000"),
  textAlign: z.enum(["left", "center", "right"]).default("center"),
});

/**
 * The registration's check-in QR code: a square of min(width, height),
 * centred in the zone (quiet zone included), in vector modules.
 */
export const BadgeQrZoneSchema = z.strictObject({
  kind: z.literal("qr"),
  ...zoneBoxShape,
});

export const BadgeZoneSchema = z.discriminatedUnion("kind", [
  BadgeTextZoneSchema,
  BadgeQrZoneSchema,
]);

/** A badge's zones: unique ids, and exactly one QR zone (every badge carries the check-in QR). */
export const BadgeZonesSchema = z
  .array(BadgeZoneSchema)
  .max(50)
  .superRefine((zones, ctx) => {
    if (zones.filter((zone) => zone.kind === "qr").length !== 1) {
      ctx.addIssue({ code: "custom", message: "A badge needs exactly one QR zone" });
    }
    if (new Set(zones.map((zone) => zone.id)).size !== zones.length) {
      ctx.addIssue({ code: "custom", message: "Zone ids must be unique" });
    }
  });

/** The stored `badge_templates.zones` document (plan 5.2): zones as the write routes store them. */
export const StoredBadgeZonesSchema = BadgeZonesSchema;

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The zones a new badge starts with: the full name in bold, centred, along
 * the top band, and a QR code centred on the page. Both are sized from the
 * shorter page side, and the QR zone is square in millimetres (its
 * percentages follow the page's aspect ratio).
 */
export function seedBadgeZones(widthMm: number, heightMm: number): BadgeZone[] {
  const shortSide = Math.min(widthMm, heightMm);
  const qrSide = shortSide * 0.45;
  const qrWidth = round2((qrSide / widthMm) * 100);
  const qrHeight = round2((qrSide / heightMm) * 100);
  return [
    {
      kind: "text",
      id: "full-name",
      x: 5,
      y: round2(((shortSide * 0.06) / heightMm) * 100),
      width: 90,
      height: round2(((shortSide * 0.18) / heightMm) * 100),
      variable: "fullName",
      fontSize: null,
      fontWeight: "bold",
      color: "#000000",
      textAlign: "center",
    },
    {
      kind: "qr",
      id: "qr",
      x: round2((100 - qrWidth) / 2),
      y: round2((100 - qrHeight) / 2),
      width: qrWidth,
      height: qrHeight,
    },
  ];
}

// ============================================================================
// Create / Update
// ============================================================================

/** Create a badge: the page defaults to the CARD preset; zones default to seedBadgeZones. */
export const CreateBadgeTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  widthMm: BadgeSideMmSchema.default(DEFAULT_BADGE_SIZE.widthMm),
  heightMm: BadgeSideMmSchema.default(DEFAULT_BADGE_SIZE.heightMm),
  zones: BadgeZonesSchema.optional(),
});

export const UpdateBadgeTemplateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    widthMm: BadgeSideMmSchema.optional(),
    heightMm: BadgeSideMmSchema.optional(),
    zones: BadgeZonesSchema.optional(),
  })
  .refine(hasUpdateField, {
    message: "At least one field must be provided for update",
  });

// ============================================================================
// Params / Query
// ============================================================================

export const BadgeEventIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const BadgeIdParamSchema = z.strictObject({
  id: z.string().uuid(),
});

export const BadgeRegistrationIdParamSchema = z.strictObject({
  registrationId: z.string().uuid(),
});

/** GET .../registrations/:registrationId/badge.pdf?badgeId= */
export const RegistrationBadgeQuerySchema = z.strictObject({
  badgeId: z.string().uuid(),
});

// ============================================================================
// Responses
// ============================================================================

/**
 * A badge template as the API returns it. The background fields are null
 * until an image is uploaded; `backgroundUrl` is the public original (the
 * admin canvas reads it through GET badges/:id/background).
 */
export const BadgeTemplateResponseSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  name: z.string(),
  widthMm: z.number(),
  heightMm: z.number(),
  backgroundUrl: z.string().nullable(),
  backgroundWidth: z.number().int().nullable(),
  backgroundHeight: z.number().int().nullable(),
  zones: z.array(BadgeZoneSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const BadgeTemplateListResponseSchema = z.array(BadgeTemplateResponseSchema);

// ============================================================================
// Types
// ============================================================================

export type BadgeTextZone = z.infer<typeof BadgeTextZoneSchema>;
export type BadgeQrZone = z.infer<typeof BadgeQrZoneSchema>;
export type BadgeZone = z.infer<typeof BadgeZoneSchema>;
export type StoredBadgeZones = z.infer<typeof StoredBadgeZonesSchema>;
export type CreateBadgeTemplateInput = z.infer<typeof CreateBadgeTemplateSchema>;
export type UpdateBadgeTemplateInput = z.infer<typeof UpdateBadgeTemplateSchema>;
export type BadgeTemplate = z.infer<typeof BadgeTemplateResponseSchema>;
