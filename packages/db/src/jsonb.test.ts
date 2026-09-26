import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StoredCertificateZonesSchema,
  StoredEmailContextSnapshotSchema,
  StoredPricingRulesSchema,
} from "@app/contracts";

const mocks = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock("@app/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/shared")>();
  return { ...actual, createLogger: () => mocks.log };
});

import { configureDb } from "./client";
import {
  StoredJsonError,
  configureJsonbValidation,
  getJsonbValidationMode,
  parseJsonb,
  resetStoredJsonWarnings,
} from "./jsonb";

const SECRET = "registrant-secret-value";
const zone = {
  id: "z1",
  x: 10,
  y: 20,
  width: 50,
  height: 10,
  variable: "fullName",
  fontSize: null,
  fontWeight: "bold",
  color: "#000000",
  textAlign: "center",
};
// An unknown key holding a value and a wrong-typed value: both must stay out of logs/errors.
const invalidZones = [{ ...zone, variable: 42, legacyNote: SECRET }];

beforeEach(() => {
  vi.clearAllMocks();
  resetStoredJsonWarnings();
});

afterEach(() => {
  configureJsonbValidation(undefined);
  vi.unstubAllEnvs();
});

describe("parseJsonb, valid documents", () => {
  it.each(["warn", "enforce"] as const)("returns the stored value itself under %s, without logging", (mode) => {
    configureJsonbValidation(mode);
    const zones = [zone];
    expect(parseJsonb(StoredCertificateZonesSchema, zones, { column: "certificate_templates.zones", id: "t1" })).toBe(zones);
    const snapshot = { firstName: "Ada" };
    expect(parseJsonb(StoredEmailContextSnapshotSchema, snapshot, { column: "email_logs.context_snapshot" })).toBe(snapshot);
    expect(parseJsonb(StoredEmailContextSnapshotSchema, null, { column: "email_logs.context_snapshot" })).toBeNull();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });
});

describe("parseJsonb under JSONB_VALIDATION=warn", () => {
  beforeEach(() => configureJsonbValidation("warn"));

  it("returns the invalid value exactly as stored (same reference) and logs where, never what", () => {
    const result = parseJsonb(StoredCertificateZonesSchema, invalidZones, {
      column: "certificate_templates.zones",
      id: "t1",
    });

    expect(result).toBe(invalidZones);
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    const [details, message] = mocks.log.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(details).toEqual({
      column: "certificate_templates.zones",
      rowId: "t1",
      issueCount: 2,
      issues: [
        { path: "[0].variable", code: "invalid_type" },
        { path: "[0].legacyNote", code: "unrecognized_keys" },
      ],
      jsonbValidation: "warn",
    });
    expect(message).toContain("JSONB_VALIDATION=warn");
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain(SECRET);
  });

  it("logs a given document's issues once per process, and each other row or issue set again", () => {
    const where = { column: "certificate_templates.zones", id: "t1" };
    parseJsonb(StoredCertificateZonesSchema, invalidZones, where);
    parseJsonb(StoredCertificateZonesSchema, invalidZones, where);
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);

    parseJsonb(StoredCertificateZonesSchema, invalidZones, { ...where, id: "t2" });
    parseJsonb(StoredPricingRulesSchema, [{}], { column: "event_pricing.rules", id: "t1" });
    expect(mocks.log.warn).toHaveBeenCalledTimes(3);
  });
});

describe("parseJsonb under JSONB_VALIDATION=enforce", () => {
  beforeEach(() => configureJsonbValidation("enforce"));

  it("refuses an invalid document with its column, row id and issue paths, never its values", () => {
    let thrown: unknown;
    try {
      parseJsonb(StoredCertificateZonesSchema, invalidZones, { column: "certificate_templates.zones", id: "t1" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StoredJsonError);
    const error = thrown as StoredJsonError;
    expect(error.column).toBe("certificate_templates.zones");
    expect(error.rowId).toBe("t1");
    expect(error.issues).toEqual([
      { path: "[0].variable", code: "invalid_type" },
      { path: "[0].legacyNote", code: "unrecognized_keys" },
    ]);
    expect(error.message).toBe(
      "Stored JSON certificate_templates.zones (id t1) does not match its schema: [0].variable (invalid_type), [0].legacyNote (unrecognized_keys)",
    );
    expect(error.message).not.toContain(SECRET);
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it("refuses a document that is only missing a defaulted key", () => {
    const { fontWeight: _fontWeight, ...withoutWeight } = zone;
    expect(() =>
      parseJsonb(StoredCertificateZonesSchema, [withoutWeight], { column: "certificate_templates.zones" }),
    ).toThrow("Stored JSON certificate_templates.zones does not match its schema: [0].fontWeight (missing_default)");
  });
});

describe("JSONB_VALIDATION mode", () => {
  it("comes from configureDb (the parsed app config)", () => {
    configureDb({ applicationName: "focale", jsonbValidation: "enforce" });
    expect(getJsonbValidationMode()).toBe("enforce");
    configureDb({ applicationName: "focale", jsonbValidation: "warn" });
    expect(getJsonbValidationMode()).toBe("warn");
  });

  it("falls back to the environment for tools and tests, defaulting to warn", () => {
    configureJsonbValidation(undefined);
    vi.stubEnv("JSONB_VALIDATION", "");
    expect(getJsonbValidationMode()).toBe("warn");

    configureJsonbValidation(undefined);
    vi.stubEnv("JSONB_VALIDATION", "enforce");
    expect(getJsonbValidationMode()).toBe("enforce");

    configureJsonbValidation(undefined);
    vi.stubEnv("JSONB_VALIDATION", "sometimes");
    expect(() => getJsonbValidationMode()).toThrow("JSONB_VALIDATION must be one of: warn, enforce");
  });
});
