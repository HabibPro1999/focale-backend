import { describe, expect, it } from "vitest";
import { maskEmail } from "./pii";

describe("maskEmail", () => {
  it("keeps the first local character and the domain", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail("b@clinic.tn")).toBe("b***@clinic.tn");
  });

  it("splits on the last @ and keeps the domain verbatim", () => {
    expect(maskEmail('"a@b"@example.com')).toBe('"***@example.com');
    expect(maskEmail("Élodie@Example.COM")).toBe("É***@Example.COM");
  });

  it("never returns the local part for malformed input", () => {
    expect(maskEmail("no-at-sign")).toBe("***");
    expect(maskEmail("@example.com")).toBe("***@example.com");
    expect(maskEmail("")).toBe("***");
  });
});
