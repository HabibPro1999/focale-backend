# Local networking discovery performance

Recorded at 2026-09-08 01:55:54 UTC by `apps/api/src/modules/networking/networking.performance.test.ts`. The raw result is retained in [networking-performance.json](networking-performance.json).

These are local sequential warm-cache measurements against isolated PostgreSQL, using synthetic event profiles. Nest/Fastify injection executes routing, participant authentication, guards, DTO validation, response envelope and JSON serialization. It excludes TCP, TLS, browser rendering, semantic embedding providers and concurrent traffic. Each variant has three warmups and 15 measured requests; the reported nearest-rank p95 is also the maximum of these 15 samples. This small sample is useful regression evidence, not a production latency guarantee.

| Profiles | Eligible plain results | Request | Median ms | p95/max ms |
| --- | --- | --- | --- | --- |
| 2,000 | 1,426 | Plain directory | 14.33 | 23.77 |
| 2,000 | 1,426 | Finance + Tunis filters | 8.42 | 13.25 |
| 2,000 | 1,426 | Mohammed query + recommended sort | 24.03 | 32.07 |
| 10,000 | 7,425 | Plain directory | 54.30 | 73.65 |
| 10,000 | 7,425 | Finance + Tunis filters | 22.12 | 27.34 |
| 10,000 | 7,425 | Mohammed query + recommended sort | 102.66 | 110.51 |

All requests use a page limit of 30. The service-only measurements and exact conditions are in the JSON. Query and fixture source define the exclusion distribution; eligible totals are not the result counts of filtered requests. Fixtures have unique events and clean themselves up. No production data or external notifications are involved.

To reproduce from `backend` after applying migrations to a disposable local test database:

```sh
ALLOW_DB_TESTS=1 TEST_DATABASE_URL=postgresql://localhost/focale_networking_test_20260908_0200 NETWORKING_PERFORMANCE=1 NETWORKING_PERFORMANCE_HTTP=1 NETWORKING_PERFORMANCE_LABEL=repeat pnpm --filter @app/api exec vitest run src/modules/networking/networking.performance.test.ts
```

The command writes a fresh `/tmp/focale-networking-performance-repeat.json`. Before a production performance claim, measure network/browser latency, concurrent readers and writes, representative data distributions and cold caches, semantic retrieval, and deployed database capacity. Booking contention correctness tests are separate from this latency benchmark.
