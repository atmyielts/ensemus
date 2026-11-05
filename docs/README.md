# Ensemus 2.0 — Complete Product & Engineering Documentation

**Date:** 2026-11-05  
**Status:** Approved direction / proposed implementation specification; **not implemented or security-certified**.  
**Audience:** Product, architects, TypeScript/Next.js engineers, AI coding agents, security, operations, legal and commercial teams.

> **Mission:** An AI-native company operating system in which people and permissioned agents coordinate, execute, verify, and remember company work. One product that adapts to different organizations—not a pile of disconnected chatbots.

## Approved implementation baseline

- **Next.js App Router full-stack:** One user-facing Node.js web and HTTP API application. UI, Server Components, Route Handlers and Server Actions share server-side TypeScript domain services. No required Django, FastAPI, NestJS or Go backend.
- **Separate Node/TypeScript execution processes:** Temporal workflows/Activities, bounded agent runs, ingestion and event dispatch never depend on an HTTP request lifetime; they can run on the same host as isolated containers, and scale independently.
- **Core stores:** PostgreSQL + pgvector (typed company/work/knowledge graphs and operational facts), Valkey (ephemeral cache), S3-compatible object store (artifacts), Temporal (durable workflow history). Drizzle ORM + reviewed SQL for RLS/triggers/migrations.
- **Model neutrality:** Ensemus capability + policy router above AI SDK/direct provider adapters. No mandatory LiteLLM proxy, provider-hosted gateway or proprietary cloud hosting.
- **Container-first, cloud-neutral:** Signed/digest-pinned images and one release contract for managed SaaS, BYOM SaaS and customer-operated Sovereign. Offline customer installations must function without Ensemus/Vercel network services.
- **Highest priority:** Company secrets; tenant and resource authorization; confidential model egress; approval-bound consequential tool execution; traceable recovery and verified outcomes; performance and cost-per-successful-Work-Unit.

## The three commercial modes

| Mode | Ensemus customer buys | Model responsibility | Where data and execution run |
|---|---|---|---|
| **Cloud** | Recurring platform subscription including a clearly specified AI allowance | Ensemus supplies approved model access; top-ups only when explicitly authorized | Ensemus SaaS |
| **BYOM** | Recurring platform-only subscription | Customer supplies/pays own approved provider keys/private endpoint | Ensemus SaaS; **not zero-knowledge hosting** |
| **Sovereign** | Perpetual one-time software-use license; optional separate maintenance | Customer supplies/models and infra | Customer-controlled infrastructure, including offline/air-gapped deployment |

**Sovereign entitlement must not expire when maintenance ends.** Perpetual software license is not an IP/source-code/resale transfer without separately negotiated agreement. No price, SLA, certification, or legal jurisdiction is implied by this design suite.

## Invariants

1. Model output is never an authorization grant. Restricted company data is denied external inference by default.
2. Every server path checks actor/tenant/resource policy; DB foreign keys and RLS are defense in depth.
3. Work Units represent outcomes, AgentRuns represent bounded attempts, Temporal owns durable execution and approval waits.
4. Temporal workflow code is deterministic; all external I/O/model/tool calls are Activities with idempotency/reconciliation.
5. Long-running agents and CPU indexing do not run in Next.js request processes.
6. PostgreSQL is the business source of truth, external providers own their source records, indexes/cache are derived.
7. No provider endpoint, connector scope or credential can be introduced through a prompt or document.
8. Cloud/BYOM/Sovereign share data/contracts and are tested for parity.
9. Every published release is portable, traceable and verifiable offline where applicable.
10. No placeholders misrepresented as production functionality.

## Quick entry points

- [Architecture overview](ARCHITECTURE_OVERVIEW.md)
- [Instructions to AI coding agents](AGENTS.md)
- [v1 → v2 architecture transition](08-migration/01-v1-to-v2-architecture-transition.md)

## Reading order

**New engineers/AI coding agents:** `AGENTS.md` → principles → ADRs → system architecture → Next.js boundary → monorepo contract → security → domain/data → agent runtime → delivery gates.

