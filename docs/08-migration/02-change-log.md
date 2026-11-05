# Version history

## 2.0 — 2026-11-05 (M1 build)

- Added [ADR-025](../00-foundation/adr/ADR-025-m1-implementation-decisions.md), recording decisions made while building M1, including a fifth database role and the closed Server Action key spike.
- Moved the suite into the product repository under `docs/`.
- Added the [M1 evidence report](../06-delivery/evidence/M1-report.md) and updated ticket statuses from test results.

## 2.0 — 2026-11-05 (M0 reconciliation)

- Accepted [ADR-024](../00-foundation/adr/ADR-024-build-start-runtime-contracts.md) with two corrections: the `SecretBroker` moves to M1, and all three commercial modes are launch targets.
- Added the [end-to-end delivery plan](../06-delivery/06-end-to-end-delivery-plan.md), which now sets milestone order.
- Amended the secrets, tenancy, deployment and runbook documents for built-in secrets, narrow database roles and no web path to Temporal.
- Aligned package and worker names, `WorkUnitState`, tenant binding (`set_config`) and the worker base image.
- Rebuilt the backlog: retired 10 duplicate tickets, narrowed 4 overlapping pairs, fixed dependencies, added missing work and assigned every ticket a milestone.
- Added a traceability matrix and a backlog validator. These show planned coverage only; **nothing is implemented or tested**.

## 2.0 — 2026-11-05 (proposed baseline)

- Replaced Django/DRF/FastAPI Python-first deployment with Next.js App Router + server-only TypeScript packages and separate Node workers.
- Standardized Drizzle ORM/SQL migration boundary and Zod/JSON Schema contracts.
- Replaced mandatory inference proxy assumption with Ensemus policy router + replaceable AI SDK/direct adapters.
- Defined web/worker/ingestion/dispatcher process topology, Node event-loop and HTTP lifetime safeguards.
- Added monorepo package graph, Next.js RSC/Actions/Route Handler guidance, edge/caching security, offline container packaging, release signatures, air-gap tests and mode parity matrix.
- Retained company/work/knowledge graph relational foundations, layered memory, Temporal, pgvector, zero-trust provider egress, and three commercial licensing modes.
- Expanded backlog, QA, operational and coding-agent materials for the new runtime.

## 1.0 — 2026-11-05 (historical)

Initial comprehensive product and engineering architecture proposed with Django/DRF, Python workers and an optional LiteLLM gateway. **Superseded**, retained separately in original archive.
