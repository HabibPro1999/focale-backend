import { z } from "zod";

// Shared param schemas to avoid duplication across modules.
// Import from "@shared/schemas/params.js" using the @shared alias.

export const EventIdParamSchema = z
  .object({ eventId: z.string().uuid() })
  .strict();

export const RegistrationIdParamSchema = z
  .object({ registrationId: z.string().uuid() })
  .strict();

export const FormIdParamSchema = z.object({ id: z.string().uuid() }).strict();

export const IdParamSchema = z.object({ id: z.string().uuid() }).strict();
