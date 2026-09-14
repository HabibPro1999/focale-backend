-- All three prefix values are constrained in each ANN search.
-- Do not disable sql_safe_updates: backfilling a non-empty table can block writes
-- on CockroachDB 26.2 and requires a separately planned maintenance window.
CREATE VECTOR INDEX networking_embeddings_cosine_idx
 ON networking_embeddings(event_id,kind,model,embedding vector_cosine_ops);
