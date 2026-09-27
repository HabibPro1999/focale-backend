import { z } from "zod";

export const PaymentStatusSchema = z.enum([
  "PENDING",
  "VERIFYING",
  "PARTIAL",
  "PAID",
  "SPONSORED",
  "WAIVED",
  "REFUNDED",
]);

export const RegistrationRoleSchema = z.enum([
  "PARTICIPANT",
  "SPEAKER",
  "MODERATOR",
  "ORGANIZER",
  "INVITED",
]);

