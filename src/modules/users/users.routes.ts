import { requireAuth } from "@shared/middleware/auth.middleware.js";
import type { AppInstance } from "@shared/fastify.js";
import { UserSchema } from "./users.schema.js";

export async function usersRoutes(app: AppInstance): Promise<void> {
  // GET /me — current user profile
  app.get("/me", { onRequest: [requireAuth] }, async (request, reply) => {
    const { id, email, name, role, clientId, active } = request.user!;
    const safeUser = UserSchema.parse({ id, email, name, role, clientId, active });
    return reply.send(safeUser);
  });
}
