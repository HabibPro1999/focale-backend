-- Space capacity counts tables/exhibitors, never seats. Preserve historical IDs/bookings.
CREATE TABLE networking_spaces (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'TABLE' CHECK (kind IN ('TABLE','STAND')),
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 500),
  location text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamp(3) NOT NULL DEFAULT now(),
  updated_at timestamp(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX networking_spaces_event_name_key ON networking_spaces(event_id,name);
ALTER TABLE networking_tables ADD COLUMN space_id text REFERENCES networking_spaces(id) ON DELETE CASCADE;
-- A legacy record is one bookable table/stand. Its old seating count cannot tell us room size.
INSERT INTO networking_spaces(id,event_id,name,kind,capacity,location,active)
SELECT id,event_id,name,kind,1,location,active FROM networking_tables;
UPDATE networking_tables SET space_id=id, capacity=2;
ALTER TABLE networking_tables ADD CONSTRAINT networking_tables_two_people_check CHECK (capacity=2);
DROP INDEX IF EXISTS networking_tables_event_name_key;
CREATE UNIQUE INDEX networking_tables_space_name_key ON networking_tables(space_id,name);
CREATE INDEX networking_tables_event_space_idx ON networking_tables(event_id,space_id);
CREATE INDEX networking_profiles_stand_idx ON networking_profiles(event_id,stand_table_id);
-- The profile-to-stand relationship already supports many representatives per organization.
UPDATE networking_profiles p SET stand_table_id=t.id
FROM networking_tables t
WHERE t.kind='STAND' AND t.owner_profile_id=p.id AND t.event_id=p.event_id AND p.stand_table_id IS NULL;
-- Known representatives get independent station locks. Unidentifiable legacy bookings retain
-- their conservative whole-stand locks until cancelled/completed/reassigned by the organizer.
UPDATE networking_reservations r SET resource_key='stand:'||t.id||':profile:'||
  CASE WHEN recipient.stand_table_id=t.id THEN recipient.id ELSE requester.id END
FROM networking_meetings m
JOIN networking_tables t ON t.id=m.table_id AND t.event_id=m.event_id
JOIN networking_profiles requester ON requester.id=m.requester_id
JOIN networking_profiles recipient ON recipient.id=m.recipient_id
WHERE r.meeting_id=m.id AND r.event_id=m.event_id AND t.kind='STAND'
  AND r.resource_key='table:'||t.id
  AND (recipient.stand_table_id=t.id OR requester.stand_table_id=t.id);
