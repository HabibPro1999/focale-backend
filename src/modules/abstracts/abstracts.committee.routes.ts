import {
  requireAuth,
  requireAdmin,
  requireScientificCommittee,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { assertClientModuleEnabled } from "@clients";
import { getEventById } from "@events";
import type { AppInstance } from "@shared/types/fastify.js";
import {
  AbstractIdParamSchema,
  AbstractsEventIdParamSchema,
  AddCommitteeMemberSchema,
  AssignAbstractParamSchema,
  AssignReviewersSchema,
  CommitteeAbstractsQuerySchema,
  CommitteeMemberUserParamSchema,
  ReviewAbstractSchema,
  SetReviewerThemesSchema,
  type AddCommitteeMemberInput,
  type AssignReviewersInput,
  type CommitteeAbstractsQuery,
  type ReviewAbstractInput,
  type SetReviewerThemesInput,
} from "./abstracts.schema.js";
import {
  addCommitteeMember,
  assignReviewers,
  getAssignedAbstractDetail,
  getCommitteeProfile,
  listAssignedAbstracts,
  listCommitteeMembers,
  removeCommitteeMember,
  reviewAssignedAbstract,
  setReviewerThemes,
} from "./abstracts.committee.service.js";

export async function abstractsCommitteeAdminRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  app.addHook("onRequest", requireAdmin);

  async function resolveEvent(
    request: { params: { eventId: string }; user?: { role: number; clientId: string | null } },
  ) {
    const event = await getEventById(request.params.eventId);
    if (!event) throw app.httpErrors.notFound("Event not found");
    if (!canAccessClient(request.user!, event.clientId)) {
      throw app.httpErrors.forbidden("Insufficient permissions");
    }
    await assertClientModuleEnabled(event.clientId, "abstracts");
    return event;
  }

  app.get<{ Params: { eventId: string } }>(
    "/events/:eventId/abstracts/committee",
    { schema: { params: AbstractsEventIdParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      return reply.send(await listCommitteeMembers(request.params.eventId));
    },
  );

  app.post<{ Params: { eventId: string }; Body: AddCommitteeMemberInput }>(
    "/events/:eventId/abstracts/committee",
    { schema: { params: AbstractsEventIdParamSchema, body: AddCommitteeMemberSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const member = await addCommitteeMember(
        request.params.eventId,
        request.body,
        request.user!.id,
      );
      return reply.status(201).send(member);
    },
  );

  app.delete<{ Params: { eventId: string; userId: string } }>(
    "/events/:eventId/abstracts/committee/:userId",
    { schema: { params: CommitteeMemberUserParamSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      await removeCommitteeMember(
        request.params.eventId,
        request.params.userId,
        request.user!.id,
      );
      return reply.status(204).send();
    },
  );

  app.post<{
    Params: { eventId: string; userId: string };
    Body: SetReviewerThemesInput;
  }>(
    "/events/:eventId/abstracts/committee/:userId/themes",
    { schema: { params: CommitteeMemberUserParamSchema, body: SetReviewerThemesSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await setReviewerThemes(
        request.params.eventId,
        request.params.userId,
        request.body,
        request.user!.id,
      );
      return reply.send(result);
    },
  );

  app.post<{
    Params: { eventId: string; abstractId: string };
    Body: AssignReviewersInput;
  }>(
    "/events/:eventId/abstracts/:abstractId/assign",
    { schema: { params: AssignAbstractParamSchema, body: AssignReviewersSchema } },
    async (request, reply) => {
      await resolveEvent(request);
      const result = await assignReviewers(
        request.params.eventId,
        request.params.abstractId,
        request.body,
        request.user!.id,
      );
      return reply.send(result);
    },
  );
}

export async function abstractsCommitteeRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  app.addHook("onRequest", requireScientificCommittee);

  app.get("/abstracts/committee/me", async (request, reply) => {
    return reply.send(await getCommitteeProfile(request.user!.id));
  });

  app.get<{ Querystring: CommitteeAbstractsQuery }>(
    "/abstracts/committee/abstracts",
    { schema: { querystring: CommitteeAbstractsQuerySchema } },
    async (request, reply) => {
      const abstracts = await listAssignedAbstracts(
        request.query.eventId,
        request.user!.id,
      );
      return reply.send(abstracts);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/abstracts/committee/abstracts/:id",
    { schema: { params: AbstractIdParamSchema } },
    async (request, reply) => {
      const detail = await getAssignedAbstractDetail(request.params.id, request.user!.id);
      return reply.send(detail);
    },
  );

  app.put<{ Params: { id: string }; Body: ReviewAbstractInput }>(
    "/abstracts/committee/abstracts/:id/review",
    { schema: { params: AbstractIdParamSchema, body: ReviewAbstractSchema } },
    async (request, reply) => {
      const result = await reviewAssignedAbstract(
        request.params.id,
        request.user!.id,
        request.body,
      );
      return reply.send(result);
    },
  );
}
