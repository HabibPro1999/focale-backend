import { describe, expect, it } from "vitest";
import { checkProductionConfig, formatProductionConfigReport } from "./config-check";

const SECRET = "planted-secret-7c1e";

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DATABASE_URL: `postgresql://user:${SECRET}@db.internal:26257/app`,
    CORS_ORIGIN: "https://admin.example.com",
    TRUST_PROXY: "10.0.0.0/24",
    ADMIN_APP_URL: "https://admin.example.com",
    PUBLIC_FORMS_URL: "https://forms.example.com",
    PUBLIC_LINK_ALLOWED_ORIGINS: "https://forms.example.com",
    FIREBASE_PROJECT_ID: "demo-project",
    FIREBASE_STORAGE_BUCKET: "demo-bucket",
    SENDGRID_API_KEY: SECRET,
    EMAIL_FROM_EMAIL: "noreply@example.com",
    NETWORKING_TOKEN_SECRET: `${SECRET}-${"x".repeat(32)}`,
    ...overrides,
  };
}

describe("checkProductionConfig (operator pre-deploy check)", () => {
  it("passes a complete production environment", () => {
    const report = checkProductionConfig(productionEnv());
    expect(report).toEqual({ ok: true, issues: [], nodeEnvOverridden: false });
    expect(formatProductionConfigReport(report)).toContain("passed");
  });

  it("applies the production rules even when NODE_ENV is not production", () => {
    const report = checkProductionConfig(productionEnv({ NODE_ENV: "development", TRUST_PROXY: undefined }));
    expect(report.ok).toBe(false);
    expect(report.nodeEnvOverridden).toBe(true);
    expect(report.issues.map((issue) => issue.key)).toEqual(["TRUST_PROXY"]);
    expect(formatProductionConfigReport(report)).toContain("NODE_ENV here is not production");
  });

  it("lists failing keys with rule text and never prints values", () => {
    const report = checkProductionConfig(
      productionEnv({
        SENDGRID_API_KEY: undefined,
        CORS_ORIGIN: `https://${SECRET}.example.com,*`,
        TRUST_PROXY: SECRET,
        NETWORKING_TOKEN_SECRET: SECRET,
        FIREBASE_SERVICE_ACCOUNT: SECRET,
        DATABASE_URL: SECRET,
        PUBLIC_FORMS_URL: undefined,
      }),
    );
    const output = formatProductionConfigReport(report);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.key).sort()).toEqual(
      [
        "CORS_ORIGIN",
        "DATABASE_URL",
        "FIREBASE_SERVICE_ACCOUNT",
        "NETWORKING_TOKEN_SECRET",
        "PUBLIC_FORMS_URL",
        "SENDGRID_API_KEY",
        "TRUST_PROXY",
      ].sort(),
    );
    expect(output).toContain("7 key(s) need attention");
    for (const key of ["SENDGRID_API_KEY", "PUBLIC_FORMS_URL", "TRUST_PROXY"]) {
      expect(output).toContain(`  - ${key}: `);
    }
    expect(output).not.toContain(SECRET);
  });
});
