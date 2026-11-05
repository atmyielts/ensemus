# Performance engineering and scalable execution

## Philosophy

Optimize **verified outcomes / total lifecycle cost**, not request benchmark vanity. Next.js/Node is highly suitable for I/O-bound SQL, agent tool and model traffic. Isolate CPU-heavy parsing/transcoding via worker threads, separate containers or specialized optional services rather than blocking the web event loop.

## Latency budgets (provisional, not measured guarantees)

| User operation | Proposed internal test target | Measurement |
|---|---|---|
| Authorized ordinary API read | p95 under 300 ms excluding network to client | Server span: auth + SQL + serialization |
| Common authenticated page navigation | p95 under 1.5 s under reference test conditions | Browser LCP + server timing |
| Work Unit create/assign | p95 under 500 ms excluding async work | HTTP and DB transaction |
| Agent initiation acknowledgement | p95 under 750 ms | Creation + outbox commit, not model completion |
| Policy engine decision | p95 under 25 ms for warm common case | Handler trace |
| Outbox publish lag | p95 under 2 s at reference load | Commit-to-consumer availability |
| Verified completed Work Unit | No fixed universal target | By workflow type, provider, complexity, cost |

These are **proposed engineering targets** requiring load profiles, datasets and hardware before contractual adoption. Self-hosted customers must receive benchmark-derived minimum and recommended machine profiles.

## Mandatory measurements

- Web: CPU/heap, event-loop delay, request concurrency and response-time distributions, server-render waterfall, cache hits, DB pool utilization, cold start/startup time.
- Data: top SQL query p95, N+1 count, lock wait, index hits, RLS overhead, pgvector recall under restrictive ACL, migration duration, backup size.
- Execution: Temporal schedule-to-start, workflow retries, queued steps, tool receipts, completion and cancellation latency, provider token limits, model p95 latency.
- Unit economics: tokens per successfully completed Work Unit, retrieval context cost, cache savings, retries, external API costs, infra/tenant, per-tenant rate limits.
- Sovereign: 1-node and 3-node reference loads, no-egress operation, cold restore, upgrade duration, air-gap operational overhead.

## Practical optimizations

1. Server Components query server domain methods directly, never loop over local HTTP APIs.
2. Bundle private SQL authorization and queries in the same transaction; use efficient query shapes and indexes.
3. Use streaming or progress subscription for perceived responsiveness; agent execution continues separately.
4. Use deterministic functions before inference; batch low-urgency inference and ingestion.
5. Use provider caching only when tenant data policies allow. Treat prompts and result caches as confidential.
6. Use bounded actor concurrency and explicit budgets. Don't issue arbitrary parallel provider calls without rate quotas.
7. Keep data transport close to DB; avoid unnecessary JSON serialization and cross-process RPC for every step.
8. Validate quality when changing model size or search ranking; cheaper tokens are not automatically cheaper outcomes.
9. Partition hot event and trace tables and archive according to policy; do not shard prematurely.
10. Benchmark before introducing Go, Rust, Kafka, Neo4j, separate vector search or additional HTTP microservices.

## Scale-out triggers

Add independent workers for high CPU or memory contention, dedicated database read capacity for sustained read pressure, new search infrastructure only when real retrieval metrics fail, a separate realtime authorized service only if sustained sockets/collaboration require it. Every split needs an ADR with a load test, a security boundary review, and an operational cost comparison.
