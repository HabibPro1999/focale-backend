-- migrate: transaction per-file
-- One row per worker process, upserted every 15 s (apps/worker heartbeat). /health/worker reads the
-- rows that beat recently; rows of processes gone for 7 days are pruned by the workers themselves.
CREATE TABLE worker_heartbeats (
 worker_id TEXT PRIMARY KEY,
 service TEXT NOT NULL,
 started_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 last_beat_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 disabled BOOLEAN NOT NULL DEFAULT false,
 jobs JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX worker_heartbeats_last_beat_at_idx ON worker_heartbeats (last_beat_at);
