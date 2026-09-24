-- migrate: transaction per-file
ALTER TABLE networking_sessions ADD COLUMN second_factor_verified_at TIMESTAMPTZ(3);
CREATE TABLE networking_second_factors (
 profile_id TEXT PRIMARY KEY REFERENCES networking_profiles(id) ON DELETE CASCADE,
 encrypted_secret TEXT,
 pending_encrypted_secret TEXT,
 enabled_at TIMESTAMPTZ(3),
 recovery_hashes JSONB NOT NULL DEFAULT '[]'::JSONB,
 last_counter INTEGER NOT NULL DEFAULT -1,
 failed_attempts INTEGER NOT NULL DEFAULT 0,
 last_attempt_at TIMESTAMPTZ(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT now(),
 updated_at TIMESTAMP(3) NOT NULL
);
