-- migrate: transaction per-file
-- Networking email logs are identified by their context snapshot only. The
-- purge, the post-event report and the organizer email metrics select them by
-- event; this partial expression index serves all three.
CREATE INDEX email_logs_networking_event_idx ON email_logs ((context_snapshot ->> 'eventId'))
 WHERE (context_snapshot ->> 'dispatchOwner') = 'networking';
