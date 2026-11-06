# Architecture decisions — Ensemus 2.0

**Status:** Approved product direction, architecture baseline pending benchmark and threat-model validation. 2026-11-05. These decisions supersede conflicting version 1.0 implementation choices. They do not imply the system is built.

| ADR | Decision | Rationale | Constraint / revisit |
|---|---|---|---|
| ADR-001 (superseded) | ~~Django/DRF + Python agent services~~ | Former baseline | Superseded by ADR-015; no Python required in core |
| ADR-002 | PostgreSQL + pgvector are initially authoritative/derived stores | Transactional integrity, typed graph edges, retrieval | Specialized search/graph store only after measured need |
| ADR-003 | Temporal is sole durable workflow coordinator | Approvals, waits, scheduling and recovery | Workflow code must be deterministic; I/O in Activities |
| ADR-004 (amended) | Ensemus capability router above provider adapters | Privacy and cost policy before routing | AI SDK is optional transport; no mandated LiteLLM proxy |
| ADR-005 | Immutable versioned agents, budgeted runs and typed steps | Auditability and reproducibility | Avoid second competing agent workflow authority |
| ADR-006 | Work Unit + bounded dependency DAG | Cross-industry execution core | Domain entities remain typed; custom objects are validated |
| ADR-007 | Tenant-safe FKs + PostgreSQL RLS + application ABAC | Defense in depth | Test pooling/role leaks and cache isolation |
| ADR-008 | Hybrid structured, FTS, vector retrieval | Quality and cost | Sensitive source access prefilter required |
| ADR-009 | PostgreSQL transactional outbox/inbox | At-least-once event delivery | Reconcile downstream effects; idempotency mandatory |
| ADR-010 | One functional core, three commercial modes | Avoid product forks | Runtime entitlements only; parity contract tests |
| ADR-011 | Sovereign supports complete offline runtime | Customer sovereignty | No activation heartbeat/undisclosed egress |
| ADR-012 | Tool and provider policy external to model | Least privilege | Per-action authorization, external egress policy |
| ADR-013 | Default traces never collect raw confidential content | Data minimization | Opt-in short-lived debug with customer consent |
| ADR-014 | Licensing and SBOM review before distribution | Perpetual redistribution and OSS compliance | Confirm every packaged dependency/license |
| **ADR-015** | **Next.js App Router is Ensemus's only customer-facing application/API server** | One TypeScript product, server-side rendering, API routes, easier cloud/sovereign packaging | No persistent background loops or long-running jobs inside web process |
| **ADR-016** | **Node.js TypeScript workers are separate processes using shared packages** | Independent concurrency, failure and CPU isolation | Not independent public HTTP microservices |
| **ADR-017** | **Container-first, cloud-neutral images and deployment manifests** | Same release across Cloud, BYOM, Sovereign | No mandatory proprietary host runtime or external telemetry |
| **ADR-018** | **Drizzle ORM + reviewed SQL migrations** | Typed schema with explicit SQL control | RLS must be tested against actual PostgreSQL roles/pooling |
| **ADR-019** | **AI SDK-based or native provider adapters, not mandatory proxy** | Avoid proxy cost/hops and preserve portable model calls | Add LiteLLM gateway only when operational requirements justify it |
| **ADR-020** | **Framework-independent domain and policy packages** | Workers and Next.js share executable invariants | Client bundles must never import server-only code |
| **ADR-021** | **No vendor cloud services in Sovereign critical path** | True offline on-prem license | Local Temporal, storage, identity, models, keys, audit |
| **ADR-022** | **Web data accesses domain services directly on the server** | Avoid server-to-own-HTTP round trips | Route Handlers for external/mobile/public integrations |
| **ADR-023** | **Single logical codebase, small deployment set** | Low ops cost | Web and workers scale separately; dependencies still exist |

| **[ADR-024](adr/ADR-024-build-start-runtime-contracts.md)** | **Runtime contracts: workflow-driven agent steps, IDs only through Temporal, no web path to Temporal, narrow database roles, built-in identity and secrets** | These were undefined or contradictory, and are hard to reverse once real workflows exist | Outside security review of D4 and D5 before any real credential is stored |
| **[ADR-026](adr/ADR-026-tombstones-survive-restore.md)** | **Tombstones are also kept in a ledger outside the database, re-applied after a restore, and a tenant is refused while its database is behind that ledger** | A tombstone in the database cannot protect against restoring that database | One more object-store credential, a listing per active tenant every 30 seconds, and a window for deletions that never reached the ledger |
| **[ADR-027](adr/ADR-027-verified-external-actions.md)** | **An external action is an immutable intent bound to its approved hash. An attempt is committed before any byte leaves, and a trigger refuses another while one could have sent. Webhooks are stored by the web tier and verified later in a worker with no route out** | SMTP has no status lookup, Temporal retries, workers die, and the web tier cannot unseal | False unknowns that take a person's time, and a sender cannot tell at HTTP level that its signature failed. Proposed, and needs outside security review |
| **[ADR-037](adr/ADR-037-hardening-backlog.md)** | **The known gaps from M1 and M2 close without a new table: images are compared and scanned in CI, a release verifies only against a key held outside it, traces go only to a collector an operator names and only through an allowlist, a live status poll is one transaction, and a proxy that looks unnamed is reported** | Each was a named gap in the M1 report or the M2 measurements, and each is cheap now and expensive once releases exist | Reproducibility reports only until Dockerfile changes land. Proposed. D3, D4 and D5 need outside security review |

## Decision-specific implementation consequences

1. **Node runtime, not Edge by default.** Database drivers, cryptography and secret stores require tested Node runtime APIs; avoid silently moving privileged code to Edge.
2. **Server Components are not an authorization boundary.** A common server-only data access layer (DAL) checks permission at every entry point. Actions and route handlers enforce the same checks independently.
3. **Process separation is mandatory** for Temporal workers, ingestion, potentially expensive data processing, and active agents. One machine is allowed; one shared event loop for web + agents is not.
4. **No second backend framework** initially. Do not add NestJS, Fastify, Django or Go without a benchmark, isolation justification, and ADR.
5. **Real-time optional sidecar.** If collaboration requires long-lived sockets, add a slim authorized Node/WebSocket service or vetted managed solution; do not rely on serverless Route Handlers to hold persistent connections.
6. **Model neutrality is a contractual quality**: routing, capability conformance, tenant egress controls and fallback remain owned by Ensemus, not an SDK or provider.

## ADR format

```text
# ADR-NNN — Title
Status / date / owner
Context and measurable problem
Options and evidence
Decision with precise boundaries
Security, confidentiality, tenancy and data-flow effects
Cloud/BYOM/Sovereign and offline consequences
Schema, API, workflow and build migration
Benchmark, acceptance tests, rollback
Approvals
```

## Unresolved executive decisions

Legal entities/jurisdictions, final plans/pricing and included AI credits, standard support SLAs, SSO requirements by package, dedicated tenant deployment tiers, maintenance windows and perpetual major-version rights, source escrow and resale, data residency, intended regulated industries, and formal SLO/RTO/RPO commitments. These must not be invented during implementation.
