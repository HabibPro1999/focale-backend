import type { User } from "@/generated/prisma/client.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { ExtendedPrismaClient } from "../database/client.js";

/**
 * Extended Fastify instance type with Zod type provider.
 * Uses generic parameters to be compatible with any logger type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppInstance = FastifyInstance<any, any, any, any, ZodTypeProvider>;

declare module "fastify" {
  interface FastifyInstance {
    prisma: ExtendedPrismaClient;
  }

  interface FastifyRequest {
    user?: User;
  }
}
