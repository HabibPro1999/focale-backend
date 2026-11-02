-- migrate: transaction per-file
-- migrate: idempotent
CREATE TABLE IF NOT EXISTS sponsorship_cancellation_undo (
  sponsorship_id TEXT PRIMARY KEY REFERENCES sponsorships(id) ON DELETE CASCADE ON UPDATE CASCADE,
  snapshot JSONB NOT NULL
);
