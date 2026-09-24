import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { newId } from "@app/shared";
import { AppModule } from "./app.module";
import { loadConfig, type Config } from "./core/config";
import { requestContext } from "./core/request-context";

/**
 * Reverse-proxy hops whose X-Forwarded-For entries are trusted for `req.ip` (venue rate limits key on it).
 * Required in production; unset elsewhere means the socket address.
 */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number | false {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) {
    if (env.NODE_ENV === "production")
      throw new Error("TRUST_PROXY must be set in production to the number of reverse-proxy hops in front of the API (for example 1).");
    return false;
  }
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0)
    throw new Error(`TRUST_PROXY must be a non-negative integer hop count, got "${raw}".`);
  return hops;
}

/** Build the fully-wired Nest+Fastify app (plugins, requestId hook). Shared by main.ts and tests. */
export async function buildApp(
  config: Config = loadConfig(),
): Promise<NestFastifyApplication> {
  // Legacy parity: wildcard CORS is forbidden in production (checked before registration).
  if (config.isProduction && config.CORS_ORIGIN === "*") {
    throw new Error(
      "CORS wildcard (*) is not allowed in production. Set CORS_ORIGIN to specific origins.",
    );
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: trustProxyHops() }),
    // rawBody: webhook controllers verify provider signatures over exact wire bytes.
    { bufferLogs: true, rawBody: true },
  );

  const fastify = app.getHttpAdapter().getInstance();

  // requestId context + response header, before Nest handlers run.
  fastify.addHook("onRequest", (req, reply, done) => {
    const incoming = req.headers["x-request-id"];
    const requestId =
      (Array.isArray(incoming) ? incoming[0] : incoming) || newId();
    void reply.header("x-request-id", requestId);
    requestContext.enterWith({ requestId });
    done();
  });

  // Multipart uploads (banner, payment proof, certificate image, abstract file) — 10MB, legacy limit.
  await fastify.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: config.isProduction,
    strictTransportSecurity: config.isProduction
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });

  // Legacy CORS: comma-split allow-list, no-origin requests allowed, credentials always on.
  await fastify.register(cors, {
    origin: (origin, callback) => {
      const allowedOrigins = config.CORS_ORIGIN.split(",").map((o) => o.trim());
      if (
        !origin ||
        allowedOrigins.includes("*") ||
        allowedOrigins.includes(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"), false);
      }
    },
    credentials: true,
  });

  await fastify.register(cookie);

  // No app.enableShutdownHooks(): main.ts owns SIGTERM/SIGINT so the app is
  // closed exactly once, followed by the database pool.
  return app;
}
