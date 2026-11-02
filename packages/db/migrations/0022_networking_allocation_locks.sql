-- migrate: transaction per-file
-- One row per (event, UTC hour); allocation transactions upsert the hours a meeting overlaps as their first statement.
CREATE TABLE networking_allocation_locks (
 event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 bucket_start TIMESTAMPTZ(3) NOT NULL,
 locked_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 PRIMARY KEY (event_id, bucket_start)
);
