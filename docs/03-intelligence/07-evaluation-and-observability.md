# Evaluation, AI quality, observability, and runtime diagnostics

## 1. Quality philosophy

A generated answer is not a completed business outcome. Evaluate **task success**, groundedness, policy compliance, human correction, cost, latency, and recovery. Every publishable Agent Version must pass deterministic contract tests and scenario-specific evaluations.

## 2. Multi-layer evaluation

1. **Contract:** JSON schema, tool arguments, required citations, output invariants.
2. **Functional:** required result/artifact exists, correct business state and external receipt.
3. **Grounding:** important claims linked to permitted sources; no fabricated citations.
4. **Security:** no cross-tenant retrieval, forbidden provider routing, secret leakage, approval bypass or unauthorized tools.
5. **Operational:** timeout/retry/partial failure/cancel/restart, idempotency.
6. **Human review:** expert assessment on sensitive, subjective, or high-value tasks.

Run evaluations on synthetic/consented fixtures; never export real customer data to new evaluators without explicit tenant and provider authorization.

## 3. Experiment identity

Each score records task fixture version, agent version, skill version, prompt digest, model deployment/version, policy version, context compiler version, source corpus revision, test runner version, and scorer definition. Comparisons lacking this context are not reproducible.

## 4. Runtime tracing

Propagate trace IDs across API → outbox → Temporal → agent worker → tool gateway → provider adapter. Default span attributes: tenant pseudonymous ID, run ID, step type, model alias, token totals, cost, duration, tool name/class, policy decision code, status, error type. Do not record raw prompts, source passages, API keys, or sensitive outputs by default.

**Diagnostic exceptions:** customer-authorized, narrowly scoped, expiring capture with redaction and restricted access, ideally using synthetic reproduction first. Sovereign default telemetry is local and any vendor support bundle must be customer-approved.

## 5. Recommended tools

OpenTelemetry as vendor-neutral traces/metrics foundation. Langfuse OSS can provide AI evaluation and trace viewing, but its self-host deployment/telemetry/licensing characteristics must be audited for the customer's data mode; do not rely on a paid enterprise feature without license. Tooling is replaceable behind an internal telemetry adapter.

## 6. Metrics

| Metric | Interpretation |
|---|---|
| Verified Work Unit completion rate | End-to-end product value |
| Cost per accepted outcome | Economic quality |
| Correction/revision rate | Human effort left behind |
| Unauthorized action / leak attempts blocked | Safety control coverage |
| Policy false-positive rate | Usability of security controls |
| Retrieval ACL recall & citation validity | Company knowledge accuracy |
| Agent run termination by cause | Reliability and budgeting |
| Provider p50/p95 latency, timeouts, price drift | Routing performance |
| Approval wait time | Business process bottlenecks |
| Connector sync lag | Source freshness |

## 7. Release gates

A model/agent upgrade requires no critical security regressions, task quality at or above accepted baseline (or approved trade-off), spend within budget, stable performance on named scenarios, and verified rollback. Use canaries/shadow tests only with permitted data. Store regression cases from incidents with confidentiality preserved.
