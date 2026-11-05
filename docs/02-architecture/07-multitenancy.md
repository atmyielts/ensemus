# Tenant isolation, access graphs, and sovereignty

## 1. Threat assumptions

Treat every tenant as mutually untrusted. A bug, connector callback, cached retrieval, vector search, worker retry, or admin tool must not expose data between organizations. Shared SaaS hosting is an economic strategy, not a relaxation of isolation. Sovereign deployments have stronger physical separation but still need internal employee/department ACLs.

## 2. Database isolation

- Tenant-owned tables include required `organization_id` and tenant-aware composite FKs.
- Enable and FORCE RLS for application-accessed tenant tables; app roles cannot be table owners, superusers, or `BYPASSRLS`.
- In a transaction, bind the validated organization context with `set_config('app.organization_id', $1, true)` through the single `withTenantTx` helper (ADR-024 D4); reset/discard context on connection reuse. Use explicit transaction pooling design and cross-tenant regression tests.
- A request cannot infer tenant permission merely from knowledge of a UUID. Resource ACL policy is checked in addition to tenant membership.
- Global `users` may exist separately; membership grants are the only path into tenant data.
- Access that must happen before a tenant is known uses the narrow mechanisms in ADR-024 D4, never `BYPASSRLS`: `app.user_id` lets a user read only their own memberships, the dispatcher role reads only outbox state and event metadata, and webhooks resolve their tenant from an opaque route token.

## 3. Authorization model

RBAC grants coarse capabilities; ABAC checks resource classification, team/project membership, delegation origin, working context, provider routing policy, and proposed side effect. Sensitive actions need specific approvals. Superadmin and customer support access must use break-glass procedures with logs and customer-controlled constraints where possible.

## 4. Derived data isolation

Every chunk, embedding, memory fact, extracted claim, trace, and generated artifact retains tenant and source ACL/provenance. Authorization is applied **before** retrieval candidates are emitted to an agent. After source ACL changes, invalidate related projections/cache and recheck at serving time. Approximate nearest neighbor shared indexes can degrade recall with selective filters; plan tenant-aware partitioning and measured retrieval recall.

## 5. Infrastructure isolation tiers

**Shared SaaS:** one managed control plane, shared DB with robust tenant/ACL isolation, per-tenant KMS envelope keys as feasible, per-tenant limits.

**Dedicated tenant option:** isolated database or cluster, networking, worker pools, and customer KMS options; more operational complexity and pricing.

**Sovereign:** isolated installation under customer ownership; customer chooses private network, model endpoints, object store, and security tooling. Customer may require air-gap validation.

## 6. Per-tenant cryptography and secrets

Prefer envelope encryption with isolated tenant data-encryption keys and managed KMS/HSM for production; key rotation and access logging. Avoid storing decryptable credentials in agent specs or event payloads. Key revocation can disable processing and require documented recovery. Backups also require encryption and tenant-aware disposal.

## 7. Cross-company collaboration

Never join organizations' data implicitly, even when the same individual belongs to both. A future federated work feature must use explicit cross-org invitation, principal authorization at both ends, limited shared objects, signed consent/approval, purpose restriction, export controls, and revocation semantics. Disabled by default.

## 8. Testing

Test two or more tenants with identical resource names and deliberately overlapping search terms. Include cross-tenant fake foreign keys, vector filters, Redis keys, external webhook impersonation, worker pool reuse, async propagation, and timing/error message leakage. RLS policy tests run as actual nonprivileged production-like roles, not only ORM mocks.
