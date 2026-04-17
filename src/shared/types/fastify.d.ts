import type { User } from "@/generated/prisma/client.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

/**
 * Fastify instance bound to the Zod type provider. The four leading generics
 * (server / req / reply / logger) are deliberately `any` — Fastify's official
 * typing for "use whatever the runtime provides" matches the concrete pino
 * logger we configure in core/server.ts; pinning explicit types here drifts
 * from the actual logger shape and breaks consumers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
export type AppInstance = FastifyInstance<any, any, any, any, ZodTypeProvider>;

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
}
