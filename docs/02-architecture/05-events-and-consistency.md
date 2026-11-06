# Domain events, consistency, retries, and orchestration

## 1. Event philosophy

Business changes emit **facts that already happened**, not imperative commands masquerading as events. Commands request behavior; events report committed transitions. Use versioned event envelopes shared across Cloud, BYOM, and Sovereign.

## 2. Event envelope

Required: `event_id` (UUID), `event_type`, `schema_version`, `organization_id`, `aggregate_type`, `aggregate_id`, `aggregate_version`, `occurred_at`, `actor` (principal class and ID), `correlation_id`, `causation_id`, `classification`, `payload`. Optional: `source_connection_id`, origin region, external event ID. See `specifications/schemas/domain-event.schema.json`.

Example types: `organization.member_added`, `work.created`, `work.assigned`, `work.dependency_resolved`, `work.completed`, `approval.requested`, `approval.resolved`, `agent.run_started`, `agent.run_finished`, `integration.sync_completed`, `knowledge.source_revoked`, `provider.profile_changed`, `entitlement.changed`.

## 3. Transactional outbox

Write domain state, domain event, and outbox dispatch row in a single PostgreSQL transaction. An asynchronous dispatcher publishes queued outbox records. Publish at-least-once; all consumers must dedupe via `(consumer_id, event_id)` in their own inbox or an equivalent transactional idempotency store. Do not claim exactly-once delivery across external services.

## 4. Temporal and database boundaries

Temporal workflow instance ID should include tenant and Work Unit version-safe identity; actual business facts remain in PostgreSQL. Start workflows using outbox/event dispatch or deterministic coordination; replay must not repeat model calls or external side effects. All nondeterministic I/O belongs in activities. Child workflows may handle parallel subtasks, but bounded recursion and task queues are required.

## 5. Ordering and conflicts

Consumers use per-aggregate version monotonicity, reject stale writes, and handle out-of-order events by fetching authoritative state or retrying. Cross-aggregate ordering is not guaranteed. Use optimistic locking for user edits and a conflict-resolution UI instead of last-write-wins on critical records.

## 6. Failure handling

Transient retry with exponential backoff + jitter; retry budget per action class; circuit breaker for outages; dead-letter/manual review queue for poison messages; do not log sensitive payloads. A webhook must have its signature and timestamp verified where supported and its provider event ID deduped, and the handler returns quickly: it stores what arrived, and a worker does the verifying ([ADR-027](../00-foundation/adr/ADR-027-verified-external-actions.md) D4).

## 7. Projection repair and replay

Maintain projectors for search, activity timeline, graph views, and metrics. Store projection versions/watermarks. Rebuild from authorized source records/events after migrations or corruption. Historical replay must not resend emails, submit orders, or mutate external systems: use explicit replay/simulation mode that disables side effects.

## 8. Event retention

Operational events, security audit events, and temporary inference traces have different retention. Some records are subject to legal hold; deletion requests must remove/irreversibly pseudonymize personal content as legally permitted without corrupting business ledger integrity. Store redacted payloads in audit trails by default.
