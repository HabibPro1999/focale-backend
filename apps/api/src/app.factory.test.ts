import { describe, expect, it } from "vitest";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { parseAppConfig, resolveTrustProxy } from "@app/contracts";
import { buildApp } from "./app.factory";

// TRUST_PROXY parsing and its production rules live in the config schema
// (packages/contracts/src/trust-proxy.test.ts); buildApp passes the parsed
// value straight to Fastify.
describe("TRUST_PROXY", () => {
  it("honors X-Forwarded-For only from a configured immediate peer", async () => {
    const trustedPeerFastify = new FastifyAdapter({
      trustProxy: resolveTrustProxy("127.0.0.0/8"),
    }).getInstance();
    trustedPeerFastify.get("/client-ip", async (request) => ({ ip: request.ip }));

    const untrustedPeerFastify = new FastifyAdapter({
      trustProxy: resolveTrustProxy("192.0.2.1"),
    }).getInstance();
    untrustedPeerFastify.get("/client-ip", async (request) => ({ ip: request.ip }));

    try {
      const headers = { "x-forwarded-for": "198.51.100.24" };
      const trustedResponse = await trustedPeerFastify.inject({
        method: "GET",
        url: "/client-ip",
        remoteAddress: "127.0.0.1",
        headers,
      });
      const untrustedResponse = await untrustedPeerFastify.inject({
        method: "GET",
        url: "/client-ip",
        remoteAddress: "203.0.113.9",
        headers,
      });

      expect(trustedResponse.json()).toEqual({ ip: "198.51.100.24" });
      expect(untrustedResponse.json()).toEqual({ ip: "203.0.113.9" });
    } finally {
      await Promise.all([
        trustedPeerFastify.close(),
        untrustedPeerFastify.close(),
      ]);
    }
  });
});

describe("unit-test environment", () => {
  it("replaces an inherited database URL with the local dummy URL", () => {
    expect(process.env.DATABASE_URL).toBe(
      "postgresql://test_user:test_password@localhost:5432/focale_unit_test",
    );
  });
});

describe("buildApp config wiring", () => {
  it("allows only the configured CORS origins", async () => {
    const config = parseAppConfig({
      ...process.env,
      CORS_ORIGIN: "https://admin.example.com/, https://forms.example.com",
    });
    const app = await buildApp(config);
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const allowed = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { origin: "https://admin.example.com" },
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://admin.example.com");
      const denied = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { origin: "https://evil.example.com" },
      });
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
