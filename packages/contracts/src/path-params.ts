import { z } from "zod";

/** Shared strict :eventId path shape; callers retain their existing public names. */
export const EventIdPathParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});
