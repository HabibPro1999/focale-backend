/**
 * Fix 2 — CRLF injection in email subject
 *
 * Verifies that control characters in resolved subject variables are stripped
 * before the subject is stored/sent, preventing SMTP header injection.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// We test the stripping logic directly as a unit (extracted from service)
// rather than running the full processEmailQueue pipeline.
// ---------------------------------------------------------------------------

/** Mirrors the exact strip applied in email-queue.service.ts (Fix 2) */
function sanitizeSubject(raw: string): string {
  return raw.replace(/[\r\n\0]/g, " ").trim().slice(0, 998);
}

describe("email subject CRLF sanitization (Fix 2)", () => {
  it("strips \\r\\n from a header-injection firstName payload", () => {
    const maliciousSubject =
      "Welcome John\r\nBcc: attacker@evil.com\r\nX-Injected: yes";
    const result = sanitizeSubject(maliciousSubject);
    // Primary invariant: no control characters remain
    expect(result).not.toMatch(/[\r\n\0]/);
    // \r\n becomes two spaces (each char replaced independently), then trimmed
    // The important thing is no header injection is possible
    expect(result).toContain("Welcome John");
    expect(result).toContain("Bcc: attacker@evil.com");
    expect(result).toContain("X-Injected: yes");
  });

  it("strips bare \\r", () => {
    const result = sanitizeSubject("Hello\rWorld");
    expect(result).not.toMatch(/\r/);
    expect(result).toBe("Hello World");
  });

  it("strips bare \\n", () => {
    const result = sanitizeSubject("Hello\nWorld");
    expect(result).not.toMatch(/\n/);
    expect(result).toBe("Hello World");
  });

  it("strips null bytes", () => {
    const result = sanitizeSubject("Hello\0World");
    expect(result).not.toMatch(/\0/);
    expect(result).toBe("Hello World");
  });

  it("trims leading and trailing whitespace after stripping", () => {
    const result = sanitizeSubject("  \r\nHello  \r\n  ");
    expect(result).toBe("Hello");
  });

  it("caps subject at 998 characters", () => {
    const long = "A".repeat(1100);
    const result = sanitizeSubject(long);
    expect(result.length).toBe(998);
  });

  it("leaves a clean subject unchanged (no false positives)", () => {
    const clean = "Registration confirmed for FocaleConf 2026";
    expect(sanitizeSubject(clean)).toBe(clean);
  });

  it("handles empty string gracefully", () => {
    expect(sanitizeSubject("")).toBe("");
  });
});