**Operators:** deployment topology → container runbook → backup/recovery → air-gap acceptance.

**Commercial/legal:** modes → licenses and entitlements → responsibility matrix → data portability.

## Documentation index

### Foundation and governance

- [Ensemus design principles and non-negotiable invariants](00-foundation/01-principles.md)
- [Canonical glossary and semantics](00-foundation/02-glossary.md)
- [Architecture decisions — Ensemus 2.0](00-foundation/03-decisions-and-adrs.md)
- [ADR-024: runtime contracts](00-foundation/adr/ADR-024-build-start-runtime-contracts.md)
- [Document governance and implementation discipline](00-foundation/04-doc-governance.md)

### Product and commercial UX

- [Product Requirements Document (PRD) — Ensemus](01-product/01-product-requirements.md)
- [Personas, permission assumptions, and critical user journeys](01-product/02-personas-and-journeys.md)
- [UX, information architecture, and interface quality](01-product/03-experience-design.md)
- [Capability catalog and extensibility roadmap](01-product/04-capability-catalog.md)
- [Three commercial modes — functional, security, and deployment contract](01-product/05-commercial-modes.md)
- [Packaging, pricing logic, and unit economics](01-product/06-packaging-and-economics.md)

### Technical architecture

- [System architecture — full-stack Next.js, TypeScript workers, portable infrastructure](02-architecture/01-system-architecture.md)
- [Domain model — bounded contexts, aggregates, relationships](02-architecture/02-domain-model.md)
- [Relational database design and complete table catalog](02-architecture/03-data-model.md)
- [Universal Work Kernel — execution state and work graph](02-architecture/04-work-kernel.md)
- [Domain events, consistency, retries, and orchestration](02-architecture/05-events-and-consistency.md)
- [API, Server Action and external contract design](02-architecture/06-api-contracts.md)
- [Tenant isolation, access graphs, and sovereignty](02-architecture/07-multitenancy.md)
- [Deployment topologies and installation profiles — one release, three modes](02-architecture/08-deployment-topologies.md)
- [Performance engineering and scalable execution](02-architecture/09-performance-scaling.md)
- [Next.js App Router: server boundary, rendering and security](02-architecture/10-nextjs-application-and-authorization.md)
- [TypeScript monorepo structure and module rules](02-architecture/11-monorepo-and-module-contracts.md)
- [Transactions, event consistency, migration protocol](02-architecture/12-data-consistency-and-migrations.md)

### Agents, routing and knowledge

- [Model-neutral intelligence routing — TypeScript-native, policy first](03-intelligence/01-model-routing.md)
- [Agent runtime and durable orchestration — TypeScript contract](03-intelligence/02-agent-runtime.md)
- [Agent Studio, skills, tool contracts and publishing](03-intelligence/03-agent-studio-and-skills.md)
- [Organizational memory — typed knowledge, scoped retrieval and evidence](03-intelligence/04-memory-and-knowledge.md)
- [Context compiler — minimum sufficient authorized context](03-intelligence/05-context-compiler.md)
- [Connectors, tool gateway, MCP and side-effect safety](03-intelligence/06-integrations-and-tools.md)
- [Evaluation, AI quality, observability, and runtime diagnostics](03-intelligence/07-evaluation-and-observability.md)
- [AI-specific safety architecture — policy beyond prompts](03-intelligence/08-agent-safety.md)
- [TypeScript worker runtime: process topology and throughput](03-intelligence/09-typescript-worker-runtime.md)

### Security and confidentiality

- [Security blueprint — customer secrets and organizational trust](04-security/01-security-blueprint.md)
- [Secrets, model-provider egress, and confidential information handling](04-security/02-secrets-and-egress.md)
- [Threat model — Ensemus trust boundaries and abuse cases](04-security/03-threat-model.md)
- [Authorization, service identities, approval chains, and audit](04-security/04-authorization-and-approvals.md)
- [Data protection, privacy, lifecycle, and portability](04-security/05-data-lifecycle.md)
- [Security assurance, regulatory readiness, and incident response](04-security/06-assurance-and-incidents.md)
- [Next.js / Node / supply-chain-specific threat controls](04-security/07-nextjs-node-security.md)

