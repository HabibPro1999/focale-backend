import { prisma } from "@/database/client.js";
import {
  requireAuth,
  requireSuperAdmin,
} from "@shared/middleware/auth.middleware.js";
import {
  createUser,
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
} from "./users.service.js";
import { UserRole } from "./permissions.js";
import {
  CreateUserSchema,
  UpdateUserSchema,
  ListUsersQuerySchema,
  UserIdParamSchema,
  UserResponseSchema,
  type CreateUserInput,
  type UpdateUserInput,
  type ListUsersQuery,
} from "./users.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";

export async function usersRoutes(app: AppInstance): Promise<void> {
  // All routes require authentication
  app.addHook("onRequest", requireAuth);

  // GET /api/users/me - Get current user (any authenticated user)
  app.get("/me", async (request, reply) => {
    const safeUser = UserResponseSchema.parse(request.user);
    return reply.send(safeUser);
  });

  // POST /api/users - Create user (super_admin only)
  app.post<{ Body: CreateUserInput }>(
    "/",
    {
      preHandler: [requireSuperAdmin],
      schema: { body: CreateUserSchema },
    },
    async (request, reply) => {
      const user = await createUser(request.body);
      return reply.status(201).send(user);
    },
  );

  // GET /api/users - List users (super_admin only)
  app.get<{ Querystring: ListUsersQuery }>(
    "/",
    {
      preHandler: [requireSuperAdmin],
      schema: { querystring: ListUsersQuerySchema },
    },
    async (request, reply) => {
      const result = await listUsers(request.query);
      return reply.send(result);
    },
  );

  // GET /api/users/:id - Get single user (super_admin only)
  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [requireSuperAdmin],
      schema: { params: UserIdParamSchema },
    },
    async (request, reply) => {
      const user = await getUserById(request.params.id);
      if (!user) {
        throw app.httpErrors.notFound("User not found");
      }
      return reply.send(user);
    },
  );

  // PATCH /api/users/:id - Update user (super_admin only)
  app.patch<{ Params: { id: string }; Body: UpdateUserInput }>(
    "/:id",
    {
      preHandler: [requireSuperAdmin],
      schema: { params: UserIdParamSchema, body: UpdateUserSchema },
    },
    async (request, reply) => {
      const user = await updateUser(request.params.id, request.body);
      return reply.send(user);
    },
  );

  // DELETE /api/users/:id - Delete user (super_admin only)
  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [requireSuperAdmin],
      schema: { params: UserIdParamSchema },
    },
    async (request, reply) => {
      const targetId = request.params.id;

      // Prevent self-deletion
      if (targetId === request.user!.id) {
        throw app.httpErrors.badRequest("Cannot delete your own account");
      }

      // Get user to check role
      const userToDelete = await getUserById(targetId);
      if (!userToDelete) {
        throw app.httpErrors.notFound("User not found");
      }

      // Prevent deleting the last super admin
      if (userToDelete.role === UserRole.SUPER_ADMIN) {
        const superAdminCount = await prisma.user.count({
          where: { role: UserRole.SUPER_ADMIN, active: true },
        });
        if (superAdminCount <= 1) {
          throw app.httpErrors.badRequest("Cannot delete the last super admin");
        }
      }

      await deleteUser(targetId);
      return reply.status(204).send();
    },
  );
}
