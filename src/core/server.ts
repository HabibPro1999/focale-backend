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
import { emailRoutes } from "@email";
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
