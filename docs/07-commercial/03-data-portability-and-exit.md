# Customer data portability, migration, offboarding, and reversibility

## 1. Principle

Customer should not be trapped by proprietary data formats or a single model provider. Ensemus may own its software, but customers must retain exportable access to their business records, artifacts, organizational definitions, and appropriately licensed configuration.

## 2. Export manifest

Archive contains manifest with schema version, organization ID, export date and initiating principal, record counts, checksums and encryption metadata; files organized into `organizations/`, `people/`, `work/`, `projects/`, `clients/`, `custom-objects/`, `relations/`, `artifacts/`, `knowledge/`, `agents/`, `skills/`, `policy/`, and `audit-redacted/`.

Data formats: JSON/JSONL for typed records and events, CSV optionally for familiar tables, original file blobs with hashes, and YAML/JSON for agent/skill/workflow definitions. Provide mapping to restore cross-entity IDs and source versions. Exclude vendor-held IP, third-party platform proprietary data not licensed for export, plain secrets, and internal diagnostic raw traces not owned/authorized for export.

## 3. Credentials and connectors

Never export bearer keys, OAuth refresh tokens, or shared Ensemus service credentials in plaintext. Include connector identities and required scopes; on import, authorized customer re-binds new credentials. Imported external resource IDs must be reconciled rather than blindly using source account IDs in another organization.

## 4. Cloud/BYOM ↔ Sovereign

Cloud-to-BYOM switches provider profiles within the same business database; rerun capability checks and re-embed if model dimensionality changes. SaaS-to-Sovereign exports require tenant data snapshot, blobs, policy/auth mapping, work/event history, agent version specs, compatible local models, index rebuild or conversion, migration logs, and verified import. Privacy/data residency obligations govern transfer channel and erasure after acceptance.

## 5. Exit and deletion

At offboarding, provide export and documented transition period according to contract. Revoke external connections, terminate future scheduled work, handle pending external actions safely, and apply deletions across sources, memory, embeddings, cache, backups, evaluation fixtures, and observability under retention/legal hold rules. Report residual retention exceptions transparently.

## 6. Restore validation

Independent test restore verifies user/team mapping, Work Units and DAG, source/artifact integrity, agent definitions, approvals history, permission fidelity, and no secret leakage. Record migration warnings, unsupported providers, and failed resources. A nontrivial export without restore tooling is insufficient portability.

## 7. Sovereign independence

Licensed offline deployment must continue operating without vendor-hosted services; customer owns keys, databases and media. Maintenance expiry must not activate a kill-switch. Vendor-supplied updates are separately contracted, while customer can continue running the purchased version under its perpetual license.
