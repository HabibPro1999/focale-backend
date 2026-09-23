# Networking recommendation performance

## Implemented behavior

- Up to 5,000 embedded profiles per event/model: exact weighted scoring.
- Larger events: three cosine searches (profile similarity, needs→offers, offers→needs), followed by exact 40/40/20 scoring of their deduplicated candidate union. Empty offers/needs do not trigger a complementary search.
- The first search requests 240 neighbors per signal for the API's 60-candidate page. If eligibility filters leave too few results, breadth increases to 960 and then 3,840 per signal. Work is bounded; there is no unbounded exact fallback for large events.
- CockroachDB uses an index prefixed by event, kind, and model. PostgreSQL retains exact distance scans; this migration does not install a PostgreSQL ANN index.
- A 30-second, 1,000-entry per-process cache stores candidate IDs/scores only and combines simultaneous requests for the same key. The key includes event, caller, model, professional-text hash, and allowed payment statuses. Empty/pending results and failures are not cached.
- Every request authenticates again and rechecks current candidate eligibility, consent, visibility, payment, blocks, passes, and connections. An exhausted cached page is refreshed once. Changes to candidate text or newly eligible participants can take up to 30 seconds to affect ranking.
- Activity heartbeats update `last_active_at` without changing `updated_at`, so browsing does not continually enqueue unchanged profiles for embedding checks.

## Worker throughput

Defaults process up to 128 profiles per tick (8 batches of 16), with two concurrent lanes. Each lane claims work only when ready. Existing lease ownership and retry backoff remain in force. Three vectors per profile are saved in one upsert inside the existing transaction.

```env
NETWORKING_EMBEDDING_BATCH_SIZE=16
NETWORKING_EMBEDDING_BATCHES_PER_TICK=8
NETWORKING_EMBEDDING_CONCURRENCY=2
```

Bounds: batch size 1–32, batches per tick 1–32, concurrency 1–4. The scheduler skips overlapping ticks. These are throughput ceilings, not guaranteed rates; tune against provider rate limits and database capacity. Long multilingual input is split into requests of at most 96 documents and 200,000 UTF-8 bytes. Unchanged text continues to avoid OpenAI calls.

## Database rollout

The following two migrations were applied and verified against the database in `backend/.env`:

- `0016_networking_read_indexes.sql`: reverse block/connection lookups and active-profile reconciliation index.
- `cockroach/0017_networking_vector_index.sql`: event/model/kind-prefixed cosine index.

The deployed `EXPLAIN` selects `networking_embeddings_cosine_idx`. The table was empty when the index was created. No credentials or cluster security settings were changed. The concurrently authored `0018` migration was not included in this operation.

For another environment, from the backend directory:

```sh
pnpm --filter @app/db build
node packages/db/scripts/migrate-networking.mjs --through=0017
# DATABASE_URL must already identify the intended database:
node packages/db/scripts/migrate-networking.mjs --apply --through=0017
```

The script checks migration checksums, chooses the engine-specific migration, and preserves `sql_safe_updates`. It refuses a CockroachDB vector-index backfill on a populated table; CockroachDB 26.2 blocks writes during that backfill, so an existing populated deployment needs a separate maintenance plan. The feature must already be enabled by its administrator.

The API and worker source changes still require deployment to Render. They do not change the OpenAI model or its per-token price.

## Validation and limits

Real-database regression tests cover complementary ranking, event/model separation, eligibility, revoked consent, blocks, passes, connections, embedding leases, atomic three-vector writes, and activity watermark preservation. Unit tests cover cache coalescing, eviction, expiration, live hydration/authentication, refill behavior, bounded worker concurrency, and multilingual batch splitting.

The [10,000-profile benchmark result](benchmarks/networking-vectors-10000.json) used CockroachDB 26.2.5 on a local single node and three sequential callers:

| Retrieval | Measured duration |
|---|---:|
| Exact weighted baseline | 987–1,290 ms |
| Indexed shortlist + exact reranking | 564–641 ms |
| Top-30 overlap with exact baseline | 100% for all three callers |

The measurements and recall checks completed successfully. The original large-fixture cascade cleanup was interrupted after it stalled; the dedicated test database was then dropped. The harness now deletes vectors in bounded batches before parent cleanup.

The 3,000-profile exploratory run found indexed retrieval slower (396–537 ms vs. 313–378 ms), motivating a 5,000-profile cutoff. That cutoff is an initial tuning choice, not a universal optimum.

The fixture stores 1,536 dimensions but uses 32 synthetic latent features with zero padding. This is a reproducible retrieval test, not evidence of real-world match relevance or production latency. It does not establish 100,000-person concurrency capacity. Large-event production rollout should measure latency, database CPU, shortlist recall on representative profiles, and accepted connections/meetings. The bounded shortlist can omit eligible matches when many nearest neighbors are excluded.

To rerun on a **dedicated local disposable database**, with no other worker/test process using it:

```sh
ALLOW_DB_TESTS=1 \
TEST_DATABASE_URL=postgresql://localhost/focale_networking_test_vectors \
NETWORKING_VECTOR_SIZE=10000 \
NETWORKING_VECTOR_REPORT=/tmp/networking-vectors.json \
NODE_OPTIONS=--conditions=@app/source \
pnpm --filter @app/db exec tsx scripts/benchmark-networking-vectors.ts
```

Initialize the disposable database with the migration script's `--bootstrap-test` first. The benchmark accepts 5,001–100,000 profiles, uses synthetic vectors without OpenAI calls, checks index use on CockroachDB, compares top-30 results, and removes its fixture afterward.

## Documentation used

Context7 resolved `/cockroachdb/docs`. Syntax and limitations were checked against [CockroachDB 26.2 vector-index documentation](https://github.com/cockroachdb/docs/blob/main/src/current/v26.2/vector-indexes.md).
