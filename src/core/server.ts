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
import { eventsRoutes, eventsPublicRoutes } from "@events";
import { formsRoutes, formsPublicRoutes } from "@forms";
import { pricingRulesRoutes, pricingPublicRoutes } from "@pricing";
import { accessRoutes, accessPublicRoutes } from "@access";
import {
  registrationsRoutes,
  registrationsPublicRoutes,
  registrationEditPublicRoutes,
} from "@registrations";
import { reportsRoutes } from "@reports";
import { emailRoutes, emailWebhookRoutes, getEmailQueueHealth } from "@email";
import {
  sponsorshipsRoutes,
  sponsorshipDetailRoutes,
  registrationSponsorshipsRoutes,
  sponsorshipsPublicRoutes,
  sponsorshipsPublicBySlugRoutes,
} from "@sponsorships";
import { certificatesRoutes } from "@certificates";
import type { AppInstance } from "@shared/types/fastify.js";

export async function buildServer(): Promise<AppInstance> {
  const app = Fastify({
    loggerInstance: logger,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Disconnect prisma on server close — registered early so it fires last (child hooks
  // run before parent hooks in Fastify's onClose ordering), ensuring all plugin-level
  // onClose hooks that might use Prisma complete before the connection is dropped.
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
    logger.info("Database disconnected");
  });

  // Register plugins (CORS, Helmet, Rate Limit)
  await registerPlugins(app);

  // Register lifecycle hooks
  registerHooks(app);

  // Set error handler before route registrations so it applies to all
  // encapsulated scopes, including any future scoped plugins.
  app.setErrorHandler(errorHandler);

  // Health check — minimal public surface to avoid information disclosure
  app.get("/health", async (_request, reply) => {
    let dbStatus: "healthy" | "unhealthy" = "healthy";

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = "unhealthy";
    }

    const statusCode = dbStatus === "unhealthy" ? 503 : 200;

    return reply.status(statusCode).send({
      status: dbStatus === "healthy" ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      checks: {
        database: { status: dbStatus },
      },
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

  // Email queue health check
  app.get("/health/email-queue", async (_request, reply) => {
    const health = await getEmailQueueHealth();
    return reply.status(health.isHealthy ? 200 : 503).send(health);
  });

  // Register module routes
  await app.register(usersRoutes, { prefix: "/api/users" });
  await app.register(clientsRoutes, { prefix: "/api/clients" });
  await app.register(eventsRoutes, { prefix: "/api/events" });
  await app.register(formsRoutes, { prefix: "/api/forms" });
  await app.register(formsPublicRoutes, { prefix: "/api/forms/public" });

  // Pricing routes
  await app.register(pricingRulesRoutes, { prefix: "/api/events" });
  await app.register(pricingPublicRoutes, { prefix: "/api/public/forms" });

  // Access routes (replaces eventExtrasRoutes)
  await app.register(accessRoutes, { prefix: "/api/events" });
  await app.register(accessPublicRoutes, { prefix: "/api/public/events" });

  // Events public routes (payment-config, etc.)
  await app.register(eventsPublicRoutes, { prefix: "/api/public/events" });

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

  // SendGrid webhook (public, no auth — secured by ECDSA signature verification)
  await app.register(emailWebhookRoutes, { prefix: "/webhooks/sendgrid" });

  // Certificate routes (template management)
  await app.register(certificatesRoutes, { prefix: "/api/events" });

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

  return app;
}
