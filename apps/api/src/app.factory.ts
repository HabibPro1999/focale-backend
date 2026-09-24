import { isIP } from "node:net";
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
 * Explicit reverse-proxy peers whose forwarded headers Fastify may trust.
 * Numeric hop counts are deliberately rejected because they cannot validate
 * the address that connected to the API. Production must configure the real
 * proxy IP/CIDR list, or explicitly set TRUST_PROXY=false for direct traffic.
 */
export function trustedProxyAddresses(
  env: NodeJS.ProcessEnv = process.env,
): string[] | false {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        'TRUST_PROXY is required in production. Set it to a comma-separated list of trusted proxy IP/CIDR addresses, or "false" only when requests reach the API directly. Replace legacy hop counts with the actual proxy peer addresses; do not use "true" or wildcard trust.',
      );
    }
    return false;
  }

  if (raw.toLowerCase() === "false") return false;

  if (
    raw.toLowerCase() === "true" ||
    raw === "*" ||
    Number.isFinite(Number(raw))
  ) {
    throw new Error(
      `TRUST_PROXY value "${raw}" is unsafe or no longer supported. Set a comma-separated list of trusted proxy IP/CIDR addresses, or "false" only for direct traffic. Numeric hop counts cannot validate the connecting peer; wildcard trust is not allowed.`,
    );
  }

  const addresses = raw.split(",").map((address) => address.trim());
  if (
    addresses.some(
      (address) => !address || !isExplicitProxyAddress(address),
    )
  ) {
    throw new Error(
      `TRUST_PROXY must contain only explicit IP addresses or CIDRs separated by commas; wildcard trust, hostnames, empty entries, and /0 networks are not allowed (received "${raw}"). Configure the actual proxy peer addresses; do not use a hop count.`,
    );
  }

  return [...new Set(addresses)];
}

function isExplicitProxyAddress(value: string): boolean {
  const parts = value.split("/");
  if (parts.length > 2) return false;

  const [address, prefix] = parts;
  const family = isIP(address ?? "");
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;

  const bits = Number(prefix);
  const maxBits = family === 4 ? 32 : 128;
  // A zero-prefix CIDR trusts every possible peer and is equivalent to '*'.
  return Number.isInteger(bits) && bits > 0 && bits <= maxBits;
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
    new FastifyAdapter({ trustProxy: trustedProxyAddresses() }),
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

  app.enableShutdownHooks();
  return app;
}
