# Customer data portability, migration, offboarding, and reversibility

## 1. Principle

Customer should not be trapped by proprietary data formats or a single model provider. Ensemus may own its software, but customers must retain exportable access to their business records, artifacts, organizational definitions, and appropriately licensed configuration.

## 2. Export manifest

Archive contains manifest with schema version, organization ID, export date and initiating principal, record counts, checksums and encryption metadata; files organized into `organizations/`, `people/`, `work/`, `projects/`, `clients/`, `custom-objects/`, `relations/`, `artifacts/`, `knowledge/`, `agents/`, `skills/`, `policy/`, and `audit-redacted/`.

Data formats: JSON/JSONL for typed records and events, CSV optionally for familiar tables, original file blobs with hashes, and YAML/JSON for agent/skill/workflow definitions. Provide mapping to restore cross-entity IDs and source versions. Exclude vendor-held IP, third-party platform proprietary data not licensed for export, plain secrets, and internal diagnostic raw traces not owned/authorized for export.

The Marketplace publisher archive profile includes the source workspace's publisher name, status, version, and timestamps as a review record. The receiving workspace registers its publisher through its own Marketplace enrollment. Source listings, submissions, and reviews require separate archive coverage before an export can proceed.

The skill upload cleanup profile carries a receipt for a tenant-authored, abandoned bundle only after the source verifies physical deletion in its current restore generations. The importing owner can review the source upload, package and uploader IDs and the receipt timestamps. The archive excludes the bundle, its fingerprint, and its storage address. The skill bundle profile includes verified, workspace-authored versions with current upload receipts and their test results. Bundle bytes stay sealed as original files for manual recovery. Import presents version and test records to the receiving owner for review. The owner can extract a bundle from the original archive and submit it through the destination’s upload and verification workflow. Pending or unverified uploads and Marketplace copies still require separate archive coverage.

The Sandbox history profile preserves completed verification fixture receipts and the exporting owner's own completed trial receipts. Trial inputs, outputs, fingerprints and execution settings stay in the source workspace. Agent executions and other operators' trials remain private, with an aggregate omission count in the manifest and import summary. Queued and running trials must settle before exporting.

The meeting configuration profile carries notice references, settings history, and provider approval and revocation records for review. The receiving workspace sets its own meeting policy and provider approvals.

A later profile can also archive purged meeting receipts when the requesting owner organized or participated in every room and the source has verified each purge. It carries consent decisions and operational receipts without meeting titles, participant display names, content, or content fingerprints. Only the owner who authorized the import can review the receipts in the receiving workspace. The import does not create meetings or grant consent. Open or restricted rooms still prevent the export.

## 3. Credentials and connectors

Never export bearer keys, OAuth refresh tokens, or shared Ensemus service credentials in plaintext. Include connector identities and required scopes; on import, authorized customer re-binds new credentials. Imported external resource IDs must be reconciled rather than blindly using source account IDs in another organization.

The business-record profile preserves connection, resource, and action references for review. The requesting owner must have a current source grant for each record and be able to read each linked Work Unit. The archive leaves out cached connector fields and fingerprints. The owner who authorized the import can review the references, then reconnect and sync the source under fresh credentials and grants. Importing the archive does not create live business records or replay actions.

The residency archive profile includes the source workspace’s configured region and data classes as settings for the importing owner to review. The source deployment’s declared archive storage region must match every source residency requirement. The receiving owner reviews where the new deployment stores and processes data before configuring its residency settings.

## 4. Cloud/BYOM ↔ Sovereign

Cloud-to-BYOM switches provider profiles within the same business database; rerun capability checks and re-embed if model dimensionality changes. SaaS-to-Sovereign exports require tenant data snapshot, blobs, policy/auth mapping, work/event history, agent version specs, compatible local models, index rebuild or conversion, migration logs, and verified import. Privacy/data residency obligations govern transfer channel and erasure after acceptance.

## 5. Exit and deletion

At offboarding, provide export and documented transition period according to contract. Revoke external connections, terminate future scheduled work, handle pending external actions safely, and apply deletions across sources, memory, embeddings, cache, backups, evaluation fixtures, and observability under retention/legal hold rules. Report residual retention exceptions transparently.

## 6. Restore validation

Independent test restore verifies user/team mapping, Work Units and DAG, source/artifact integrity, agent definitions, approvals history, permission fidelity, and no secret leakage. Record migration warnings, unsupported providers, and failed resources. A nontrivial export without restore tooling is insufficient portability.

## 7. Sovereign independence

Licensed offline deployment must continue operating without vendor-hosted services; customer owns keys, databases and media. Maintenance expiry must not activate a kill-switch. Vendor-supplied updates are separately contracted, while customer can continue running the purchased version under its perpetual license.
