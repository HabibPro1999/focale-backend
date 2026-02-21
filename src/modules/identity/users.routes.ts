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
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

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
      const safeUser = UserResponseSchema.parse(user);
      return reply.status(201).send(safeUser);
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
      const safeResult = {
        ...result,
        data: result.data.map((user) => UserResponseSchema.parse(user)),
      };
      return reply.send(safeResult);
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
        throw new AppError("User not found", 404, true, ErrorCodes.NOT_FOUND);
      }
      const safeUser = UserResponseSchema.parse(user);
      return reply.send(safeUser);
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
      const safeUser = UserResponseSchema.parse(user);
      return reply.send(safeUser);
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
      await deleteUser(request.params.id, request.user!.id);
      return reply.status(204).send();
    },
  );
}
