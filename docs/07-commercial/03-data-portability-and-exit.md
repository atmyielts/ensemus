# Customer data portability, migration, offboarding, and reversibility

## 1. Principle

Customer should not be trapped by proprietary data formats or a single model provider. Ensemus may own its software, but customers must retain exportable access to their business records, artifacts, organizational definitions, and appropriately licensed configuration.

## 2. Export manifest

Archive contains manifest with schema version, organization ID, export date and initiating principal, record counts, checksums and encryption metadata; files organized into `organizations/`, `people/`, `work/`, `projects/`, `clients/`, `custom-objects/`, `relations/`, `artifacts/`, `knowledge/`, `agents/`, `skills/`, `policy/`, and `audit-redacted/`.

Data formats: JSON/JSONL for typed records and events, CSV optionally for familiar tables, original file blobs with hashes, and YAML/JSON for agent/skill/workflow definitions. Provide mapping to restore cross-entity IDs and source versions. Exclude vendor-held IP, third-party platform proprietary data not licensed for export, plain secrets, and internal diagnostic raw traces not owned/authorized for export.

The Marketplace publisher archive profile includes the source workspace's publisher name, status, version, and timestamps as a review record. The receiving workspace registers its publisher through its own Marketplace enrollment. Source listings, submissions, and reviews require separate archive coverage before an export can proceed.

The meeting configuration profile carries notice references, settings history, and provider approval and revocation records for review. The receiving workspace sets its own meeting policy and provider approvals.

A later profile can also archive purged meeting receipts when the requesting owner organized or participated in every room and the source has verified each purge. It carries consent decisions and operational receipts without meeting titles, participant display names, content, or content fingerprints. Only the owner who authorized the import can review the receipts in the receiving workspace. The import does not create meetings or grant consent. Open or restricted rooms still prevent the export.

## 3. Credentials and connectors

Never export bearer keys, OAuth refresh tokens, or shared Ensemus service credentials in plaintext. Include connector identities and required scopes; on import, authorized customer re-binds new credentials. Imported external resource IDs must be reconciled rather than blindly using source account IDs in another organization.

The business-record profile preserves connection, resource, and action references for review. The requesting owner must have a current source grant for each record and be able to read each linked Work Unit. The archive leaves out cached connector fields and fingerprints. The owner who authorized the import can review the references, then reconnect and sync the source under fresh credentials and grants. Importing the archive does not create live business records or replay actions.

## 4. Cloud/BYOM ↔ Sovereign

Cloud-to-BYOM switches provider profiles within the same business database; rerun capability checks and re-embed if model dimensionality changes. SaaS-to-Sovereign exports require tenant data snapshot, blobs, policy/auth mapping, work/event history, agent version specs, compatible local models, index rebuild or conversion, migration logs, and verified import. Privacy/data residency obligations govern transfer channel and erasure after acceptance.

## 5. Exit and deletion

At offboarding, provide export and documented transition period according to contract. Revoke external connections, terminate future scheduled work, handle pending external actions safely, and apply deletions across sources, memory, embeddings, cache, backups, evaluation fixtures, and observability under retention/legal hold rules. Report residual retention exceptions transparently.

## 6. Restore validation

Independent test restore verifies user/team mapping, Work Units and DAG, source/artifact integrity, agent definitions, approvals history, permission fidelity, and no secret leakage. Record migration warnings, unsupported providers, and failed resources. A nontrivial export without restore tooling is insufficient portability.

## 7. Sovereign independence

Licensed offline deployment must continue operating without vendor-hosted services; customer owns keys, databases and media. Maintenance expiry must not activate a kill-switch. Vendor-supplied updates are separately contracted, while customer can continue running the purchased version under its perpetual license.
