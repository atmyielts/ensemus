# Deploy, upgrade, back up and recover Ensemus 2.0

## Release package

A release contains signed immutable `web` and `worker` container images (same source revision), a database migration job, versioned offline-entitlement verifier, sample Compose deployment, environment/secret contract, image digests, SBOM, OSS attribution, compatibility manifest, smoke tests, incident advisories, and rollback caveats. No source-code ownership or vendor account is implied by Sovereign binary license.

## Standard runtimes

`web`: Next.js standalone Node.js server, health endpoint and reverse-proxy TLS; **never** a long-lived background worker. `worker`: Temporal polling and agent Activities. `ingestion`: isolated CPU/memory processing. `outbox`: delivery/reconciliation. Small sites may consolidate headless workers with explicit task queue separation; web remains separate. Dependencies: PostgreSQL+pgvector, Temporal Server (with its persistence), Valkey, S3-compatible objects, telemetry, and a key-encryption key for the built-in `SecretBroker`. An external IdP, KMS or vault is optional. Infrastructure may be managed in SaaS, local in Sovereign.

## Configuration and secret delivery

Image build uses no production credentials. Inject runtime configuration and secrets from vault/orchestrator secret mounts; `.env.example` documents names only. Separate `DATABASE_URL_WEB`, `DATABASE_URL_WORKER`, `DATABASE_URL_DISPATCHER` and object-store credentials with minimal role grants. Temporal credentials go only to workers and the dispatcher. BYOM model keys belong to the tenant vault, never to Next.js public environment variables. Endpoint allowlists validate inference destinations and block SSRF.

## Database and Temporal upgrades

Use one migration job with concurrency lock. Expand compatible schemas first; run backfills asynchronously; contract later after older workers/long-lived workflows complete. Temporal workflow code must remain replay-compatible with histories, using SDK-supported workflow versioning and worker deployment strategy. Do not downgrade schemas blindly after irreversible writes. Backups alone cannot undo external emails/payments; reconcile side effects.

## Backup set

PostgreSQL PITR or logical backups with tested restore, object version manifests and content checksums, encrypted credential/KMS key recovery plans, signed entitlements, policy config, agent versions and workflow compatibility metadata, Temporal persistence/retention and workflow recovery strategy. Explicit deletion tombstones prevent erased content from reappearing after restoration: they are also kept in a ledger outside the database and re-applied after a restore ([ADR-026](../00-foundation/adr/ADR-026-tombstones-survive-restore.md), and the steps in the [runbook](05-container-deployment-runbook.md#backup-and-restore)). Document ownership and storage regions per commercial mode.

## Recovery

1. Isolate incident and stop consequential tool dispatch if integrity is uncertain.
2. Restore database/object store/Temporal dependencies to a mutually understood point; never claim a perfectly atomic snapshot across distinct stores without coordination.
3. Reconcile outbox/inbox, agent receipts and external provider state before retrying.
4. Validate tenant isolation, permissions, task queue health, document revocations and license entitlements.
5. Rebuild derived search/index/cache projections with fresh ACLs; publish verified recovery result.

## Cloud / BYOM / Sovereign

Cloud/BYOM roll out progressively with canary and fast rollback; an inference provider outage must not break ordinary work. Sovereign uses operator-controlled upgrade bundles verified offline; no vendor cloud check or hidden automatic patch. Maintenance lapse does not disable licensed runtime. Release and hardware compatibility matrices must be included.

## Drills and checks

Crash web during active agent job; crash workflow worker mid Activity; duplicate webhook; inconsistent index; DB restoration with revoked documents; prompt canary leak; expired BYOM provider credential; offline Sovereign cold boot; image version upgrade; storage exhaustion. Define RTO/RPO based on tested tiers and actual contracts rather than inventing guarantees.

See `05-operations/05-container-deployment-runbook.md` and `specifications/deployment/` for concrete package examples.
