import { z } from "zod";
import type { User as PrismaUser } from "@/generated/prisma/client.js";

export const MODULE_IDS = [
  "pricing",
  "registrations",
  "sponsorships",
  "emails",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

/** Base entity — mirrors the clients table. */
export const Client = z
  .object({
    name: z.string().min(1).max(100),
    email: z.string().email().optional().nullable(),
    phone: z.string().min(1).max(20).optional().nullable(),
    enabledModules: z.array(z.enum(MODULE_IDS)).default([...MODULE_IDS]),
  })
  .strict();

/** Admin user attached to a client — derived from Prisma model to stay in sync. */
export type User = Pick<PrismaUser, "id" | "email" | "name" | "active">;
