import { randomUUID } from "crypto";
import { z } from "zod";
import type { AppInstance } from "@shared/fastify.js";

// Validate request ID format: UUID or alphanumeric string (max 64 chars)
const RequestIdSchema = z.string().uuid().or(z.string().max(64).regex(/^[a-zA-Z0-9-_]+$/));

export function registerHooks(app: AppInstance) {
  // Add request ID with validation
  app.addHook("onRequest", async (request) => {
    const headerRequestId = request.headers["x-request-id"];

    if (headerRequestId && typeof headerRequestId === "string") {
      const parsed = RequestIdSchema.safeParse(headerRequestId);
      request.id = parsed.success ? parsed.data : randomUUID();
    } else {
      request.id = randomUUID();
    }
  });

  // Add response headers
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
}
