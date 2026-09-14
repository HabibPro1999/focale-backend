-- Reverse-side lookups are needed for bidirectional blocks/connections.
CREATE INDEX networking_blocks_target_profile_idx ON networking_blocks(event_id,target_id,profile_id);
CREATE INDEX networking_connections_reverse_pair_idx ON networking_connections(event_id,profile_b_id,profile_a_id);
-- The reconciliation worker visits oldest changed profiles first.
CREATE INDEX networking_profiles_embedding_scan_idx ON networking_profiles(updated_at,id)
 WHERE status='ACTIVE' AND visible AND consent AND withdrawn_at IS NULL;
