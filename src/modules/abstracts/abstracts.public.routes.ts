import { publicRateLimits } from "@core/plugins.js";
import { extractAbstractToken } from "./abstract-token.js";
import {
  EventSlugParamSchema,
  AbstractIdParamSchema,
  AbstractTokenQuerySchema,
  SubmitAbstractSchema,
  type SubmitAbstractInput,
} from "./abstracts.schema.js";
import {
  getPublicConfig,
  submitAbstract,
  getAbstractByToken,
  editAbstract,
} from "./abstracts.service.js";
import { uploadAbstractFinalFile } from "./abstracts.final-file.service.js";
import type { AppInstance } from "@shared/types/fastify.js";

// ============================================================================
// Public Routes (No Auth - for form submission)
// ============================================================================

export async function abstractsPublicRoutes(
  app: AppInstance,
): Promise<void> {
  // GET /api/public/events/:slug/abstracts/config
  app.get<{
    Params: { slug: string };
  }>(
    "/events/:slug/abstracts/config",
    {
      config: {
        rateLimit: publicRateLimits.abstractsRead,
      },
      schema: {
        params: EventSlugParamSchema,
      },
    },
    async (request, reply) => {
      const result = await getPublicConfig(request.params.slug);
      return reply.send(result);
    },
  );

  // POST /api/public/events/:slug/abstracts/submit
  app.post<{
    Params: { slug: string };
    Body: SubmitAbstractInput;
  }>(
    "/events/:slug/abstracts/submit",
    {
      config: {
        rateLimit: publicRateLimits.abstractsSubmit,
      },
      schema: {
        params: EventSlugParamSchema,
        body: SubmitAbstractSchema,
      },
    },
    async (request, reply) => {
      const result = await submitAbstract(
        request.params.slug,
        request.body,
        request.ip,
      );
      return reply.status(201).send(result);
    },
  );

  // GET /api/public/abstracts/:id
  app.get<{
    Params: { id: string };
    Querystring: { token?: string };
  }>(
    "/abstracts/:id",
    {
      config: {
        rateLimit: publicRateLimits.abstractsRead,
      },
      schema: {
        params: AbstractIdParamSchema,
        querystring: AbstractTokenQuerySchema,
      },
    },
    async (request, reply) => {
      const token = extractAbstractToken(request);
      const result = await getAbstractByToken(request.params.id, token);
      return reply.send(result);
    },
  );

  // PATCH /api/public/abstracts/:id
  app.patch<{
    Params: { id: string };
    Querystring: { token?: string };
    Body: SubmitAbstractInput;
  }>(
    "/abstracts/:id",
    {
      config: {
        rateLimit: publicRateLimits.abstractsEdit,
      },
      schema: {
        params: AbstractIdParamSchema,
        querystring: AbstractTokenQuerySchema,
        body: SubmitAbstractSchema,
      },
    },
    async (request, reply) => {
      const token = extractAbstractToken(request);
      const result = await editAbstract(
        request.params.id,
        token,
        request.body,
        request.ip,
      );
      return reply.send(result);
    },
  );

  // POST /api/public/abstracts/:id/final-file
  app.post<{
    Params: { id: string };
    Querystring: { token?: string };
  }>(
    "/abstracts/:id/final-file",
    {
      config: {
        rateLimit: publicRateLimits.abstractsEdit,
      },
      schema: {
        params: AbstractIdParamSchema,
        querystring: AbstractTokenQuerySchema,
      },
    },
    async (request, reply) => {
      const token = extractAbstractToken(request);
      const data = await request.file({
        limits: { fileSize: 50 * 1024 * 1024 },
      });
      if (!data) {
        throw app.httpErrors.badRequest("No file uploaded");
      }

      const buffer = await data.toBuffer();
      const result = await uploadAbstractFinalFile(
        request.params.id,
        token,
        {
          buffer,
          filename: data.filename,
          mimetype: data.mimetype,
        },
        request.ip,
      );
      return reply.status(201).send(result);
    },
  );
}
