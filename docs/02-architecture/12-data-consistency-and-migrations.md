# Transactions, event consistency, migration protocol

## Transactions

All multi-record business writes (Work Unit state, approvals, audit anchor, outbox event) are wrapped in one PostgreSQL transaction via the Drizzle transaction API. Prevent race conditions with optimistic version checks (`WHERE version = expected`) or appropriate row locking. Concurrency conflict returns a typed retryable domain error. A failed publish must not roll back already committed business state; outbox retry handles it.

## Tenant constraints

Use `(organization_id, id)` uniqueness and tenant-aware composite foreign keys across dependent records. `organization_id` is derived from authenticated actor/delegation, not an untrusted request body. Enforce RLS on all tenant-scoped tables and explicitly test permissions with non-owner application DB roles. Provide explicit tenant context per transaction; no session `SET` with pooled connections. Cross-tenant unique indexes require careful policy review.

## Referential relationships and graphs

Work dependencies enforce DAG constraints in a serialized/locked command: prevent self-edge, reciprocal/cycle insertion under concurrent requests, prohibit cross-tenant reference. Preserve historical edges as versioned transitions where audit needs it. Employee/team hierarchy uses explicit constraints or reviewed recursive queries, not application-only best effort. Knowledge relations retain sources, classification, ACL derivation and temporal validity.

## Eventing

At-least-once delivery is the contract: `(consumer_id,event_id)` inbox dedupe plus idempotent handlers. Workflow-start commands have stable deterministic IDs derived from tenant and business operation; retry should refer to same logical execution. For external tools, record proposed operation → approval (if needed) → attempt → external receipt → verified effect. Never infer exactly-once external side effects from Temporal retries.

## Migration lifecycle

1. Proposed Drizzle migration and accompanying reviewed SQL for RLS, functions, extensions, triggers and indexes.
2. Apply in disposable PostgreSQL to test `up`, data integrity, query plans and rollback/compensation options.
3. Expand-compatible columns/constraints with old workers and new workers both tested.
4. Separate long-running backfills from request processes; rate limit and checkpoint.
5. Contract/removal in a later release after active workflows and Sovereign supported versions transition.
6. Record minimum DB/worker/API versions in release manifest; never assume Sovereign installs update continuously.

**Do not rely exclusively on ORM-generated migrations** to secure PostgreSQL RLS and privilege grants. Treat SQL security policies as first-class reviewed artifacts.
