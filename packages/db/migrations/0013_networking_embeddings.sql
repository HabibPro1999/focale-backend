-- PostgreSQL prerequisite: install pgvector and CREATE EXTENSION IF NOT EXISTS vector.
-- CockroachDB: VECTOR is native; do not execute CREATE EXTENSION on CockroachDB.
-- Run through scripts/migrate-networking.mjs for database-specific setup.
CREATE TABLE networking_embeddings (
 id text PRIMARY KEY, profile_id text NOT NULL REFERENCES networking_profiles(id) ON DELETE CASCADE,
 event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('PROFILE','OFFER','NEED')), model text NOT NULL,
 source_hash text NOT NULL, embedding vector(1536) NOT NULL,
 created_at timestamp(3) NOT NULL DEFAULT now(), updated_at timestamp(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX networking_embeddings_profile_kind_model_key ON networking_embeddings(profile_id,kind,model);
CREATE INDEX networking_embeddings_event_kind_model_idx ON networking_embeddings(event_id,kind,model);
CREATE TABLE networking_embedding_jobs (
 profile_id text PRIMARY KEY REFERENCES networking_profiles(id) ON DELETE CASCADE,
 source_hash text, model text,
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','READY','FAILED')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz(3) NOT NULL DEFAULT now(),
 locked_until timestamptz(3), lock_token text, indexed_profile_at timestamptz(3), last_error text,
 metrics jsonb NOT NULL DEFAULT '{}', created_at timestamp(3) NOT NULL DEFAULT now(), updated_at timestamp(3) NOT NULL DEFAULT now()
);
CREATE INDEX networking_embedding_jobs_pending_idx ON networking_embedding_jobs(status,available_at);
