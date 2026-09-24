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
import { getConfig, type Config } from "./core/config";
import { requestContext } from "./core/request-context";

/** Build the fully-wired Nest+Fastify app (plugins, requestId hook). Shared by main.ts and tests. */
export async function buildApp(
  config: Config = getConfig(),
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    // TRUST_PROXY is validated by the config schema (fail closed in production).
    new FastifyAdapter({ trustProxy: config.http.trustProxy }),
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

  // CORS allow-list (validated origins; `*` only outside production), no-origin
  // requests allowed, credentials always on.
  const { allowAnyOrigin, origins: allowedOrigins } = config.http.cors;
  await fastify.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowAnyOrigin || allowedOrigins.includes(origin)) {
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
