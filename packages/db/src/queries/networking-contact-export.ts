import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../client";
import { rowsOf } from "../helpers";
import { networkingConfigs, networkingProfiles } from "../schema/networking";
import { registrations } from "../schema/registrations";
import { peerCounterpart } from "../policy/networking-eligibility";
export interface NetworkingExportContact { firstName: string; lastName: string; company: string; jobTitle: string; sector: string; city: string; country: string; website: string | null; }
const contact = alias(networkingProfiles, "p");
const contactRegistration = alias(registrations, "r");
const eventConfig = alias(networkingConfigs, "cfg");
/**
 * The participant's connections they may still see (4.6: counterpart `peer`
 * mode), for the post-event contacts CSV. Private registration email/phone are
 * never part of a participant connection export.
 */
export async function networkingParticipantExportContacts(eventId: string, profileId: string): Promise<NetworkingExportContact[]> {
  return rowsOf<NetworkingExportContact>(await getDb().execute(sql`
    SELECT p.first_name AS "firstName",p.last_name AS "lastName",p.company,p.job_title AS "jobTitle",p.sector,p.city,p.country,p.website
    FROM networking_connections c JOIN networking_profiles p ON p.id=CASE WHEN c.profile_a_id=${profileId} THEN c.profile_b_id ELSE c.profile_a_id END
      JOIN registrations r ON r.id=p.registration_id JOIN networking_configs cfg ON cfg.event_id=c.event_id
    WHERE c.event_id=${eventId} AND p.event_id=${eventId} AND (c.profile_a_id=${profileId} OR c.profile_b_id=${profileId})
      AND ${peerCounterpart(contact, contactRegistration, { config: eventConfig.config }, { eventId, profileId })}
    ORDER BY p.last_name,p.first_name,p.id
  `));
}
