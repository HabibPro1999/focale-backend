import { z } from "zod";
import { requireAuth } from "@shared/middleware/auth.middleware.js";
import type { AppInstance } from "@shared/fastify.js";

const UserSchema = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  role: z.number(),
  clientId: z.string().nullable(),
  active: z.boolean(),
});

export async function usersRoutes(app: AppInstance): Promise<void> {
  // GET /me — current user profile
  app.get("/me", { onRequest: [requireAuth] }, async (request, reply) => {
    const safeUser = UserSchema.parse(request.user);
    return reply.send(safeUser);
  });
}
