# Relational database design and complete table catalog

**Canonical store:** PostgreSQL; separate logical schemas may group tables, but a single transactional database is the initial default. `specifications/schema.sql` illustrates key constraints and is **reference DDL**, not a complete applied migration. Migrations should be generated and reviewed using the chosen ORM/migration tool.

## Schema catalog

### Identity / organization

| Table | Key fields | Constraints |
|---|---|---|
| `organizations` | id, name, mode, lifecycle_status, region | Primary tenant identity |
| `users` | id, external_subject, email, display_name | Global identity, unique stable subject |
| `setup_tokens` | id, token_hash, expires_at, used_at | One-time operator codes for a new account. Hash only, out of the application role's reach |
| `memberships` | organization_id, id, user_id, status | Unique `(organization_id,user_id)` |
| `teams` | organization_id, id, parent_team_id, name | Same-tenant parent, no hierarchy cycles |
| `team_memberships` | organization_id, team_id, membership_id | Same-tenant FKs |
| `service_identities` | organization_id, id, owner_id, purpose, expires_at | Scoped delegated principals |
| `roles` / `grants` | organization_id, role_id, capability, scope | Default deny, versioned |

### Business work / relationships

| Table | Key fields | Constraints |
|---|---|---|
| `clients` | organization_id, id, legal/display name, classification | Unique policy-dependent client key |
| `projects` | organization_id, id, client_id, status, owner | Tenant-safe client relationship |
| `work_units` | organization_id, id, objective, status, owner, version | Optimistic locking, explicit owner |
| `work_dependencies` | organization_id, prerequisite_id, dependent_id | No self-edge, no multi-node cycles |
| `work_assignments` | organization_id, work_unit_id, assignee principal, actor_type, role | At most one primary accountable owner. `actor_type` is `human` or `agent`, and only `human` is written until M4 |
| `work_comments` | organization_id, id, work_unit_id, author, content_class | ACL inherited and enforced |
| `work_artifacts` | organization_id, work_unit_id, artifact_id, purpose | Source/work link |
| `artifacts` | organization_id, id, object_uri, hash, mime, class | Object storage authority, tamper checks |
| `approvals` | organization_id, id, action_hash, approver_id, expires, status | Immutable proposal binding |
| `approval_decisions` | organization_id, approval_id, actor, decision, timestamp | Append-only decision history |
| `custom_object_types` | organization_id, slug, json_schema, version | Schema validation and migration |
| `custom_records` | organization_id, id, type_id, fields, version | Tenant-safe object identity |
| `relationship_edges` | organization_id, from_type/id, relation, to_type/id | Allowed graph typing, no cross-tenant |

### Intelligence / model gateway

| Table | Key fields | Constraints |
|---|---|---|
| `agent_definitions` | organization_id, id, name, steward | Ownership and lifecycle |
| `agent_versions` | organization_id, id, agent_id, content_hash, spec | Immutable published version |
| `agent_runs` | organization_id, id, work_unit_id, agent_version_id, status, budget | Bounded status and usage |
| `execution_steps` | organization_id, id, run_id, kind, seq, status, result_ref | Append-oriented, no raw secret logs |
| `skill_packages` | organization_id/null, id, name, manifest, signer | Trust and provenance |
| `skill_versions` | package_id, semver, digest, contract | Immutable versions |
| `model_profiles` | organization_id, id, owner_mode, region, capability, secret_handle | No raw credentials |
| `model_evaluations` | organization_id/null, profile, task, metrics, dataset_version | Reproducible route quality |
| `model_usage` | organization_id, id, run_id, provider, tokens, cost | Reconciled usage ledger |

### Knowledge / memory

| Table | Key fields | Constraints |
|---|---|---|
| `knowledge_sources` | organization_id, id, type, external_id, class, owner | Source provenance |
| `documents` | organization_id, id, source_id, version, hash, acl_snapshot | Revisions tracked |
| `document_chunks` | organization_id, id, document_id, seq, text, tsv | Scoped lexical retrieval |
| `chunk_embeddings` | organization_id, chunk_id, model_version, vector | No mixing embedding spaces |
| `memory_facts` | organization_id, id, subject, predicate, claim, trust, validity | Never trust unsupported inference |
| `memory_evidence` | organization_id, memory_id, document/record reference | Cite authoritative source |
| `knowledge_edges` | organization_id, source_fact, relation, target_fact | Evidence-backed relations |
| `access_projections` | organization_id, source_id, ACL revision, subject references | Derived, permission checked |

### Integration / security / platform

| Table | Key fields | Constraints |
|---|---|---|
| `connections` | organization_id, id, connector_type, encrypted_handle, state | No plaintext secrets |
| `external_resources` | organization_id, connection_id, external_id, version | Stable sync references |
| `sync_cursors` | organization_id, connection_id, cursor, watermark | Retry-safe sync progress |
| `external_actions` | organization_id, idempotency_key, request_hash, external_id, status | Side-effect reconciliation |
| `domain_events` | organization_id, id, type, schema_version, aggregate/version | Append-only business record |
| `outbox_events` | id, event_id, dispatch_state, retry_count | Transactionally published |
| `inbox_events` | consumer_id, event_id, first_seen | Consumer deduplication |
| `audit_events` | organization_id, who, action, target, decision, timestamp, dedupe_key | Append-oriented restricted store. `dedupe_key` is set only on refusals, one row per person, code and hour |
| `policy_bundles` | organization_id, id, hash, version, active | Review/publish control |
| `entitlements` | organization_id, mode, version, period, capacities | Signed/verified source |
| `usage_ledger` | organization_id, metric, idempotency_key, measured_at | Reconciliation and billing |
| `license_records` | organization_id, edition, release, footprint, signature | Sovereign local validation |

## Indexing and partitioning

- Add tenant-leading B-tree composite indexes to high-volume transactional queries; avoid indexing every JSONB field.
- `work_dependencies(organization_id, dependent_id)` and `(organization_id, prerequisite_id)` support DAG traversal and ready-state checks.
- `documents` need source/version and deletion indexes; lexical `tsvector` GIN; embeddings keyed by model version and tenant.
- Consider table partitions for high-volume `execution_steps`, `audit_events`, `domain_events`, and embedding rows when scale justifies. Partitioning is *not* a substitute for row-level authorization.
- Enforce uniqueness for `(organization_id, external_connection_id, external_resource_id)` to deduplicate sync.

## Tenant safety

Every tenant-owned edge requires same-tenant composite foreign keys. RLS must be enabled on tenant-owned tables and tested under non-owner/non-BYPASSRLS application roles. Bind `app.organization_id` with `set_config(..., true)` only after validating the authenticated tenant membership, within transaction scope. For pooled connections, verify context cannot persist across tenants. Explicit app-level resource ACLs add finer-grained restrictions beyond RLS.

## Concurrency and lifecycle

Use optimistic versions for Work Units/custom records; compare-and-swap for approval status; advisory locks or serializable transactions for dependency edge insertions where needed. Avoid hard-coding multiple status sources. Soft deletions should trigger connector revocation, search/vector purge, cached context invalidation, and retention-aware backup expiry.

## Migration protocol

Migration design → data snapshot / test restore → deploy backward-compatible schema → dual read/write if necessary → backfill in bounded batches → switch contracts → remove legacy columns after safe window. Sovereign versions must include offline migration bundles and downgrade/rollback limitations.
