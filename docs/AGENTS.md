# AGENTS.md — mandatory implementation rules for AI coding agents

**Project:** Ensemus 2.0 — universal AI-native company operating system. **This is a documentation suite, not an implemented application.** All coding agents must follow these requirements and report actual test status. Product intent: outcomes and humans+agents, company secrets protected, three commercial modes, easy private/cloud deployment.

## Technology constraints (approved)

- **One web/API framework:** Next.js App Router with supported Node.js LTS, strict TypeScript. It is the only customer-facing HTTP server.
- **No work inside HTTP runtime:** Autonomous agent loops, heavy ingestion, scheduled sync, and Temporal pollers execute as separate Node processes/containers from shared monorepo code.
- **State:** PostgreSQL + reviewed Drizzle migrations, tenant-safe FKs, RLS, ABAC; Temporal sole durable workflow authority; Valkey ephemeral cache; object storage for bytes.
- **Models:** Ensemus policy-first router with AI SDK/direct adapters; provider registry and BYOM secrets vault. LiteLLM is not required. No automatic unapproved fallback.
- **Packages:** pure domain; server-only DAL; policy; contracts; agent runtime; memory; integrations; commercial; UI. Enforce package import direction.
- **Hosting:** build signed, digest-pinned Docker images usable identically in Cloud/BYOM and offline Sovereign. No required Vercel, hosted Ensemus telemetry, or SaaS license heartbeat.

## Priority order

1. Confidentiality, tenant isolation, provider egress, least privilege, revocation.
2. Integrity: Work Unit, approval payload hash, idempotent and verified external actions.
3. Reliability: durable workflow continuation, honest failures, backups, migration and cancellation.
4. Measured performance: no CPU blocking web process, bounded concurrency, cost/verified outcome.
5. UX quality: finished usable behavior, not fake screens or overengineered configuration.
6. Clear, testable change records and source/release reproducibility.

## Required workflow for each task

1. Read `README.md`, `00-foundation/03-decisions-and-adrs.md`, `00-foundation/adr/ADR-024-build-start-runtime-contracts.md`, `06-delivery/02-ai-engineering-playbook.md`, exact domain/security docs and backlog ID. Work only on tickets in the current milestone of `06-delivery/06-end-to-end-delivery-plan.md`.
2. State acceptance criteria and privacy/mode impacts; document proposed schema/API/event changes.
3. Write tests for success **and** denied cross-tenant/unsafe cases.
4. Implement one complete vertical slice (UI → authorization → domain → durable execution if needed → verification).
5. Run format, lint, TypeScript typecheck, migration/integration, unit/e2e/security and relevant agent eval; report only commands actually run.
6. Update docs and ADRs, generated contracts, deployment configuration, compatibility and release tests.

## Absolute prohibitions

No Django/FastAPI or second backend by default. No model-issued grants, raw secrets or company documents in logs/prompts/telemetry without policy. No client-side database access. No global cache of tenant-sensitive material. No exposing `NEXT_PUBLIC_` secrets. No unapproved provider/model/embedding egress. No browser/server arbitrary HTTP tool access without SSRF protections. No silent external side-effect retries. No long-running agents in Server Actions/Route Handlers. No cloud phone-home for Sovereign. No "complete" claim for placeholder or untested features.

## Return contract

At handoff, provide: backlog IDs, files changed, implemented behavior, commands run and actual results, migrations, secret/config changes, Cloud/BYOM/Sovereign checks, performance and security evidence, incomplete items, and manual reproduction. If an action was not executed, say so.
