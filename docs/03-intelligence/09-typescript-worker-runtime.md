# TypeScript worker runtime: process topology and throughput

## Deployable processes

- **Workflow worker:** Temporal TypeScript SDK, deterministic workflow definitions, activities for business changes and external I/O.
- **Agent activity worker:** Node.js tasks for bounded agent reasoning and tool calls; separate task queue/class can protect interactive SLAs.
- **Ingestion worker:** larger memory/CPU limits for document processing and indexing, with dedicated concurrency.
- **Outbox dispatcher:** low-CPU durable publish/reconcile loop; shares DB and event contracts. It may be deployed alongside another worker in small environments, not inside Next.js.

These are deployment roles, not new business HTTP backends. Use one source tree and one set of versioned packages. For single-host deployment, combine compatible worker roles into a `worker` image/process supervisor only after ensuring independent shutdown and health handling; never hide subprocess crashes.

## Worker sizing

Concurrency is constrained by provider rate limits, database pool, Temporal queue depth, tenant quotas and process CPU/heap—not an arbitrary high default. Set per-queue limits and fair scheduling. Use worker threads or isolated processes for synchronous parsing/transcoding; Node's main event loop is not a CPU job pool. Do not let a noisy tenant consume all worker capacity.

## Reliability

Workers poll a durable task queue and must be disposable. Store no critical run state solely in in-memory variables or Valkey. Graceful shutdown stops polling, finishes/checkpoints safe activities and releases secrets. Temporal Activities should heartbeat/checkpoint for long tasks, propagate cancellation, and use idempotency/reconciliation for side effects.

## Streaming and status

The web server serves authenticated status/read-model updates, ideally via reconnectable SSE for ordinary progress. Status is reconstructed from persisted state/events after web restart. A dedicated websocket service is a later optional adapter, not the execution authority.

## Cloud vs Sovereign

Workers share application builds and policy semantics. Sovereign uses local Temporal and local inference/storage/identity, without mandatory vendor SaaS telemetry. Release manifests pin package, workflow and database compatibility. Benchmark separately the web and worker fleets under realistic concurrency.
