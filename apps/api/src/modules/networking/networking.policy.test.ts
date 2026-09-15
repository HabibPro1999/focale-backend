import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import {
  NetworkingListQuerySchema,
  NetworkingConfigSchema,
  NetworkingProfileUpdateSchema,
  NetworkingMessageSchema,
} from "@app/contracts";
import {
  networkingSearchMatches,
  networkingSlots,
  networkingPublicProfile,
  resourceQuanta,
  zonedInstant,
  csvCell,
} from "./networking.policy";
import {
  networkingTotp,
  issueNetworkingBadge,
  readNetworkingBadge,
} from "./networking.security";

describe("networking boundary policies", () => {
  it("parses multiple sectors and searches spelling and phonetic variants", () => {
    expect(
      NetworkingListQuerySchema.parse({
        sectors: "Finance,Health",
        city: "Tunis",
      }).sectors,
    ).toEqual(["Finance", "Health"]);
    expect(networkingSearchMatches("Mohammed", "Mohamed investor")).toBe(true);
    expect(networkingSearchMatches("medecin", "Médecin cardiologue")).toBe(
      true,
    );
    expect(networkingSearchMatches("engineer", "chef restaurant")).toBe(false);
  });
  it("generates UTC slots in event timezone and excludes closures", () => {
    const config = NetworkingConfigSchema.parse({
      timezone: "Africa/Tunis",
      openingHours: [{ date: "2031-04-05", start: "09:00", end: "10:30" }],
      blackoutSlots: ["2031-04-05T08:30:00Z"],
    });
    expect(
      networkingSlots(config, {
        startDate: new Date("2031-04-05T00:00Z"),
        endDate: new Date("2031-04-06T00:00Z"),
      }),
    ).toEqual(["2031-04-05T08:00:00.000Z", "2031-04-05T09:00:00.000Z"]);
  });
  it("rejects a nonexistent DST wall time", () => {
    expect(() =>
      zonedInstant("2031-03-09", "02:30", "America/New_York"),
    ).toThrow("Nonexistent");
  });
  it("overlapping intervals share reservation quanta", () => {
    const a = resourceQuanta(
      new Date("2031-01-01T09:00Z"),
      new Date("2031-01-01T09:30Z"),
    ).map((d) => d.getTime());
    const b = resourceQuanta(
      new Date("2031-01-01T09:27Z"),
      new Date("2031-01-01T09:57Z"),
    ).map((d) => d.getTime());
    expect(a.some((t) => b.includes(t))).toBe(true);
  });
  it("strips private profile fields from discovery", () => {
    const profile = networkingPublicProfile({
      id: "profile",
      email: "private",
      registrationId: "registration",
      status: "ACTIVE",
      overrides: { secret: true },
      language: "fr",
      emailPreference: "OFF",
      consentAt: new Date(),
      withdrawnAt: null,
      availabilitySet: false,
      firstName: "Public",
    });
    expect(profile).toEqual({ id: "profile", firstName: "Public" });
  });
  it("rejects unsafe profile URLs and messages over 1000 characters", () => {
    expect(
      NetworkingProfileUpdateSchema.safeParse({
        website: "javascript:alert(1)",
      }).success,
    ).toBe(false);
    expect(
      NetworkingMessageSchema.safeParse({
        body: "x".repeat(1001),
        clientMessageId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      NetworkingProfileUpdateSchema.safeParse({ status: "ACTIVE" }).success,
    ).toBe(false);
  });
  it("binds signed badges to their event and rejects tampering", () => {
    process.env.NETWORKING_TOKEN_SECRET =
      "test-secret-for-networking-at-least-32-characters";
    const badge = issueNetworkingBadge("participant", "event");
    expect(readNetworkingBadge(badge.token, "event")).toBe("participant");
    expect(() => readNetworkingBadge(badge.token, "other")).toThrow(BadRequestException);
    expect(() => readNetworkingBadge(badge.token + "x", "event")).toThrow(BadRequestException);
    let invalid: unknown;
    try { readNetworkingBadge("invalid-demo-token", "event"); } catch (error) { invalid = error; }
    expect(invalid).toBeInstanceOf(BadRequestException);
    expect((invalid as BadRequestException).getStatus()).toBe(400);
    expect((invalid as BadRequestException).getResponse()).toMatchObject({ code: "NETWORKING_BADGE_INVALID" });
  });
  it("implements the RFC 4226 HOTP vector underlying TOTP", () => {
    expect(networkingTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 0)).toBe(
      "755224",
    );
  });
  it("escapes spreadsheet formula injection", () => {
    expect(csvCell('=HYPERLINK("https://evil.example")')).toBe(
      '"\'=HYPERLINK(""https://evil.example"")"',
    );
  });
});
