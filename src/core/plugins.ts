import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import { config } from "@config/app.config.js";
import type { AppInstance } from "@shared/fastify.js";

export async function registerPlugins(app: AppInstance) {
  // Multipart file uploads (10MB limit)
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });
  // Sensible defaults and HTTP error utilities
  await app.register(sensible, {
    sharedSchemaId: "HttpError",
  });

  // CORS configuration with production safety check
  if (config.isProduction && config.CORS_ORIGIN === "*") {
    throw new Error(
      "CORS wildcard (*) is not allowed in production. Set CORS_ORIGIN to specific origins.",
    );
  }

  await app.register(cors, {
    origin: (origin, callback) => {
      // Parse allowed origins (comma-separated in env)
      const allowedOrigins = config.CORS_ORIGIN.split(",").map((o) => o.trim());

      // Allow requests with no origin (same-origin, curl, etc.) or matching origins
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

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: config.isProduction,
    strictTransportSecurity: config.isProduction
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });

  // Global rate limiting
  await app.register(rateLimit, {
    max: config.security.rateLimit.max,
    timeWindow: config.security.rateLimit.timeWindow,
  });
}
