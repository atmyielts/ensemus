# Canonical glossary and semantics

| Term | Canonical meaning |
|---|---|
| Organization / tenant | Security, billing, data ownership, and administrative boundary |
| Workspace | Role-aware user surface for work and knowledge, not an independent security boundary by itself |
| Membership | User participation in an organization with status and role grants |
| Principal | Human, service account, or agent identity executing or requesting a capability |
| Work Unit | Versioned business objective with outcome, owner, status, criteria, and dependencies |
| Work Dependency | Directed prerequisite relation between Work Units; the active dependency graph must be acyclic |
| Assignment | Person or agent accountable for a Work Unit or step |
| Work Run | Durable orchestration of a Work Unit through its lifecycle |
| Agent Definition | Named agent identity, purpose, owner, and permissions envelope |
| Agent Version | Immutable, validated configuration including instructions, allowed skills, routing policy, and budgets |
| Agent Run | One bounded invocation of an Agent Version toward a specified outcome |
| Execution Step | One recorded thought-free operational step, model invocation, tool action, wait, or verification outcome |
| Skill | Reusable, versioned procedure/competency with schemas, instructions, validation, and tests |
| Tool | A typed, invocable operation with declared permissions, side effects, and idempotency characteristics |
| Policy | Centrally enforced authorization, data routing, risk, autonomy, and financial constraints |
| Provider Profile | Named, approved model deployment including provider, region, retention terms, keys, and allowed data classes |
| Model Route | Policy-compliant selection of a model/deployment for a request |
| Context Package | Permission-checked, size-bounded, source-backed information supplied to a model |
| Memory Fact | Versioned statement with subject, predicate, value, provenance, scope, validity, and trust state |
| Knowledge Source | Native or external origin of information with ACLs and synchronization state |
| Artifact | Durable human-readable or machine-readable result of work |
| Approval | Authorized human decision tied to action parameters, source evidence, expiry, and policy |
| Entitlement | Billable and/or licensed access to features, capacities, and deployment capabilities |
| Ensemus Cloud | Vendor-operated SaaS with Ensemus-managed models and usage allowance |
| Ensemus BYOM | Vendor-operated SaaS with customer-selected and customer-paid model accounts |
| Ensemus Sovereign | Licensed customer-controlled deployment with customer-provided inference and optional maintenance |
| Data plane | Tenant business content and inference/processing paths that can expose confidential information |
| Control plane | Configuration, identity, tenancy, billing, release management, and platform administration |
| Projection | Rebuildable read model/index derived from authoritative records |

## Naming rules

Use `organization_id`, not ambiguous `company_id` or `tenant` in primary tables. Use `work_unit_id` for business outcomes and `agent_run_id` for individual agent attempts. Distinguish a model provider account from the model or deployment identifier. Every API event should state the correct identity class and not overload a user ID to represent an unattended agent.
