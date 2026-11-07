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
      expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
      expect(allowed.headers["access-control-expose-headers"]).toBe("Retry-After");
      const denied = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { origin: "https://evil.example.com" },
      });
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
      expect(denied.headers["access-control-expose-headers"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

// Plugin behavior the deployed frontends depend on. These pin the CORS
// preflight methods, the helmet CSP/HSTS split and the 10 MB multipart limit
// so a plugin major cannot change them silently.
describe("buildApp plugin behavior", () => {
  const ORIGIN = "https://admin.example.com";
  const corsConfig = () =>
    parseAppConfig({ ...process.env, CORS_ORIGIN: `${ORIGIN},https://forms.example.com` });

  async function withApp<T>(
    config: ReturnType<typeof parseAppConfig>,
    run: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<T>,
  ): Promise<T> {
    const app = await buildApp(config);
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      return await run(app);
    } finally {
      await app.close();
    }
  }

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])(
    "passes a CORS preflight for %s from an allowed origin",
    async (method) => {
      await withApp(corsConfig(), async (app) => {
        const res = await app.inject({
          method: "OPTIONS",
          url: "/health/live",
          headers: {
            origin: ORIGIN,
            "access-control-request-method": method,
            "access-control-request-headers": "content-type,authorization",
          },
        });
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
        expect(res.headers["access-control-allow-credentials"]).toBe("true");
        const allowed = String(res.headers["access-control-allow-methods"])
          .split(",")
          .map((m) => m.trim());
        expect(allowed).toContain(method);
        expect(res.headers["access-control-allow-headers"]).toBe(
          "content-type,authorization",
        );
      });
    },
  );

  it("does not grant a CORS preflight to an unknown origin", async () => {
    await withApp(corsConfig(), async (app) => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/health/live",
        headers: {
          origin: "https://evil.example.com",
          "access-control-request-method": "DELETE",
        },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-methods"]).toBeUndefined();
    });
  });

  it("sends CSP and HSTS only in production", async () => {
    const config = corsConfig();
    await withApp({ ...config, isProduction: true }, async (app) => {
      const res = await app.inject({ method: "GET", url: "/health/live" });
      expect(res.headers["strict-transport-security"]).toBe(
        "max-age=31536000; includeSubDomains; preload",
      );
      expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
    await withApp({ ...config, isProduction: false }, async (app) => {
      const res = await app.inject({ method: "GET", url: "/health/live" });
      expect(res.headers["strict-transport-security"]).toBeUndefined();
      expect(res.headers["content-security-policy"]).toBeUndefined();
      expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    });
  });

  it("accepts a 10 MB multipart file and rejects one byte more with 413", async () => {
    const LIMIT = 10 * 1024 * 1024;
    const app = await buildApp(corsConfig());
    const fastify = app.getHttpAdapter().getInstance();
    // Raw Fastify route: exercises the registered plugin's default limit, not
    // a per-route override.
    fastify.post("/__test/upload", async (req) => {
      const file = await req.file();
      const buffer = await file!.toBuffer();
      return { size: buffer.length };
    });
    const upload = (size: number) => {
      const boundary = "----focale-test-boundary";
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        Buffer.alloc(size, 1),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({
        method: "POST",
        url: "/__test/upload",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
    };
    try {
      await app.init();
      await fastify.ready();
      const ok = await upload(LIMIT);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ size: LIMIT });
      const tooLarge = await upload(LIMIT + 1);
      expect(tooLarge.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });
});
