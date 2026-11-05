# Migration from Ensemus Documentation v1.0 → v2.0

**Type:** Architecture baseline revision (no deployed application is asserted). **Decision date:** 2026-11-05. The approved product scope, security principles, Work Unit kernel, memory strategy and three commercial modes are preserved. The implementation stack and deployment topology are superseded.

## Decision diff

| v1.0 | v2.0 target | Change required |
|---|---|---|
| Django/DRF business API | Next.js App Router web + backend-for-frontend | Replace Python framework modules, auth boundary and API handlers with server-only TS domain services, Next Route Handlers, Server Actions and RSC queries |
| FastAPI/Python agent workers | Headless Node/TypeScript workers | Re-express agent runtime, tool registry, ingestion and eval interfaces in strict TypeScript |
| Pydantic models | Zod and JSON Schema/OpenAPI | Regenerate contracts, tests and typed DTOs; verify runtime parity |
| Python Temporal SDK | Temporal TypeScript SDK | Reimplement deterministic workflows and typed Activities; version histories if migrating an existing system |
| LiteLLM gateway recommended | Ensemus router + AI SDK/direct provider adapters | Remove mandatory proxy; preserve policy-first selection, rates, usage and conformance |
| ORM unspecified | Drizzle + reviewed SQL migrations | Re-express tables while keeping tenant-safe constraints/RLS; migration scripts remain reviewed SQL |
| Separate frontend/API/worker services | **One Next.js web service, separate workers, shared packages** | Reduce deployables/public HTTP surfaces, keep independent execution resources |
| Cloud service candidates | Container-first and cloud-neutral | Release images, Compose references, offline dependencies and signed entitlements |
| SaaS-centric conveniences | Sovereign offline parity as release gate | No mandatory vendor license/telemetry/host dependency |

## Files most affected

`00-foundation/03-decisions-and-adrs.md`, all `02-architecture/*`, `03-intelligence/01-03`, `03-intelligence/06`, `AGENTS.md`, delivery and operational runbooks, system diagrams, TypeScript ports and deployment references. Product PRD, core relational graph, policy model, privacy contracts and commercial terms carry forward with adjustments, not redesign.

## Implementation migration if an older codebase exists

1. Inventory v1 endpoints/entities/migrations and compare to new TypeScript contracts before data movement.
2. Preserve PostgreSQL schema and data; prefer in-place audited migrations rather than export/import to avoid new exposure.
3. Port business services and authorization with contract tests first; shadow compare outputs on synthetic/redacted fixtures.
4. Port Temporal workflows using history/replay-compatible versioning or drain/handoff plan; never assume cross-language worker histories are automatically interchangeable.
5. Replace model transport only after conformance and egress tests; migrate secrets through controlled rotation, never copy keys to source/files.
6. Cut over web and workers independently with compatibility windows, audit trails and rollback plan.

## Non-negotiable continuity

Tenant IDs and resource ownership, source provenance, approval payload hashes, idempotency receipts, model policy, data export and perpetual offline license rights must survive a migration. Old file references should not be treated as current architectural authority where contradicted by v2 ADRs.
