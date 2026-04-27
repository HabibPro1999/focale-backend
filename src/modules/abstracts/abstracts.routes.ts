import {
  requireAuth,
  requireAdmin,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { assertClientModuleEnabled } from "@clients";
import { getEventById } from "@events";
import {
  AbstractsEventIdParamSchema,
  ThemeIdParamSchema,
  PatchConfigSchema,
  CreateThemeSchema,
  UpdateThemeSchema,
  AdditionalFieldsSchema,
  AbstractAdminParamSchema,
  ListAbstractsQuerySchema,
  FinalizeAbstractSchema,
  AbstractBookJobParamSchema,
  type PatchConfigInput,
  type CreateThemeInput,
  type UpdateThemeInput,
  type AdditionalFieldsInput,
  type ListAbstractsQuery,
  type FinalizeAbstractInput,
} from "./abstracts.schema.js";
import {
  getOrCreateConfig,
  updateConfig,
  listThemes,
  createTheme,
  updateTheme,
  softDeleteTheme,
  getAdditionalFields,
  setAdditionalFields,
} from "./abstracts.config.service.js";
import {
  finalizeAbstract,
  getAdminAbstract,
  listAdminAbstracts,
  reopenAbstract,
} from "./abstracts.admin.service.js";
import {
  enqueueAbstractBookJob,
  getAbstractBookJob,
  listAbstractBookJobs,
} from "./abstracts.book.service.js";
import type { AppInstance } from "@shared/types/fastify.js";

export async function abstractsRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  app.addHook("onRequest", requireAdmin);

  // Helper: resolve event, check client access and module gate
  async function resolveEvent(
    request: { params: { eventId: string }; user?: { role: number; clientId: string | null } },
  ) {
    const event = await getEventById(request.params.eventId);
    if (!event) {
      throw app.httpErrors.notFound("Event not found");
    }
    if (!canAccessClient(request.user!, event.clientId)) {
      throw app.httpErrors.forbidden("Insufficient permissions");
    }
    await assertClientModuleEnabled(event.clientId, "abstracts");
    return event;
  }

  // ===========================================================================
  // Config
  // ===========================================================================

  // GET /api/events/:eventId/abstracts/config
  app.get<{ Params: { eventId: string } }>(
    "/events/:eventId/abstracts/config",
    { schema: { params: AbstractsEventIdParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const config = await getOrCreateConfig(request.params.eventId);
      return reply.send(config);
    },
  );

  // PATCH /api/events/:eventId/abstracts/config
  app.patch<{ Params: { eventId: string }; Body: PatchConfigInput }>(
    "/events/:eventId/abstracts/config",
    {
      schema: {
        params: AbstractsEventIdParamSchema,
        body: PatchConfigSchema,
      },
    },
    async (request, reply) => {
      await resolveEvent(request);
      const updated = await updateConfig(
        request.params.eventId,
        request.body,
        request.user!.id,
      );
      return reply.send(updated);
    },
  );

  // ===========================================================================
  // Themes
  // ===========================================================================

  // GET /api/events/:eventId/abstracts/themes
  app.get<{ Params: { eventId: string } }>(
    "/events/:eventId/abstracts/themes",
    { schema: { params: AbstractsEventIdParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const themes = await listThemes(request.params.eventId);
      return reply.send(themes);
    },
  );

  // POST /api/events/:eventId/abstracts/themes
  app.post<{ Params: { eventId: string }; Body: CreateThemeInput }>(
    "/events/:eventId/abstracts/themes",
    {
      schema: {
        params: AbstractsEventIdParamSchema,
        body: CreateThemeSchema,
      },
    },
    async (request, reply) => {
      await resolveEvent(request);
      const theme = await createTheme(request.params.eventId, request.body);
      return reply.status(201).send(theme);
    },
  );

  // PATCH /api/events/:eventId/abstracts/themes/:themeId
  app.patch<{ Params: { eventId: string; themeId: string }; Body: UpdateThemeInput }>(
    "/events/:eventId/abstracts/themes/:themeId",
    {
      schema: {
        params: ThemeIdParamSchema,
        body: UpdateThemeSchema,
      },
    },
    async (request, reply) => {
      await resolveEvent(request);
      const theme = await updateTheme(
        request.params.eventId,
        request.params.themeId,
        request.body,
      );
      return reply.send(theme);
    },
  );

  // DELETE /api/events/:eventId/abstracts/themes/:themeId
  app.delete<{ Params: { eventId: string; themeId: string } }>(
    "/events/:eventId/abstracts/themes/:themeId",
    {
      schema: { params: ThemeIdParamSchema },
    },
    async (request, reply) => {
      await resolveEvent(request);
      await softDeleteTheme(request.params.eventId, request.params.themeId);
      return reply.status(204).send();
    },
  );

  // ===========================================================================
  // Additional Fields
  // ===========================================================================

  // GET /api/events/:eventId/abstracts/additional-fields
  app.get<{ Params: { eventId: string } }>(
    "/events/:eventId/abstracts/additional-fields",
    { schema: { params: AbstractsEventIdParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await getAdditionalFields(request.params.eventId);
      return reply.send(result);
    },
  );

  // PUT /api/events/:eventId/abstracts/additional-fields
  app.put<{ Params: { eventId: string }; Body: AdditionalFieldsInput }>(
    "/events/:eventId/abstracts/additional-fields",
    {
      schema: {
        params: AbstractsEventIdParamSchema,
        body: AdditionalFieldsSchema,
      },
    },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await setAdditionalFields(
        request.params.eventId,
        request.body,
        request.user!.id,
      );
      return reply.send(result);
    },
  );

  // ===========================================================================
  // Admin Abstracts
  // ===========================================================================

  // GET /api/events/:eventId/abstracts
  app.get<{ Params: { eventId: string }; Querystring: ListAbstractsQuery }>(
    "/events/:eventId/abstracts",
    {
      schema: {
        params: AbstractsEventIdParamSchema,
        querystring: ListAbstractsQuerySchema,
      },
    },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await listAdminAbstracts(request.params.eventId, request.query);
      return reply.send(result);
    },
  );

  // GET /api/events/:eventId/abstracts/:abstractId
  app.get<{ Params: { eventId: string; abstractId: string } }>(
    "/events/:eventId/abstracts/:abstractId",
    { schema: { params: AbstractAdminParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await getAdminAbstract(
        request.params.eventId,
        request.params.abstractId,
      );
      return reply.send(result);
    },
  );

  // POST /api/events/:eventId/abstracts/:abstractId/finalize
  app.post<{
    Params: { eventId: string; abstractId: string };
    Body: FinalizeAbstractInput;
  }>(
    "/events/:eventId/abstracts/:abstractId/finalize",
    { schema: { params: AbstractAdminParamSchema, body: FinalizeAbstractSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await finalizeAbstract(
        request.params.eventId,
        request.params.abstractId,
        request.body,
        request.user!.id,
      );
      return reply.send(result);
    },
  );

  // POST /api/events/:eventId/abstracts/:abstractId/reopen
  app.post<{ Params: { eventId: string; abstractId: string } }>(
    "/events/:eventId/abstracts/:abstractId/reopen",
    { schema: { params: AbstractAdminParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await reopenAbstract(
        request.params.eventId,
        request.params.abstractId,
        request.user!.id,
      );
      return reply.send(result);
    },
  );

  // ===========================================================================
  // Abstract Book
  // ===========================================================================

  // POST /api/events/:eventId/abstracts/book/jobs
  app.post<{ Params: { eventId: string } }>(
    "/events/:eventId/abstracts/book/jobs",
    { schema: { params: AbstractsEventIdParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await enqueueAbstractBookJob(
        request.params.eventId,
        request.user!.id,
      );
      return reply.status(201).send(result);
    },
  );

  // GET /api/events/:eventId/abstracts/book/jobs
  app.get<{ Params: { eventId: string } }>(
    "/events/:eventId/abstracts/book/jobs",
    { schema: { params: AbstractsEventIdParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      return reply.send(await listAbstractBookJobs(request.params.eventId));
    },
  );

  // GET /api/events/:eventId/abstracts/book/jobs/:jobId
  app.get<{ Params: { eventId: string; jobId: string } }>(
    "/events/:eventId/abstracts/book/jobs/:jobId",
    { schema: { params: AbstractBookJobParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await getAbstractBookJob(
        request.params.eventId,
        request.params.jobId,
      );
      return reply.send(result);
    },
  );
}
