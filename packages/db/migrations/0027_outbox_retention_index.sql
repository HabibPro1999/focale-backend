-- migrate: transaction per-file
-- Outbox retention (worker RetentionJob, hourly): unkeyed rows are deleted by type and age
-- (realtime.emit after 24 h, background rows after 30 d). Keyed rows are never deleted (their
-- dedupe_key must keep rejecting duplicates), so they stay out of this index.
CREATE INDEX outbox_events_unkeyed_type_created_at_idx ON outbox_events (type, created_at)
 WHERE dedupe_key IS NULL;