### Operations, performance and deployment

- [Reliability model, SLOs, error budgets, and incident operations](05-operations/01-slos-and-reliability.md)
- [Deploy, upgrade, back up and recover Ensemus 2.0](05-operations/02-deployment-and-recovery.md)
- [Quality engineering and test pyramid](05-operations/03-testing-quality.md)
- [Efficiency, cost controls, and capacity planning](05-operations/04-cost-and-capacity.md)
- [Container-first runbook (reference design, not runnable product)](05-operations/05-container-deployment-runbook.md)
- [Performance, load and chaos test plan](05-operations/06-performance-and-load-plan.md)

### Engineering delivery

- [End-to-end delivery plan: milestones M0–M11 to launch in all three modes](06-delivery/06-end-to-end-delivery-plan.md)
- [Ensemus 2.0 implementation program — full vision, vertical slices](06-delivery/01-build-plan.md)
- [Coding-agent execution playbook for Ensemus 2.0](06-delivery/02-ai-engineering-playbook.md)
- [Acceptance criteria, Definition of Done, and non-negotiable release gates](06-delivery/03-acceptance-and-dod.md)
- [Release readiness checklists and failure scenarios](06-delivery/04-release-checklists.md)
- [Environment profiles, build reproducibility, CI/CD and release](06-delivery/05-environment-and-ci-cd.md)

### Licensing and business models

- [Commercial licensing and maintenance terms — design outline (not legal advice)](07-commercial/01-license-and-maintenance.md)
- [Entitlements, metering, invoicing, and fairness](07-commercial/02-entitlements-and-billing.md)
- [Customer data portability, migration, offboarding, and reversibility](07-commercial/03-data-portability-and-exit.md)
- [Commercial modes: deployment, model ownership and support responsibilities](07-commercial/04-deployment-and-support-matrix.md)

### Version transition

- [Migration from Ensemus Documentation v1.0 → v2.0](08-migration/01-v1-to-v2-architecture-transition.md)
- [Version history](08-migration/02-change-log.md)

### Specifications and reference artifacts

- [Reference SQL schema](specifications/schema.sql) — conceptual DDL, **not a production migration**; translate to Drizzle and review security SQL.
- [OpenAPI 3.1 reference](specifications/openapi.yaml) — intended Next.js `/api/v1` Route Handler contracts.
- [Traceability matrix](specifications/traceability.csv), [retired tickets](specifications/backlog-retired-tickets.csv) and [backlog validator](specifications/tools/check-backlog.mjs): every requirement, QA scenario, threat and gate mapped to tickets.
- [Implementation backlog](specifications/implementation-backlog.csv) and [QA scenarios](specifications/qa-scenarios.csv) — track work and acceptance.
- [Threat register](specifications/threat-register.csv), [Data egress matrix](specifications/data-egress-matrix.csv), [Model conformance matrix](specifications/model-conformance-matrix.csv).
- [JSON schemas](specifications/schemas/), [Agent and policy examples](specifications/examples/), [TypeScript port references](specifications/typescript/).
- [Mermaid diagrams](specifications/diagrams/), [Deployment templates](specifications/deployment/), [Sovereign offline acceptance](specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md).
- [External references and validation ledger](SOURCES.md).

## Build guidance and hierarchy

In conflicts, **v2 ADRs and security invariants take priority**, followed by current architecture/domain specs and validated contracts. The v1 to v2 migration note explains superseded Python implementation choices; v1 archive is historical, not the active implementation plan. Example code, SQL, Compose and Dockerfiles illustrate contracts only; a running product is **not** included.

**Approval gates before commercial launch:** legal/privacy review, per-component licensing and redistribution audit, threat model and penetration test, provider contract verification, actual load and restore benchmarks, SLO/RTO/RPO decisions, signed release + SBOM, Cloud/BYOM/Sovereign mode parity, and air-gap egress proof.
