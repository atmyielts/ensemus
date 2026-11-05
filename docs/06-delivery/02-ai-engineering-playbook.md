# Coding-agent execution playbook for Ensemus 2.0

## Read before coding

`README.md` → `AGENTS.md` → `00-foundation/03-decisions-and-adrs.md` → relevant domain/security docs → `02-architecture/11-monorepo-and-module-contracts.md` → `06-delivery/03-acceptance-and-dod.md` → tracked issue.

## Nonnegotiable technology decisions

- Next.js App Router on supported Node.js LTS is **the only customer-facing HTTP/API runtime**. No Django/FastAPI/NestJS/Fastify added casually.
- All first-class business/agent/workflow code is **strict TypeScript**, with Zod runtime validation and Drizzle/PostgreSQL; React client bundles remain free of server-only modules.
- Long-lived execution uses separate Temporal TypeScript workers; no background polling or CPU-heavy tasks inside `next start`.
- PostgreSQL holds business truth; Temporal holds workflow execution truth; Valkey and indexes are rebuildable. Apply tenant RLS and ABAC to every route and worker.
- AI SDK may be used for model transport but model routing, egress policy, quality/cost evaluation and BYOM selection belong to Ensemus.
- One source/build contracts for Cloud/BYOM/Sovereign; offline Sovereign must not require hosted Ensemus/Vercel services.

## Work unit for a coding agent

1. Choose exact requirement/backlog ID, describe customer-visible outcome and tests.
2. Identify touched modules, table/contract migrations and deployment-mode impacts.
3. Implement Zod/API/domain contracts and data permissions before UI.
4. Write failing positive/negative tests (tenant crossover, denial, approval stale, tool side effect replay).
5. Implement one complete vertical slice, including actual persistence and working UI; no demo placeholders masquerading as product features.
6. Add redacted telemetry and budget/failure handling.
7. Run format/lint/typecheck/DB migration tests/unit/integration/e2e/agent eval as relevant; report exact commands and pass/fail.
8. Update docs/ADRs, compatibility matrix, release notes, security checks, and implementation tracking.

## Prohibited shortcuts

No unscoped raw SQL APIs, no global mutable tenant context, no arbitrary model base URL, no prompt-driven authorization, no storing provider keys in PostgreSQL plain fields, no raw secrets in agent prompts or traces, no globally cached confidential RSC payloads, no duplicate consequential actions on retry, no local filesystem business artifact storage, no hidden Cloud-only dependency in Sovereign, no user-facing fake buttons or placeholder flows claimed complete.

## Code style

Strict TS, named domain/service interfaces, Zod at I/O edges, structured and redacted errors, deterministic pure domain functions, Drizzle transactions, reviewed SQL for RLS, explicit dependency injection, `server-only` for private modules, smallest imports and public package exports. No agent loop in a Server Action/Route Handler. Use interface contracts to allow future native/Python specialized worker only after ADR and measurements.

## Mandatory final implementation report

List change IDs/files, actual functionality, tests executed and results, migration/secret configuration, Cloud/BYOM/Sovereign validation, security/privacy impact, performance/cost observations, residual issues and manual verification steps. Say explicitly what is **not** implemented.
