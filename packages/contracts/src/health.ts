import { z } from "zod";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  uptimeSec: z.number(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
