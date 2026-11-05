# Performance, load and chaos test plan

## Profiles

- **Small agency:** ~20 active employees, bursty interactive API, a few concurrent agents, modest documents.
- **Growing services company:** ~100 active employees, sustained cross-team Work Units, mixed agent/ingestion spikes.
- **Heavy automation company:** ~300 active employees, numerous unattended agents and large knowledge corpus.

These are **test personas, not proven capacity tiers**. Parameterize real users/tenant count, simultaneous AI runs, allowed provider throughput, file sizes, network locality and hardware specifications before benchmarking.

## Test runs

A. Baseline API CRUD/read with no agents; B. add concurrent agent tasks; C. add ingestion/indexing; D. model timeout/rate limits; E. Temporal restart; F. DB failover; G. tenant cache invalidation; H. multi-replica Next.js consistency; I. partial external-side-effect crash; J. offline Sovereign boot; K. mass source revoke; L. BYOM credential rotation.

## SLI collection

Measure authenticated page p50/p95/p99, API TTFB and latency, event-loop lag, Node heap, request queue saturation, SQL slow query/locks/pool, Temporal schedule-to-start and retry depth, embeddings/index latency, retrieval quality under ACL, provider cost/latency, verified Work Unit throughput, tenant fairness, memory storage, backup restore duration and operational error budgets.

## Exit criteria

No cross-tenant data or cached content leaks, no unauthorized provider fallback, no duplicate consequential side effect, verified recovery of workflows, graceful backpressure under load, user-visible honest failure states, and target SLOs met under specified reference hardware/traffic. Investigate bottleneck before changing language or introducing microservices.
