# Sovereign air-gapped acceptance — operator test

## Setup

Run a fresh image bundle on a private network with no external DNS resolution, inbound internet, or default-route egress. Supply offline entitlement and local Temporal/DB/Valkey/object store/key-encryption key/model endpoint. An external identity provider, KMS or vault is optional. Use the release's exact supported image digests.

## Required proof

- First boot, administrator enrollment, license verification, user login and ordinary business CRUD work without Ensemus or other vendor cloud.
- Create Work Unit, invoke local agent, retrieve local indexed document, pause for approval, restart web and worker, approve and verify outcome.
- Power-cycle deployment; business records and Temporal operations recover without surprise model retry or duplicate side effects.
- Local enterprise keys remain local; no model/provider/telemetry egress attempts outside allowlisted private endpoints (record packet capture + DNS logs).
- Export data and restore from encrypted backup to a clean instance; verify role permissions and source revocation tombstones.
- Advance maintenance end date in isolated test: purchased version continues to function, showing only support/upgrade entitlement warning.
- Upgrade via signed offline bundle, no remote registry lookup. Record migration compatibility and rollback constraints.
- Verify release digests/SBOM/signature without contacting vendor services. Create diagnostic export locally; customer must explicitly approve external transfer.

## Evidence record

Collect exact image IDs, configuration redacted hashes, network capture report, test fixture tenant IDs, results, worker/DB versions, backup/restore checksums, operator approval and unresolved constraints. No sales claim of air-gap readiness until this checklist is passed on released binaries.
