import { z } from "zod";

// Shared param schemas to avoid duplication across modules.
// Import from "@shared/schemas/params.js" using the @shared alias.

// Generic helper: the cast to Record<K, z.ZodString> preserves the literal
// key name so callers can still access `params.eventId`, `params.id`, etc.
function uuidParam<K extends string>(name: K) {
  return z
    .object({ [name]: z.string().uuid() } as Record<K, z.ZodString>)
    .strict();
}

export const EventIdParamSchema = uuidParam("eventId");
export const RegistrationIdParamSchema = uuidParam("registrationId");
export const FormIdParamSchema = uuidParam("id");
export const IdParamSchema = uuidParam("id");
