# Ensemus 2.0 implementation program — full vision, vertical slices

**Sequencing authority:** the [end-to-end delivery plan](06-end-to-end-delivery-plan.md) sets the current milestone order, and the `milestone` column in the backlog assigns each ticket. Where it differs from the phases below, the delivery plan wins.

This is a comprehensive build plan, not an MVP replacement for the approved vision. Sequence by dependency and risk; do not fabricate delivery dates or test success.

## Phase 0 — TypeScript and release foundation

Create pnpm monorepo and Next.js App Router shell, strict TS and Zod contracts, Drizzle schema/migrations, DB RLS role/transaction conventions, Node Temporal SDK skeleton + separate worker image, container builds, CI build/typecheck, SBOM, signing, local object store, Valkey, secret broker abstraction, redacted tracing and release manifest. **Exit:** container build/restart works; two-tenant RLS negative tests pass; web does not run agent pollers; images contain no secrets.

## Phase 1 — Operating core

Implement organizations, memberships, teams, client/project entities, Work Units, graph/DAG constraints, artifacts, approvals, domain event outbox, accessible role-aware Next.js interface, server-only DAL, public `/api/v1`, deterministic execution and audit. **Exit:** project/workflows fully usable without models; rollback and idempotency demonstrated.

## Phase 2 — Intelligence foundation

Implement provider registry, policy-first Ensemus model router using AI SDK/direct adapters, BYOM encrypted credential capture, source classification, Context Compiler, bounded TS agent loop, published versioned agents, tool gateway, budgets, execution tracing and evaluations. Temporal coordinates durable runs. **Exit:** model swaps pass conformance, denied provider fallback fails closed, worker restart resumes without duplicate actions.

## Phase 3 — Organizational knowledge and connectors

Ingestion workers, hybrid FTS/pgvector indexes, scoped document ACL, source sync/revocation, evidence-linked facts and graph edges, source freshness, supported native connectors/MCP. **Exit:** authorized evidence-backed Q&A and revocation tests pass, cache refresh proven on multiple web replicas.

## Phase 4 — Agent Studio, UX depth, full workflows

Versioned skill/tool registry, publish review, visual workflow editor, dry run, preview of risk/cost, human approval and delegated agents, company dashboards, strong long-form work/artifact UX. **Exit:** representative cross-department workflows complete with verified receipts, traceable status and measured cost.

## Phase 5 — Sovereign productization and universality

Offline signed entitlement, air-gap install, local dependencies, export/import, upgrade/restore automation, network egress proof, custom objects and relationships, configurable department packs, multi-tenant SaaS hardening. **Exit:** release runs with internet physically blocked and no vendor service, maintenance expiry does not disable purchased version, lifecycle tests pass.

## Early full vertical slices

1. Join org → permitted server read → create Work Unit via Action → DB+outbox → worker → artifact → completed state.
2. Connector webhook → signed Route Handler → outbox → Temporal → idempotent side effect → verification.
3. BYOM model profile → vault → policy deny/allow → model → redacted trace and ledger.
4. Knowledge upload → worker parse/index → authorized retrieval → citation → permission revoke → inaccessible.
5. Sovereign image bundle → offline install → local inference → export/backup → restored license and state.

## Gates

Every slice must ship UI, domain contract, runtime enforcement, migration, security negative tests, cost metrics, operator docs and mode parity checks. No feature is marked complete because a UI route exists. See dependency-linked backlog CSV and acceptance docs.
