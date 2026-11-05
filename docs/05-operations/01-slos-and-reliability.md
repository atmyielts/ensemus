# Reliability model, SLOs, error budgets, and incident operations

## 1. Service classes

Interactive API and UI; Work Unit durable processing; provider inference; connector synchronization; search/index freshness; artifact storage; administrative/billing plane. Service-level objectives must distinguish availability of Ensemus core from availability of a customer's third-party models or connectors.

## 2. Initial internal objectives (proposed, not promises)

| Surface | Planning SLI / objective | Notes |
|---|---|---|
| Authenticated core API | Availability ≥ 99.9% measured monthly | Exclude planned windows only if contract permits |
| User-facing API latency | p95 read < 300 ms, write < 500 ms server-side | Controlled dataset, excluding client/network |
| Durable enqueue | ≥ 99.99% accepted Work Units recovered after process crash in test | Correctness suite, not commercial uptime |
| External action integrity | No duplicate consequential side effects in fault suite | Reconciliation can require human review |
| Connector freshness | Per-connector target and lag indicators | Depends on external provider quota/outage |
| Knowledge ACL revocation | Block access at serving policy gate immediately | Projection repair may finish asynchronously |
| Agent task completion | Per-skill success threshold based on evaluations | Not universal across all tasks |

Business/legal should agree paid SLA, support hours, exclusions, credits and event reporting only after measured production readiness.

## 3. Observability and alerts

OpenTelemetry traces with policy-safe attributes, metrics for latency/error/queue wait, logs without payload secrets, durable run errors, provider circuit breaker status, connector sync lag, database saturation, and billing anomalies. P0 alerts for cross-tenant policy signals, forbidden egress, compromised keys, or repeated duplicate side effects. Less severe alerts are batched to avoid interrupting operators needlessly.

## 4. Failure isolation

Third-party inference unavailable → core editing/search (where possible) continues; agent runs pause/timeout with visible status. Temporal unavailable → existing workflow execution pauses, domain writes continue where safe. Search unavailable → transactional reads continue; UI indicates reduced knowledge capability. Connector inaccessible → stale-source state, safe retry queue, no synthetic success.

## 5. Error budgets

Track customer-visible errors and timeouts by service tier and workload. When error budget burns too rapidly, freeze risky changes, reduce optional background tasks, and prioritize reliability fixes. Public status messaging should distinguish Ensemus outage from provider-dependent degradation.

## 6. On-call runbooks

Maintain runbooks for DB pressure, Temporal task queue backlog, model provider outage, rate limit storms, connector webhook poison events, identity misconfiguration, compromised credential, and storage outage. Each runbook needs diagnosis, reversible mitigation, safe fallback, communication, and post-incident verification.
