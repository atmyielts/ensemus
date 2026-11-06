# Data protection, privacy, lifecycle, and portability

## 1. Data inventory and processing map

Inventory business records, identities, client material, attachments, embeddings, extracted text, search indexes, memory facts, model prompts/outputs, evaluations, logs, backups, connector credentials, and exports. For each store, record controller/processor relationship (contract-specific), classification, purpose, source, region, subprocessors, retention, access controls, encryption, and deletion behavior.

## 2. Customer ownership

Customer retains ownership/control of its supplied business content and export rights subject to contract/law. Ensemus receives only the processing rights required to deliver its service. Ensemus does not train shared foundation models on customer material unless a separately explicit lawful agreement provides for that processing; enforce through provider agreements and route controls, not merely product marketing.

## 3. Data flow and secrets

Every source and derived artifact is classified. Classifications flow to extraction, chunking, embeddings, reranking, inference, metrics, support, and export. Source ACLs are projected for search but the authorization service remains authoritative. For restricted information, default deny external inference; support local models or human-only workflows.

## 4. Retention framework

Retention is configured by data class, source, customer contract, workspace needs, and legal holds. Typical categories: transaction records, Work Unit history, raw files, search indexes, derived embeddings, model outputs, operational traces, audit logs, backups, and temporary debug captures. **Numeric defaults require legal/customer sign-off**; do not invent universal retention rules.

## 5. Deletion sequence

1. Receive authenticated, authorized request; determine applicable holds and legal obligations.
2. Tombstone relevant source records immediately to block new retrieval.
3. Revoke connectors/grants if requested, invalidate short-lived context and cache.
4. Remove derived chunks, embeddings, indexes, summaries and memory facts linked to source.
5. Delete or crypto-shred blob content; create minimal non-sensitive deletion audit.
6. Apply backup retention/expiry or targeted purge process where technically viable and contractually required.
7. Verify deletion and report scope, exceptions, and timeframe to customer.

### Deletions and restores

A tombstone in the database cannot protect against restoring that database. So each tombstone is also written, with IDs, a type and a time and nothing else, to an append-only ledger in the object store ([ADR-026](../00-foundation/adr/ADR-026-tombstones-survive-restore.md)). The steps are in the [runbook](../05-operations/05-container-deployment-runbook.md#backup-and-restore).

- **After a restore**, a tenant whose database lacks a ledger entry is refused until an operator re-applies the ledger, which puts back the tombstones, removes the rows and references, and deletes the bytes. The refusal comes from comparing the two, so nobody has to remember it. A file whose row and bytes both survived is destroyed only once the operator confirms that entry, because an entry alone does not prove a deletion happened.
- **What it cannot do:** a deletion whose ledger write had not happened when the database was lost comes back as a name, usually without its bytes. That window is one dispatcher poll in ordinary running, and has no upper limit during a dispatcher or store outage, when it shows as the ledger backlog. Restoring over a running database destroys that backlog too, so the runbook drains it first.
- **What stays true of backups:** a dump still holds deleted rows until it expires. This keeps them out of the product and does not erase them from the backup (`LIFE-02`).

## 6. Export contract

Export full organization-owned structured records, custom object schemas, relationship edges, Work Units, decisions, approved agent/skill specs, approved knowledge, blob files with checksums, provenance, and redacted event history in a documented schema. Never export plaintext connector API keys. Provide import/validation tooling and schema version. For encrypted personal data, use controlled key exchange and authorized principal.

## 7. Data residency and regions

Record residence requirements per organization, per provider profile, and per data class. Region restrictions must cover storage, backups, support access, embeddings, inference, and telemetry—not only primary PostgreSQL. Do not claim an all-in-region product if a connected AI model sends content elsewhere.

## 8. BYOM nuance

Customer owns model provider credentials and their separate provider relationship; Ensemus SaaS still handles permitted prompts/context unless customer chooses Sovereign. Expose a machine-readable egress ledger of which data class reached which approved provider, when, for what purpose, and under which policy.

## 9. Privacy engineering acceptance

Test access, correction, export, deletion, source revocation, derived-index purge, cross-border egress policy, debug consent expiry, model provider change, and backup restoration without resurrecting revoked content into active search. For files, `tests/stack/restore.test.ts` does this with a real dump and restore. Search and memory join it when they exist.
