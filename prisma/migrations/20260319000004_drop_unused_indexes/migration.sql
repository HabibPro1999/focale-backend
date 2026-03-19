-- Drop 3 unused indexes confirmed to have zero query consumers.
-- None of these columns appear in any where/orderBy clause in the codebase.
-- Removing them reduces write overhead on INSERT/UPDATE without affecting any query.

-- registrations: eventId+paidAt — paidAt is only ever written or selected, never filtered/sorted
DROP INDEX IF EXISTS "registrations_event_id_paid_at_idx";

-- sponsorships: beneficiaryEmail — never queried, only written and read from fetched objects
DROP INDEX IF EXISTS "sponsorships_beneficiary_email_idx";

-- sponsorships: targetRegistrationId — only written during creation, never queried
DROP INDEX IF EXISTS "sponsorships_target_registration_id_idx";
