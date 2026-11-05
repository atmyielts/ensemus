# Threat model — Ensemus trust boundaries and abuse cases

## 1. Assets to protect

Customer business records; confidential documents, trade secrets, and source artifacts; credentials and identity tokens; customer model account credentials and inference budgets; Work Unit outcomes and external side effects; corporate memory/provenance; audit evidence; licensed Sovereign installations; billing/usage integrity.

## 2. Threat actors and entry points

External attacker via browser/API, compromised employee account, malicious tenant administrator, rogue integration/MCP server, untrusted document sender, compromised software dependency, hostile agent/skill package, misconfigured operator, provider compromise or accidental provider policy drift, compromised build/update pipeline.

Entry points: auth flows, webhooks, attachments, connectors, model prompt input, tool outputs, embedding payloads, exported artifacts, admin APIs, workflow events, package marketplace, debug logs, support bundles, and upgrades.

## 3. Risk register

| Risk ID | Scenario | Control | Required test |
|---|---|---|---|
| SEC-001 | Cross-tenant DB fetch using guessed UUID | Composite FKs, RLS, authz | Multi-tenant direct API/SQL tests |
| SEC-002 | Search returns private source through index/cache | Source ACL, index scope, last-mile recheck | Revoked-document and filter tests |
| SEC-003 | Prompt injection asks agent to export files | Untrusted data boundary, tool ACL, egress allowlist | Poisoned document scenario |
| SEC-004 | Model chooses unapproved provider | Server-side policy-first routing | Forced fallback scenario |
| SEC-005 | Secret enters debug trace | Redacted telemetry, log scrubbing, forbidden payload types | Canary secret test |
| SEC-006 | Externally sent email duplicated on retry | Idempotency/reconciliation, unknown-state stop | Timeout-after-send simulation |
| SEC-007 | Agent escalates tool privileges | Immutable grants, delegated intersection | Malicious plan/tool call test |
| SEC-008 | Rogue connector steals credentials | Vault handles, scoped tokens, server allowlist | Compromised connector fixture |
| SEC-009 | Memory poisoning changes company policy | Evidence/trust state, no model-policy write | Injected SOP fixture |
| SEC-010 | Endless delegation exhausts account credits | Hard budgets, child limits, circuit breakers | Recursion stress test |
| SEC-011 | Unauthorized support access | Zero standing content rights, break-glass audit | Support RBAC test |
| SEC-012 | Malicious package in customer installation | Signatures, SBOM, scans, pinning | Tampered release artifact |
| SEC-013 | Sovereign package phones home | Egress test, offline profile, dependency review | Air-gap packet capture |
| SEC-014 | Stale approval authorizes changed payload | Immutable action hash + expiry | Edit-after-approval scenario |
| SEC-015 | Wrong tenant in async worker context | Server-derived actor/tenant, transactional binding | Concurrent mixed-tenant jobs |
| SEC-016 | Customer provider key exposed in UI/export | One-way secret capture, encrypted refs | Export/redaction test |

See `specifications/threat-register.csv` for risk owner, severity, and control verification tracking.

## 4. Prompt injection model

A model might follow malicious instructions inside lower-trust business content. Defenses: separate trusted policy from untrusted retrieval, restrict external resource content to data-only representation, minimize tools, validate model-produced tool arguments, require authorization and approvals outside model, apply outbound network constraints, and red-team representative workflows. A text classifier can be an additional signal, never the sole authorization boundary.

## 5. Supply-chain and code execution

Use signed build artifacts, pinned packages, separate CI signing identity, vulnerability scanning, SBOM and dependency/license review. Sandboxed execution for customer/third-party code with no ambient credentials and restricted network. Non-code declarative skills also require review: instructions can still induce harmful permitted behavior.

## 6. Risk acceptance process

Each residual high/critical risk has named owner, mitigation plan, deadline, evidence, and formal exception approval. "LLM usually refuses" is not a valid mitigation for unauthorized tool access. Align review categories with OWASP Agentic Top 10 (2026) and NIST AI RMF, while adapting to actual jurisdiction and customer agreements.
