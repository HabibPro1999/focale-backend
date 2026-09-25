import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DbExecutor } from "../client";
import { emailLogs } from "../schema/email";
import { events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import { abstracts } from "../schema/abstracts";
import type { EmailLogRealtimeTarget } from "./email";

/**
 * getEmailLogRealtimeTarget for many email logs in one query (the coalesced
 * email status events): the registration relation when registrationId is set,
 * else the abstract → event relation. Logs that are unknown, linked to
 * neither, or whose relation no longer exists are absent from the map.
 */
export async function getEmailLogRealtimeTargets(
  emailLogIds: string[],
  exec: DbExecutor = getDb(),
): Promise<Map<string, EmailLogRealtimeTarget>> {
  const targets = new Map<string, EmailLogRealtimeTarget>();
  if (emailLogIds.length === 0) return targets;
  const registrationEvents = alias(events, "registration_events");
  const abstractEvents = alias(events, "abstract_events");
  const rows = await exec
    .select({
      id: emailLogs.id,
      registrationId: emailLogs.registrationId,
      registrationClientId: registrationEvents.clientId,
      registrationEventId: registrationEvents.id,
      abstractClientId: abstractEvents.clientId,
      abstractEventId: abstractEvents.id,
    })
    .from(emailLogs)
    .leftJoin(registrations, eq(registrations.id, emailLogs.registrationId))
    .leftJoin(registrationEvents, eq(registrationEvents.id, registrations.eventId))
    .leftJoin(abstracts, eq(abstracts.id, emailLogs.abstractId))
    .leftJoin(abstractEvents, eq(abstractEvents.id, abstracts.eventId))
    .where(inArray(emailLogs.id, emailLogIds));
  for (const row of rows) {
    if (row.registrationId) {
      if (row.registrationClientId && row.registrationEventId) {
        targets.set(row.id, {
          clientId: row.registrationClientId,
          eventId: row.registrationEventId,
          registrationId: row.registrationId,
        });
      }
    } else if (row.abstractClientId && row.abstractEventId) {
      targets.set(row.id, {
        clientId: row.abstractClientId,
        eventId: row.abstractEventId,
        registrationId: null,
      });
    }
  }
  return targets;
}
