-- migrate: transaction per-file
ALTER TABLE networking_meetings ADD COLUMN cancellation_note text NOT NULL DEFAULT '';
CREATE INDEX networking_messages_sender_created_idx ON networking_messages(event_id, sender_id, created_at);
CREATE INDEX networking_notifications_unread_idx ON networking_notifications(event_id, profile_id, created_at) WHERE read_at IS NULL;
CREATE INDEX networking_meetings_requester_start_idx ON networking_meetings(event_id, requester_id, starts_at);
CREATE INDEX networking_meetings_recipient_start_idx ON networking_meetings(event_id, recipient_id, starts_at);
