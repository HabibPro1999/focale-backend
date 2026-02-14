import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { registerPlugins } from "./plugins.js";
import { registerHooks } from "./hooks.js";
import { errorHandler } from "@shared/middleware/error.middleware.js";
import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";
import { usersRoutes } from "@identity";
import { clientsRoutes } from "@clients";
import { eventsRoutes } from "@events";
import { formsRoutes, formsPublicRoutes } from "@forms";
import { pricingRulesRoutes, pricingPublicRoutes } from "@pricing";
import { accessRoutes, accessPublicRoutes } from "@access";
import {
  registrationsRoutes,
  registrationsPublicRoutes,
  registrationEditPublicRoutes,
} from "@registrations";
import { reportsRoutes } from "@reports";
import { emailRoutes, emailWebhookRoutes } from "@email";
import {
  sponsorshipsRoutes,
  sponsorshipDetailRoutes,
  registrationSponsorshipsRoutes,
  sponsorshipsPublicRoutes,
  sponsorshipsPublicBySlugRoutes,
} from "@sponsorships";
import type { AppInstance } from "@shared/types/fastify.js";

export async function buildServer(): Promise<AppInstance> {
  const app = Fastify({
    loggerInstance: logger,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Decorate with prisma
  app.decorate("prisma", prisma);

  // Register plugins (CORS, Helmet, Rate Limit)
  await registerPlugins(app);

  // Register lifecycle hooks
  registerHooks(app);

  // Enhanced health check with detailed diagnostics
  app.get("/health", async (_request, reply) => {
    const startTime = Date.now();

    const checks: Record<
      string,
      {
        status: "healthy" | "unhealthy" | "degraded";
        latencyMs?: number;
        error?: string;
      }
    > = {};

    // Database check with latency measurement
    try {
      const dbStart = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      checks.database = {
        status: "healthy",
        latencyMs: Date.now() - dbStart,
      };
    } catch (error) {
      checks.database = {
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }

    // Memory check
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const heapPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    checks.memory = {
      status: heapPercent > 90 ? "degraded" : "healthy",
      latencyMs: heapUsedMB, // Using this field to report heap usage in MB
    };

    // Determine overall status
    const hasUnhealthy = Object.values(checks).some(
      (c) => c.status === "unhealthy",
    );
    const hasDegraded = Object.values(checks).some(
      (c) => c.status === "degraded",
    );

    const overallStatus = hasUnhealthy
      ? "unhealthy"
      : hasDegraded
        ? "degraded"
        : "healthy";
    const statusCode = hasUnhealthy ? 503 : 200;

    return reply.status(statusCode).send({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      responseTimeMs: Date.now() - startTime,
      memory: {
        heapUsedMB,
        heapTotalMB,
        heapPercent: Math.round(heapPercent),
      },
      checks,
      version: process.env.npm_package_version || "1.0.0",
    });
  });

  // Liveness probe (Kubernetes-style) - simple "am I running?" check
  app.get("/health/live", async (_request, reply) => {
    return reply.send({ status: "ok" });
  });

  // Readiness probe - "am I ready to accept traffic?"
  app.get("/health/ready", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: "ready" });
    } catch {
      return reply.status(503).send({ status: "not ready" });
    }
  });

  // Register module routes
  await app.register(usersRoutes, { prefix: "/api/users" });
  await app.register(clientsRoutes, { prefix: "/api/clients" });
  await app.register(eventsRoutes, { prefix: "/api/events" });
  await app.register(formsRoutes, { prefix: "/api/forms" });
  await app.register(formsPublicRoutes, { prefix: "/api/forms/public" });

  // Pricing routes
  await app.register(pricingRulesRoutes, { prefix: "/api/events" });
  await app.register(pricingPublicRoutes, { prefix: "/api" });

  // Access routes (replaces eventExtrasRoutes)
  await app.register(accessRoutes, { prefix: "/api/events" });
  await app.register(accessPublicRoutes, { prefix: "/api/public/events" });

  // Registration routes
  await app.register(registrationsRoutes, { prefix: "/api/events" });
  await app.register(registrationsPublicRoutes, {
    prefix: "/api/public/forms",
  });
  await app.register(registrationEditPublicRoutes, {
    prefix: "/api/public/registrations",
  });

  // Reports routes (financial reporting)
  await app.register(reportsRoutes, { prefix: "/api/events" });

  // Email routes (templates and campaigns)
  await app.register(emailRoutes, { prefix: "/api/events" });

  // Email webhook (SendGrid Event Webhook - no auth)
  await app.register(emailWebhookRoutes, { prefix: "/api/webhooks/sendgrid" });

  // Sponsorship routes
  await app.register(sponsorshipsRoutes, { prefix: "/api/events" });
  await app.register(sponsorshipDetailRoutes, { prefix: "/api/sponsorships" });
  await app.register(registrationSponsorshipsRoutes, {
    prefix: "/api/registrations",
  });
  await app.register(sponsorshipsPublicRoutes, {
    prefix: "/api/public/events",
  });
  await app.register(sponsorshipsPublicBySlugRoutes, {
    prefix: "/api/public/events",
  });

  // Global error handler
  app.setErrorHandler(errorHandler);

  return app;
}
