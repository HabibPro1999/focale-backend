import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { registerPlugins } from "./plugins.js";
import { registerHooks } from "./hooks.js";
import { healthRoutes } from "./health.js";
import { errorHandler } from "@shared/middleware/error.middleware.js";
import { prisma } from "@/database/client.js";
import { logger } from "@shared/utils/logger.js";
import { usersRoutes } from "@users";
import { clientsRoutes } from "@clients";
import { eventsRoutes } from "@events";
import { formsRoutes, formsPublicRoutes } from "@forms";
import {
  pricingRulesRoutes,
  pricingPublicRoutes,
  pricingPaymentConfigPublicRoutes,
} from "@pricing";
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
import type { AppInstance } from "@shared/fastify.js";

export async function buildServer(): Promise<AppInstance> {
  const app = Fastify({
    loggerInstance: logger,
    forceCloseConnections: "idle",
    return503OnClosing: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Decorate with prisma
  app.decorate("prisma", prisma);

  // Disconnect database on server close
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
    logger.info("Database disconnected");
  });

  // Register plugins (CORS, Helmet, Rate Limit)
  await registerPlugins(app);

  // Register lifecycle hooks
  registerHooks(app);

  await app.register(healthRoutes);

  // Register module routes

  await app.register(usersRoutes, { prefix: "/api/users" });
  await app.register(clientsRoutes, { prefix: "/api/clients" });
  await app.register(eventsRoutes, { prefix: "/api/events" });
  await app.register(formsRoutes, { prefix: "/api/forms" });
  await app.register(formsPublicRoutes, { prefix: "/api/forms/public" });

  // Pricing routes
  await app.register(pricingRulesRoutes, { prefix: "/api/events" });
  await app.register(pricingPublicRoutes, { prefix: "/api" });
  await app.register(pricingPaymentConfigPublicRoutes, {
    prefix: "/api/public/events",
  });

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
