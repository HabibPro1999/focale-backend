import { describe, expect, it } from "vitest";
import {
  BADGE_SIZE_PRESETS,
  BadgeZonesSchema,
  CreateBadgeTemplateSchema,
  RegistrationBadgeQuerySchema,
  seedBadgeZones,
  UpdateBadgeTemplateSchema,
  type BadgeZone,
} from "./badges";

const text: BadgeZone = {
  kind: "text",
  id: "name",
  x: 5,
  y: 5,
  width: 90,
  height: 20,
  variable: "fullName",
  fontSize: null,
  fontWeight: "bold",
  color: "#000000",
  textAlign: "center",
};
const qr: BadgeZone = { kind: "qr", id: "qr", x: 30, y: 30, width: 40, height: 40 };

describe("badge zones", () => {
  it("accepts text zones beside exactly one QR zone, filling the text defaults", () => {
    const parsed = BadgeZonesSchema.parse([
      { kind: "text", id: "n", x: 0, y: 0, width: 50, height: 10, variable: "form_abc", fontSize: 12 },
      qr,
    ]);
    expect(parsed[0]).toEqual({
      kind: "text", id: "n", x: 0, y: 0, width: 50, height: 10, variable: "form_abc", fontSize: 12,
      fontWeight: "normal", color: "#000000", textAlign: "center",
    });
  });

  it("requires exactly one QR zone", () => {
    expect(BadgeZonesSchema.safeParse([text]).success).toBe(false);
    expect(BadgeZonesSchema.safeParse([]).success).toBe(false);
    expect(BadgeZonesSchema.safeParse([qr, { ...qr, id: "qr-2" }]).success).toBe(false);
    expect(BadgeZonesSchema.safeParse([text, qr]).success).toBe(true);
  });

  it("requires unique zone ids", () => {
    expect(BadgeZonesSchema.safeParse([text, { ...qr, id: "name" }]).success).toBe(false);
  });

  it("rejects an unknown kind, text keys on a QR zone and out-of-page boxes", () => {
    expect(BadgeZonesSchema.safeParse([qr, { ...qr, id: "i", kind: "image" }]).success).toBe(false);
    expect(BadgeZonesSchema.safeParse([{ ...qr, variable: "fullName" }]).success).toBe(false);
    expect(BadgeZonesSchema.safeParse([{ ...qr, x: 120 }]).success).toBe(false);
    expect(BadgeZonesSchema.safeParse([{ ...text, variable: "" }, qr]).success).toBe(false);
  });
});

describe("create and update", () => {
  it("defaults the page to the CARD preset and leaves the zones to the server's seed", () => {
    expect(CreateBadgeTemplateSchema.parse({ name: "Attendee" })).toEqual({
      name: "Attendee",
      widthMm: 90,
      heightMm: 55,
    });
  });

  it("accepts every preset and custom sizes within 40..210 mm", () => {
    for (const size of Object.values(BADGE_SIZE_PRESETS)) {
      expect(CreateBadgeTemplateSchema.safeParse({ name: "b", ...size }).success).toBe(true);
    }
    expect(CreateBadgeTemplateSchema.safeParse({ name: "b", widthMm: 40, heightMm: 210 }).success).toBe(true);
    expect(CreateBadgeTemplateSchema.safeParse({ name: "b", widthMm: 39.9, heightMm: 55 }).success).toBe(false);
    expect(CreateBadgeTemplateSchema.safeParse({ name: "b", widthMm: 90, heightMm: 211 }).success).toBe(false);
  });

  it("checks zones on create and update with the same rule", () => {
    expect(CreateBadgeTemplateSchema.safeParse({ name: "b", zones: [text] }).success).toBe(false);
    expect(UpdateBadgeTemplateSchema.safeParse({ zones: [text] }).success).toBe(false);
    expect(UpdateBadgeTemplateSchema.parse({ zones: [text, qr] }).zones).toEqual([text, qr]);
  });

  it("refuses an empty update, a blank name and unknown keys", () => {
    expect(UpdateBadgeTemplateSchema.safeParse({}).success).toBe(false);
    expect(UpdateBadgeTemplateSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(UpdateBadgeTemplateSchema.safeParse({ backgroundUrl: "x" }).success).toBe(false);
  });

  it("requires the badge id on the registration badge route", () => {
    expect(RegistrationBadgeQuerySchema.safeParse({}).success).toBe(false);
    expect(RegistrationBadgeQuerySchema.safeParse({ badgeId: "nope" }).success).toBe(false);
  });
});

describe("seedBadgeZones", () => {
  it.each(Object.entries(BADGE_SIZE_PRESETS))(
    "%s: a valid layout, the name along the top band and a square QR centred on the page",
    (_preset, { widthMm, heightMm }) => {
      const zones = seedBadgeZones(widthMm, heightMm);
      expect(BadgeZonesSchema.parse(zones)).toEqual(zones);

      const [name, code] = zones;
      expect(name).toMatchObject({ kind: "text", variable: "fullName", fontWeight: "bold", textAlign: "center" });
      expect(code!.kind).toBe("qr");

      // Square in millimetres, centred, below the name band.
      const mm = (zone: BadgeZone) => ({
        x: (zone.x / 100) * widthMm,
        y: (zone.y / 100) * heightMm,
        w: (zone.width / 100) * widthMm,
        h: (zone.height / 100) * heightMm,
      });
      const q = mm(code!);
      expect(Math.abs(q.w - q.h)).toBeLessThan(0.02);
      expect(Math.abs(q.x + q.w / 2 - widthMm / 2)).toBeLessThan(0.02);
      expect(Math.abs(q.y + q.h / 2 - heightMm / 2)).toBeLessThan(0.02);
      const n = mm(name!);
      expect(n.y + n.h).toBeLessThanOrEqual(q.y);
    },
  );
});
