import { BadRequestException } from "@nestjs/common";
import { NetworkingParticipantCursorSchema, NetworkingParticipantListQuerySchema, type NetworkingParticipantListQuery } from "@app/contracts";
import type { NetworkingContext } from "./networking.service";

const invalid = () => new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Invalid pagination query or cursor" });

/** HTTP lists always paginate (K3): 50 items by default, at most 200. */
export function participantPagination(kind: "connections" | "meetings", ctx: NetworkingContext, input: NetworkingParticipantListQuery = {}) {
  const parsed = NetworkingParticipantListQuerySchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const query = parsed.data;
  // Scope is compared with the authenticated context, never used as query authority. Organizer
  // config edits do not invalidate it: visibility is re-evaluated on every page.
  const scope = JSON.stringify([kind, ctx.event.id, ctx.profile.id]);
  let after: { at: Date; id: string } | undefined;
  if (query.cursor !== undefined) {
    try {
      const bytes = Buffer.from(query.cursor, "base64url");
      if (bytes.toString("base64url") !== query.cursor) throw invalid();
      const cursor = NetworkingParticipantCursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      const at = new Date(cursor.at);
      if (cursor.scope !== scope || !Number.isFinite(at.getTime()) || at.toISOString() !== cursor.at) throw invalid();
      after = { at, id: cursor.id };
    } catch {
      throw invalid();
    }
  }
  return {
    limit: query.limit ?? 50,
    after,
    cursor: (at: Date, id: string) => Buffer.from(JSON.stringify({ version: 1, scope, at: at.toISOString(), id })).toString("base64url"),
  };
}
