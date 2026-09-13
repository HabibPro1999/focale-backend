import { sql } from "drizzle-orm";
import { getDb } from "../client";
import { rowsOf } from "../helpers";
export interface NetworkingExportContact { firstName: string; lastName: string; company: string; jobTitle: string; sector: string; city: string; country: string; website: string | null; }
/** Private registration email/phone are never part of a participant connection export. */
export async function networkingParticipantExportContacts(eventId: string, profileId: string): Promise<NetworkingExportContact[]> {
  return rowsOf<NetworkingExportContact>(await getDb().execute(sql`
    SELECT p.first_name AS "firstName",p.last_name AS "lastName",p.company,p.job_title AS "jobTitle",p.sector,p.city,p.country,p.website
    FROM networking_connections c JOIN networking_profiles p ON p.id=CASE WHEN c.profile_a_id=${profileId} THEN c.profile_b_id ELSE c.profile_a_id END
      JOIN registrations r ON r.id=p.registration_id JOIN networking_configs cfg ON cfg.event_id=c.event_id
    WHERE c.event_id=${eventId} AND p.event_id=${eventId} AND (c.profile_a_id=${profileId} OR c.profile_b_id=${profileId})
      AND p.status='ACTIVE' AND p.consent AND p.withdrawn_at IS NULL AND r.networking_opt_in IS DISTINCT FROM false
      AND cfg.config->'eligiblePaymentStatuses' ? r.payment_status::text
      AND NOT EXISTS (SELECT 1 FROM networking_blocks b WHERE b.event_id=c.event_id AND ((b.profile_id=${profileId} AND b.target_id=p.id) OR (b.profile_id=p.id AND b.target_id=${profileId})))
    ORDER BY p.last_name,p.first_name,p.id
  `));
}
