# M6 slices

Seven builders work in parallel from the foundation commit, then one more once they have landed, and **no file has two owners**. Everything they must agree on is already decided in [ADR-030](../00-foundation/adr/ADR-030-sovereign-license-and-bundle.md) and already typed in the code. Read that ADR first, because it holds the reasons.

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

**No sales claim of air-gap readiness, anywhere.** Not in a page, a doc, a commit message or a report. What ran is what you say ran.

## Fixed: nobody changes these

| What | Where |
|---|---|
| Migrations, RLS, grants, triggers. **No builder adds a migration, and nobody edits `migrations/meta`** | `packages/database/migrations/0300_*`, `0301_*`, `packages/database/src/schema-sovereign.ts` |
| The license format and its verifier | `packages/sovereign/src/envelope.ts`, `trust-root.ts`, `documents.ts`, `verify.ts`, and their tests |
| Sealing and tar | `packages/sovereign/src/sealed.ts`, `tar.ts`, `testing.ts` |
| What rights mean | `packages/domain/src/license.ts`, and its test |
| Archive names and rules, event names | `packages/domain/src/portability.ts`, `sovereign-events.ts` |
| What a record in an archive looks like | `packages/contracts/src/portability-records.ts`, `sovereign.ts` |
| Ports | `packages/application/src/sovereign-ports.ts` |
| Temporal input shapes | `packages/workflows/src/schemas.ts` |
| Wiring | `workers/workflow/src/main.ts`, `dispatcher.ts`, `portability-sections.ts`, `scripts/build.mjs`, `packages/workflows/src/workflows.ts`, `activities.ts`, `packages/application/src/index.ts`, `errors.ts`, `portability-sections.ts`, `apps/web/src/lib/messages.ts`, `packages/domain/src/policy.ts`, `packages/config/src/*` |
| Import rules | `eslint.config.mjs` |
| Dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package.** Node's crypto, and what is in the tree, are enough | every `package.json`, `apps/web/next.config.ts` |
| Shared test helpers | `tests/helpers/sovereign.ts`, `tests/integration/sovereign-schema.test.ts`, `tests/unit/sovereign-rules.test.ts` |
| Decisions | ADR-030, this file |

A bug in any of these is reported, not fixed in passing.

## What runs where

**Code only. The owner's PC is low on disk, and the owner decides when to dockerize and test.**

| Rule | Detail |
|---|---|
| Never | `docker` or `docker compose` in any form, `pnpm test:integration`, `test:stack`, `test:browser`, `test:upgrade`, any gate needing a container, a dev server or a watch mode |
| Allowed | `pnpm exec prettier`, `eslint`, `typecheck`, `pnpm --filter @ensemus/web exec next typegen`, `vitest run --project unit <paths>`, `pnpm test:replay` |
| Memory | Every heavy command goes through the slot wrapper you were given, with a 600000 ms timeout. Exit 75 means no slot yet, so run it again |
| Still write them | Integration, stack and browser tests for what you build, and typecheck them. **They count as unverified. Say so, and never report them as passing** |
| Disk | Stop and report if C: has under 3 GB free. Delete nothing outside your worktree |
| The journal | Migrations 0300 and 0301 are not in `migrations/meta/_journal.json`. The final merge stitches them. So these tables do not exist in a database a test starts until then, which is one more reason your integration tests stay unverified |
| Replay | New workflow histories need Temporal, which you may not start. Write `tests/replay/capture-*.test.ts`, and report the histories as owed |

## Build order inside the tree

Stubs throw `NOT_IMPLEMENTED`, and each slice can be tested without the others:

- `tests/helpers/sovereign.ts` gives you generated keys, a generated recipient, and `seedLicenseRow`, `seedExportRow` and `seedImportRow`, which write rows directly.
- `@ensemus/sovereign/testing` signs anything, including nonsense. Your tests never hold a real key.
- Where your code calls another slice's stub at runtime, your own tests inject a double. `acceptance` proves the real parts together.

## Every slice

- Denied and cross-tenant tests first, then the code. Two tenants, same names, real roles.
- Only IDs, enums and counters cross Temporal. A workflow's decisions live in a small pure module, as `review-wait.ts` does, so a unit test can reach them.
- `withTenantTx` is the only way to tenant rows, and a transaction never stays open across a store call, a seal or a file read.
- Generated test values only: `@example.invalid` addresses, generated keys, `test_only` trust roots. No real key, credential or provider. A fake lives with its test and is never a default code path.
- Log codes, IDs and counts, never a name, a record's text or a key. Failure codes come from the lists in `@ensemus/domain/portability`.
- Nothing here may invent a price, an SLA, an RTO or RPO, a certification or a legal term. If something needs one, it is configuration or goes in your report as an owner decision.
- Follow the house comment style: say why, in plain sentences.
- Add your operator notes to your own file under `docs/05-operations/sovereign/`, which `acceptance` links into the runbook. Do not edit the runbook or `docs/MANIFEST.json`.

---

## Wave 1: all start at once

## license: `COMM-03`, `SOV-02`, `SOV-05`

Installing and reading signed documents, the operator's command, and the frozen corpus. `QA-021`, `SOV-TS-02`.

**Owns:**

- `packages/application/src/licensing.ts`
- `workers/workflow/src/sovereign-license.ts`, new `sovereign-license-command.ts`, `sovereign-license-command.test.ts`
- new `tests/fixtures/license-corpus/v1/**`, `tests/unit/license-corpus.test.ts`, `tests/unit/no-license-gate.test.ts`, `tests/integration/licensing.test.ts`
- new `docs/05-operations/sovereign/license-and-maintenance.md`, `docs/05-operations/sovereign/supported-branches.md`

**Implements, with these exact signatures** (all stubbed already):

```ts
// @ensemus/application
installSignedDocument(database, context, { envelope }, { trustRoot }): Promise<InstalledDocument>
getLicenseStatus(database, context, { trustRoot, runningRelease, now? }): Promise<LicenseStatusView>
listAdvisories(database, context, deps): Promise<readonly AdvisoryView[]>
readVerifiedLicenseFacts(database, context, { trustRoot }): Promise<{ licenseId; components; footprint } | null>
```

**Calls:** `verifyDocument` from `@ensemus/sovereign/verify`, `PAYLOAD_TYPES` from `/envelope`, `maintenanceStatus`, `evaluateUpdateRight`, `licenseNotices`, `dayOf` from `@ensemus/domain/license`, `can`, `appendAudit`, `emit(LICENSE_DOCUMENT_INSTALLED)`, `loadTrustRootFile`.

**Things to get right:**

- **Nothing is a gate.** `tests/unit/no-license-gate.test.ts` reads the source and fails if `getLicenseStatus`, `listAdvisories`, `licenseNotices`, `maintenanceStatus` or `readVerifiedLicenseFacts` is named outside an allowlist: `packages/application/src/licensing.ts`, `packages/domain/src/license.ts`, the web tier's `license/`, `advisories/` and `data/` routes and pages, `apps/web/src/server/sovereign-*.ts`, and `workers/workflow/src/sovereign-license-command.ts`. So `requireTenant`, `apiRoute`, `apps/web/src/server/tenant.ts`, `middleware` and every workflow file stay free of them. M8 adds itself to that list for `readVerifiedLicenseFacts` at the final merge.
- Work out the kind of document from `payloadType`, and verify against that kind. A row's columns are for finding it. Every value in a view comes from a verified envelope.
- A maintenance statement for a license not installed here: `LICENSE_NOT_VALID`, and nothing stored.
- Installing the same bytes twice: one row, `created: false`.
- A stored row that fails to verify, for instance after a key is removed from the trust root: skipped, and the standing is `unverifiable` only if no license verifies. **It never throws, and never logs the envelope.**
- `license.view` for reading, `license.manage` for installing. A service context may install, for the operator's command. A member gets `FORBIDDEN`. Another tenant's row is not found.
- **The corpus is the promise.** Generate one license, one pilot license, one maintenance statement, one advisory, one support policy and a trust root, each with a generated key whose private half is thrown away, and commit them. `license-corpus.test.ts` verifies each one and evaluates rights, and its comment says these files are never regenerated: a release that cannot read them breaks lapsed customers.
- **The command:** `verify <file> [--trust-root <file>]` needs no database, and is the acceptance test's first-boot proof before any organization exists. `install --organization <id> <file>` uses `createServiceContext`. Prints the standing, IDs and notices, and exits non-zero only for a file that does not verify. A wrong trust root is exit 2.
- `supported-branches.md` is the published shape of the policy with **no branch, date or right filled in**, marked as waiting for the owner's decision. It reads like a template because it is one.

**Tests the exit depends on:**

- `QA-021`, `SOV-TS-02`: install a license and a maintenance statement that ended in the past. `getLicenseStatus` answers `licensed`, `lapsed`, one notice. Run the same with `now` ten years on, with no trust root at all, and with every row failing to verify. Every call returns, and **ordinary business calls keep working in the same test**: create a Work Unit after each.
- Denied: a member reading, an admin installing, another tenant's context, a forged envelope, a wrong kind, a test key shown as `testKey`.
- Stopped clock: `now` before `issued_at` gives `clock_before_issue`, and the standing does not change.

## tools: `SOV-01`, `SOV-04`, `SOV-06`

The issuing tool, signed advisories, the customer's own key and unsealing tools, and the diagnostic exporter.

**Owns:**

- `packages/sovereign/src/issuer.ts`, new `issuer-cli.ts`, `issuer.test.ts`
- `packages/sovereign/src/diagnostics.ts`, new `diagnostics.test.ts`
- new `workers/workflow/scripts/build-issuer.mjs`
- new `workers/workflow/src/tools/recipient-key.ts`, `workers/workflow/src/tools/open-archive.ts`
- `workers/workflow/src/diagnostics-export.ts`, new `diagnostics-command.ts`, `diagnostics-command.test.ts`
- new `tests/unit/issuer-not-shipped.test.ts`, `tests/unit/advisory-rehearsal.test.ts`, `tests/integration/diagnostics.test.ts`
- new `docs/05-operations/sovereign/issuing-documents.md`, `advisories.md`, `diagnostics.md`, `archive-format.md`

**Implements:**

```ts
// @ensemus/sovereign/issuer (vendor side, never ships)
createRehearsalFileSigner({ keyId, privateKeyPemFile, rehearsal: true }): DocumentSigner
issueDocument<P>(purpose: P, document: DocumentFor<P>, signers: readonly DocumentSigner[]): Promise<string>
runIssuerCommand(argv, io): Promise<number>

// @ensemus/sovereign/diagnostics
renderReviewText(report: DiagnosticReport): string
sealForTransfer({ reportText, approval, recipientPublicKey }): { ok: true; sealed: Buffer } | { ok: false; code: SealRefusal }
```

**Things to get right:**

- **Rights come from a file, with no defaults.** `license` refuses to run without `--rights <file>`, and a missing or unknown value is an error rather than a default. The tool's documentation shows the fields and states that each value is the owner's decision. It ships no policy file except a test fixture.
- `createRehearsalFileSigner` refuses at runtime unless `rehearsal` is literally `true`. Everything signed this way goes in the register as `rehearsal: true`, and `keygen` writes `test_only: true` into the trust root entry it prints. **There is no flag that writes `test_only: false`.** Taking that away needs the custody decision and a new signer.
- `issueDocument` runs the document through its own schema before signing, then verifies its own output against the signer's public key, and refuses if it would not verify. It writes `format_version: 1`.
- The register is append-only JSONL of `IssueRecord`, one line per document, with hashes and IDs, and no licensee name.
- `issuer-not-shipped.test.ts`: walks the import graph of every entry in `workers/workflow/scripts/build.mjs` and of `apps/web/src`, reading source files, and fails if `issuer` or `testing` can be reached. A private key has no path into any image.
- `recipient-key.ts` makes a pair: public key printed, private key written to a file with mode 0600, and never printed. `open-archive.ts` walks an archive with `readTarEntries`, opens each part and checks each hash, to a folder the operator names, with paths checked by `isArchivePath`. These two run with only Node, and are the "not trapped" promise, so `archive-format.md` documents the format fully enough to write another one.
- **Advisories (`SOV-04`):** `advisory-rehearsal.test.ts` walks the whole rehearsal with generated keys. Issue a signed advisory and a patched bundle manifest, verify both offline, confirm a forged one is refused, and confirm rights are evaluated against the bundle. `advisories.md` is the process, with who does what left for the owner to name.

**Diagnostics (`SOV-06`), the command:**

- `collect --out <dir>` reads through narrow queries: counts from `eventBacklog`, `listOrganizationIds` for a count only, `reachable` booleans, and migration names. It writes `report.json`, and `review.txt` from `renderReviewText`. Configuration is by **name**, with a SHA-256 of the value, and never the value, and only for names on an explicit list. Secrets `_FILE` paths are not read at all.
- Every value goes through `diagnosticReportSchema`. **A value that fails stops the report**, and does not get trimmed.
- `seal --report <file> --recipient <key> --approved-by <name>` makes a `TransferApproval` with the hash of those exact bytes, then `sealForTransfer`, and writes a file. With no `--approved-by` it refuses. **It sends nothing, and `diagnostics.md` says moving that file is the customer's own act.**

**Tests:** a canary in a work title, a file name, a member's email, a tenant name, a secret and a config value, none in `report.json`, `review.txt` or any log. Approval for another report, another recipient, or none: refused. A field added to a report: refused by the schema. An integration test for collect on real PostgreSQL, written and unverified.

## bundle: `COMM-04`, `SOV-03`, `OPS-03`, `OPS-11`

Building, verifying, installing, upgrading and rolling back an offline bundle. `QA-022`, `DEP-TS-02`, threat `SEC-012`.

**Owns:**

- `packages/sovereign/src/bundle.ts`, new `bundle.test.ts`
- new `workers/workflow/scripts/build-sovereign-tools.mjs`, which bundles every file in `workers/workflow/src/tools/` to `dist/tools/*.mjs` with esbuild, including other slices' tools
- new `workers/workflow/src/tools/verify-bundle.ts`, `workers/workflow/src/tools/install-bundle.ts`
- new `infrastructure/scripts/build-bundle.mjs`, `infrastructure/scripts/bundle-rehearsal.mjs`
- new `infrastructure/compose/sovereign/README.md`, describing the overlay that `docker_later` will add
- new `tests/unit/bundle-install-plan.test.ts`, `tests/unit/bundle-tools-offline.test.ts`, `tests/stack/bundle-upgrade.test.ts`
- new `docs/05-operations/sovereign/offline-bundle.md`, `upgrade-and-rollback.md`

**Implements:**

```ts
// @ensemus/sovereign/bundle
verifyBundleDirectory(folder: string, root: TrustRoot): Promise<BundleVerdict>
planInstall({ manifest, installed, rollbackRequested, onInstall }): InstallPlan
```

**`verifyBundleDirectory`, in order:** read `bundle-manifest.dsse.json`, `verifyDocument('bundle', …)`, which is the signature first and nothing trusted before it. Then walk the folder with `lstat`, refusing any symbolic link or anything but a file or folder (`LINK_REFUSED`), and any file not listed (`FILE_NOT_LISTED`). Then hash each listed file by streaming (`FILE_MISSING`, `FILE_CHANGED`, with size checked first). Every image's `file` must be listed with role `image` (`IMAGE_NOT_LISTED`).

**`planInstall`:** `installed` null is `install`. Newer needs `installed.version` in the bundle's `upgrade_from` (`UPGRADE_PATH_NOT_LISTED`). Older is a rollback: `rollbackRequested` must be true (`ROLLBACK_NOT_REQUESTED`), and the target must be in `installed.rollback_to` (`ROLLBACK_NOT_LISTED`). Equal is `SAME_VERSION`. `refuse` is `OUTSIDE_RIGHTS_REFUSED`, `warn` adds `confirm_outside_rights`, and `null` (no license installed) adds nothing and goes on. `require_backup` always comes before `run_migrations`. **A security fix being outside someone's rights is the only refusal that touches rights, and only if their license says `refuse`. Nothing here affects what is already running.**

**Scripts, written and not run:**

- `build-bundle.mjs <version> --signer <file>`: `docker save` each image by digest, copies SBOMs, notices, compose files and migrations, writes the manifest, and signs it. `THROWAWAY` signing as `build-release.mjs` does until custody is decided. Reads the release facts from arguments, and refuses a `models` entry without a license reference.
- `install-bundle.ts` carries out `planInstall`'s steps, one at a time, printing each. `docker load`, then **compares the loaded image's ID with the manifest digest, and stops on any difference, before anything starts**. `--dry-run` prints the plan and needs no Docker, which is what a unit test runs. It never contacts a registry, and it appends one `InstallationRecord` line.
- `bundle-rehearsal.mjs`: the full upgrade and rollback, from a clean stack, for when the owner runs it.

**Things to get right:**

- Takes the trust root from `--trust-root`, never from the bundle. Refuses a trust root found inside the folder being verified.
- `upgrade-and-rollback.md` says plainly: back up first, migrations are not undone by rollback, a rollback means restoring that backup, and what ran elsewhere does not unhappen. It lists `rollback_constraints` codes and what each means, and the runbook's existing plan-run drain rule.
- `bundle-tools-offline.test.ts` reads the tool sources and the sovereign package, and fails on any import that can reach a network.

**Tests with no container:** make a small bundle in a temp folder with generated keys. A changed byte, a removed file, an added file, a symbolic link, a manifest signed by an unknown key, a bundle-purpose key that is not trusted, a license-purpose key signing a bundle, a path with `..` in the manifest, a digest that differs. Each refused with its code, and the good one accepted. Every `planInstall` row, including replaying an old bundle as an upgrade. `tests/stack/bundle-upgrade.test.ts` is written and unverified.

## export: `COMM-05` (out), and `QA-024`

The service, the worker's steps, the workflow, and how core sections read themselves.

**Owns:**

- `packages/application/src/portability-export.ts`, `portability-sections-export.ts`
- `packages/workflows/src/portability-workflow.ts`, `portability-activities.ts`, new `export-step.ts`, `export-step.test.ts`
- new `tests/integration/organization-export.test.ts`, `tests/replay/capture-organization-export.test.ts`, `tests/replay/organization-export-corpus.test.ts`
- new `docs/05-operations/sovereign/export.md`

**Implements:**

```ts
// @ensemus/application
requestOrganizationExport(database, context, { recipientPublicKey, sourceRelease }): Promise<OrganizationExportView>
listOrganizationExports(database, context): Promise<readonly OrganizationExportView[]>
getOrganizationExport(database, context, exportId): Promise<OrganizationExportView>
openExportArchive(database, store, context, exportId): Promise<ExportArchive>
beginExport(database, context, { exportId }, deps): Promise<ExportStep>
exportNextBatch(database, store, context, { exportId }, deps): Promise<ExportStep>
finishExport(database, store, context, { exportId }, deps): Promise<ExportStep>
failExport(database, context, { exportId, code }): Promise<void>
purgeExpiredExports(database, store, context, now): Promise<number>
CORE_SECTION_EXPORTERS: Record<CoreExportSection, PortabilitySection['exportPage']>

// @ensemus/workflows/portability-activities
createPortabilityActivities({ database, store, exportDeps }) -> { beginOrganizationExport, exportOrganizationBatch, finishOrganizationExport, failOrganizationExport }

// packages/workflows/src/portability-workflow.ts
organizationExportWorkflow(input: OrganizationExportInput): Promise<OrganizationExportResult>
```

**Calls:** `seal`, `parseRecipientPublicKey`, `recipientKeyId` from `@ensemus/sovereign/sealed`, `tarHeader`, `tarPadding`, `tarEnd` from `/tar`, `recordPartPath`, `artifactPartPath`, `exportObjectKey` from `@ensemus/domain/portability`, schemas from `@ensemus/contracts/portability-records`, `can`, `canReadWork`, `emit`, `notify`, `appendAudit`.

**Things to get right:**

- **Restricted stays out (ADR-030 D10).** Restricted work, its assignments, links, history and external actions. Clients and artifacts classified restricted. **An artifact whose only links are to restricted work, whatever its own class.** Count each in `excluded_restricted_*`. Each record goes through `coreRecordSchema`, which refuses `restricted`, so a slip fails the export with `RECORD_REFUSED` rather than writing it.
- **Credentials cannot get in (`QA-024`, `SEC-016`).** `connection` has no field for one, and `config` is not exported. `secrets` is not read at all. External action payloads are history for non-restricted work. A canary test covers an API key in a connection's credential, in `config`, in a webhook secret, and an invitation token: none anywhere in any part, opened and searched.
- **Audit is redacted:** the `audit-redacted` section holds action, target reference, decision, reason code and time, and leaves out actor IDs that are not memberships, and anything else.
- **`people`:** names and emails go through what the tenant can already see. Read through the same narrow route `listMembers` uses. No account, session or password column is touched.
- **Tombstones are read last**, then `tombstones_through` is set. A file with a tombstone is never read, and a file whose bytes do not match `sha256` stops the export with `BYTES_CHANGED`.
- **One bounded step.** `exportNextBatch` does one page (`MAX_RECORDS_PER_PART`) or one artifact, seals it, writes the object, then inserts its part row and saves `progress` in one transaction. A retry finds the row and moves on, so a repeat writes nothing twice. No transaction stays open across a store call.
- **`openExportArchive`:** `EXPORT_NOT_READY`, then `EXPORT_SUPERSEDED` if any tombstone is newer than `tombstones_through`. `purgeExpiredExports` deletes bytes for rows past `expires_at` or superseded, sets `expired`, and keeps the row. `TOO_MANY_PARTS` past `MAX_ARCHIVE_PARTS`.
- **The workflow:** only IDs and counters, one pure decision module (`export-step.ts`). A `requested` row is claimed once. Loop on `exportOrganizationBatch` with `continueAsNew` once `continueAsNewSuggested` says so. Retry through outages as `workUnitWorkflow` does, and go to `failOrganizationExport` on a deterministic failure. Workflow ID is `organizationExportWorkflowIdFor`, already wired in the dispatcher. Histories are owed: write the capture test, and say so.

**Tests:** a tenant with every kind of record, and a second tenant with the same names whose content must be in no part. Every part opened and searched for the other tenant's names and for restricted content. Denied: an admin and a member asking. Another tenant's export is not found. A key that is not X25519, a second running export, a retried step. A file deleted after the snapshot: no download. A file deleted during: not in the archive and in the tombstones. An archive expired: bytes gone, row kept.

## import: `COMM-05` (in), and `QA-023`

Reading an archive into a new organization, the operator's command, and how core sections write themselves back.

**Owns:**

- `packages/application/src/portability-import.ts`, `portability-sections-import.ts`
- `workers/workflow/src/organization-import.ts`, new `organization-import-command.ts`, `organization-import-command.test.ts`
- new `tests/integration/organization-import.test.ts`, `tests/integration/fixtures/archive-builder.ts`, `tests/unit/hostile-archive.test.ts`
- new `docs/05-operations/sovereign/import.md`

**Implements:**

```ts
// @ensemus/application
requestOrganizationImport(database, context): Promise<OrganizationImportView>
getOrganizationImport(database, context, importId): Promise<OrganizationImportView>
runOrganizationImport(database, context, { importId, archive, recipientPrivateKeyPem }, deps): Promise<ImportRunResult>
listImportedPeople(database, context): Promise<readonly ImportedPersonView[]>
linkImportedPerson(database, context, { sourceMembershipId, membershipId }): Promise<ImportedPersonView>
listImportedRecordsForWork(database, context, workUnitId): Promise<readonly ImportedRecordView[]>
CORE_SECTION_IMPORTERS: Record<CoreExportSection, PortabilitySection['importPage']>
```

**Calls:** `readTarEntries` from `@ensemus/sovereign/tar`, `open`, `parseRecipientPrivateKey`, `sealedRecipientId` from `/sealed`, `isArchivePath`, `importedWorkStatus`, `EXPORT_MANIFEST_PATH` from `@ensemus/domain/portability`, `exportManifestSchema`, `coreRecordSchema` from `@ensemus/contracts/portability-records`, `ledgerPrefixFor`, `parseLedgerEntry`, `TOMBSTONE_RECORDED`, `objectKey`, `emit`, `notify`, `appendAudit`, `canReadWork`.

**The order in `runOrganizationImport` is the safety** (its comment lists it). The manifest is opened first, and the archive's parts must be exactly the manifest's. A part with no entry, an entry with no part, a duplicate path or a path `isArchivePath` refuses is a failure, and nothing has been written. Check the sealed hash, open it, check the plain hash. Read tombstones first. Each page, and its `organization_import_parts` row, is one transaction, so a re-run skips what finished.

**Things to get right:**

- **No record can reach out.** Records have no organization field, and RLS holds. A foreign ID finds nothing and is `RELATION_DANGLING`, which is a warning, and the row is left out or its link set to null. A team cycle or a dependency cycle in a hostile archive is stopped by the existing triggers, and the import reports it rather than crashing.
- **Nothing starts (ADR-030 D9).** Work status through `importedWorkStatus`, with `run_id`, `run_requested_*` and `plan_reviewer_membership_id` empty, and `WORK_PAUSED_ON_IMPORT` counted. No `work.execution_requested`, no `external_action.ready`, no `organization.created` beyond what already happened. Approvals, decisions, transitions, external actions, receipts and audit events go only to `imported_records`, and **a test asserts `work.approvals` and `integrations.external_actions` stay empty**. Connections: state `disabled`, no credential, `CONNECTION_NEEDS_CREDENTIAL` counted.
- **Revoked stays gone (ADR-030 D8, `QA-025` by this path).** Build the tombstone set from the archive **and** from `ledgerPrefixFor(source)` when this store has any. A tombstoned artifact gets no row and no bytes (`TOMBSTONED_SKIPPED`), and a tombstone and `tombstone.recorded` in the new organization. So does anything the source's ledger knows and the archive predates. Say in `import.md`, plainly, that on another deployment that ledger is not there.
- **People.** An import makes no accounts. A `person` becomes a row in `imported_people`. `membershipFor` answers their linked membership or the fallback, and counts `PERSON_NOT_LINKED`. `source_role` grants nothing. `linkImportedPerson` needs `organization.import`, refuses a membership that is not in this tenant, refuses `IMPORTED_PERSON_ALREADY_LINKED`, and moves their work through the audited route ordinary reassignment uses, with `canManageWork` not bypassed for what the caller may touch.
- **Artifacts:** bytes are checked against the record's `sha256`, written under `objectKey(newOrg, id)` before the row, with `blob_lifecycle` handled as `addArtifact` does.
- **The key.** `recipientPrivateKeyPem` is read from `--key-file` by the command, and goes nowhere else. No log, no error, no row. A wrong key is `WRONG_KEY`, and the message says which key the archive is for, using `sealedRecipientId`. The command exits non-zero on `failed`, and prints counts and IDs, with no names.
- **Empty target.** `requestOrganizationImport` checks it, and `runOrganizationImport` checks again.

**`tests/unit/hostile-archive.test.ts`:** path traversal in a tar name, a symbolic link, a truncated archive, a manifest listing a part that is absent, an extra entry, a sealed hash that differs, a plain hash that differs, a part sealed to another key, a record with an extra field, a record in the wrong section, a record over `MAX_RECORD_BYTES`, a schema version from the future. Each is a named failure, with nothing thrown raw.

**Integration, unverified:** export from one tenant, using `tests/integration/fixtures/archive-builder.ts` until `export` lands, and import to a new one: same names and relationships, same DAG, same bytes, and the other tenant untouched. Then `QA-023`: relationships kept, with counts equal to the manifest. Denied: an admin, a member, a second import, a non-empty target, another tenant's import ID.

## restore: `OPS-02`

The backup set, the reconcile command, the drill. `QA-025`.

**Owns:**

- `packages/application/src/restore-reconcile.ts`
- `packages/sovereign/src/backup.ts`, new `backup.test.ts`
- `workers/workflow/src/restore-reconcile.ts`, new `restore-reconcile-command.ts`, `restore-reconcile-command.test.ts`, `restore-contributors.ts`
- new `workers/workflow/src/tools/seal-parts.ts`, `workers/workflow/src/tools/open-parts.ts`
- new `infrastructure/scripts/sovereign-backup.mjs`, `infrastructure/scripts/sovereign-restore.mjs`, `infrastructure/scripts/restore-drill.mjs`
- new `tests/integration/restore-reconcile.test.ts`, `tests/stack/restore-drill.test.ts`
- new `docs/05-operations/sovereign/backup-and-restore.md`, `docs/05-operations/sovereign/restore-drill-record.md`

**Implements:**

```ts
// @ensemus/application
reconcileAfterRestore(database, store, { organizationIds, contextFor, probeRun, contributors, mode, ledgerOptions? }): Promise<RestoreReport>

// @ensemus/sovereign/backup
mayRestoreObject(key: string): boolean
// and uses backupManifestSchema, BackupManifest, OBJECT_PREFIXES_NEVER_RESTORED
```

**The command:** `restore-reconcile.js [--apply] [--confirm …] [--confirm-file …] [--quarantine …]`, passing the last three to the ledger as `reapply-ledger.js` does and reusing `reapply-command.ts`'s parsing by importing it. Report mode changes nothing, including the ledger step: it reads and counts. It gets the tenant list with `listOrganizationIds`, and `probeRun` with a Temporal client, read-only, with `TEMPORAL_CHANNEL_ARGS`, using the same describe logic as `main.ts`. `RestoreContributor`s come from a new `restore-contributors.ts` list that you own, empty for now, which M4 and M5 add to at the final merge. Exits 1 if `needsAttention` is above zero, and 2 for a bad argument. Prints counts and IDs, and no names.

**Things to get right:**

- **It sends nothing, and it retries nothing (ADR-027 D2).** An intent `sending` or `reconciling` moves to `unknown` only where its attempts let the trigger allow it, and otherwise it is reported. `ready` with a recorded attempt is reported. There is no path here to the connector queue. The restore runbook keeps the connector worker stopped until this is done: say so, and say the code does not enforce it.
- **A run Temporal says is `closed`** fails its work the way the upkeep does, through the same function, and is idempotent. `unknown` is reported and left. Never treated as closed.
- **Bytes:** list `artifacts/` keys per tenant, comparing with rows a page at a time. Unreferenced objects are **listed and not deleted**. Rows whose bytes are gone or differ are reported.
- **Other prefixes:** `organization-exports/` older than the restore point stay subject to `purgeExpiredExports`, and an export row newer than the database does not exist, so its bytes are unreferenced and are listed like the rest.
- **`mayRestoreObject`** refuses `tombstone-ledger/` and `tombstone-ledger-quarantine/`, including tricky spellings such as a leading slash. `sovereign-restore.mjs` runs every key through it. This closes the gap ADR-026 left.
- **Backup scripts**, written and not run: `pg_dump` for `ensemus`, `temporal` and `temporal_visibility`, split into `MAX_PART_PLAINTEXT_BYTES` parts and sealed with `seal-parts`, with an object manifest of keys and hashes. Sealed `manifest`, with `excludes_tombstone_ledger: true`. The order in `backup-and-restore.md`: drain the ledger backlog, take the database, then Temporal, then objects, and say what a gap between them means. **No RTO or RPO is stated.**
- **`restore-drill.mjs`** runs the whole thing from a clean instance and writes `restore-drill-record.md`'s fields: backup and restore checksums, tenant IDs, counts and versions, and **who ran it, which it asks for and does not fill in**. The plan's exit needs someone other than the owner, so this is for them.

**`QA-025`:** delete a file, restore a backup older than that, skip the re-apply, and it is refused. Run reconcile, and it is gone in row and bytes, with its tenant served again. The other tenant is untouched throughout. With a run open, closed and unknown, and with an intent in each status. A second run changes nothing. Integration test on real PostgreSQL with a local store double in the test, and a stack drill, both written and unverified.

## console: `COMM-03`, `COMM-05`, `SOV-02`, `SOV-04` (what people see)

API routes, pages and the OpenAPI flip, on the existing design system. The services are stubs until the others land, so tests are typechecked here and proved by `acceptance`.

**Owns:**

- new `apps/web/src/app/api/v1/organizations/[organizationId]/license/**`, `advisories/**`, `exports/**`, `imports/**`, `imported-people/**`
- new `apps/web/src/server/sovereign-runtime.ts`, `apps/web/src/server/sovereign-dto.ts`, `apps/web/src/server/sovereign-actions.ts`
- new `apps/web/src/app/o/[organizationId]/license/**`, `apps/web/src/app/o/[organizationId]/data/**`
- `apps/web/src/app/o/[organizationId]/layout.tsx`, `apps/web/src/app/globals.css`, new `apps/web/src/components/license-*.tsx`, `apps/web/src/components/export-*.tsx`, `apps/web/src/components/import-*.tsx`
- `docs/specifications/openapi.yaml`, `packages/contracts/generated/**`, `tests/unit/openapi-contract.test.ts`
- new `tests/stack/sovereign-api.test.ts`, `tests/browser/specs/license.spec.ts`, `tests/browser/specs/data-portability.spec.ts`, `tests/unit/sovereign-words.test.ts`

**Calls, with signatures as in `license`, `export` and `import` above:** `getLicenseStatus`, `installSignedDocument`, `listAdvisories`, `requestOrganizationExport`, `listOrganizationExports`, `getOrganizationExport`, `openExportArchive`, `requestOrganizationImport`, `getOrganizationImport`, `listImportedPeople`, `linkImportedPerson`, `listImportedRecordsForWork`. Schemas from `@ensemus/contracts/sovereign`. `loadSovereignConfig` from `@ensemus/config/sovereign`, `loadTrustRootFile` from `@ensemus/sovereign/trust-root`, `verifyDocument` from `/verify`.

**Things to get right:**

- **`sovereign-runtime.ts`:** loads the trust root once, and a missing or unreadable one gives `trustRoot: null`, a logged code, and a page that says so. **Nothing about it stops the process or a request.** Reads `runningRelease` from the verified `ENSEMUS_BUNDLE_MANIFEST_FILE`, or null. Lint keeps `issuer`, `testing`, `bundle`, `backup`, `diagnostics`, `sealed` and `tar` out of the web tier.
- **API:** each route through `apiRoute`. Flip `x-ensemus-status: planned` off and remove the line from `tests/unit/openapi-contract.test.ts` as each lands, add `401`, `500` and `503` to each operation as the implemented ones have, and regenerate with `pnpm --filter @ensemus/contracts generate`. A response field stays in the spec's list. Web tier: no Temporal, no key, no private key. The archive route streams `chunks` with `Content-Disposition: attachment`, `Cache-Control: no-store`, and the tar type. The `/api/v1` restore gate applies to it as to anything else.
- **Words, on the license page:** what it says is what is true. A lapse reads as a support status, and says the software keeps running. `tests/unit/sovereign-words.test.ts` reads the page sources and fails on "expired license", "license expired", "air-gap ready", "air-gapped ready", "certified", "guarantee" and any price. A test key says so at the top of the page. **The page never says this deployment is air-gapped.**
- **Who sees what:** a member gets the usual not found on the license and data pages, and neither appears in their navigation. An admin reads the license and installs nothing. Only an owner exports, imports or links.
- **Export page (`data/`):** asks for a public key, and explains in a sentence that the matching private key stays with them, with the name of the tool that makes one. Status, what was left out and how much, download, and why a download went away. It never shows or asks for a private key. **Import page:** says it takes a new, empty organization, shows counts and every warning in words, and lists people to link.
- **Forms work without JavaScript**, as the rest do. Empty, error and denied states. Keyboard and axe in the browser specs, as the others do, written and unverified. Work pages stay untouched: imported history appears on `data/`, by work.

## Wave 2: needs wave 1 merged

## acceptance: `SEC-05`, and the milestone's exit

The offline acceptance test as a script, the phone-home audit, the docs and the report. **None of the proving runs here: the owner runs it later. Make it typecheck and lint, and say so.** This wave exists because it proves the real parts together, and it cannot be written honestly against stubs.

**Owns:**

- new `infrastructure/scripts/sovereign-acceptance-gate.mjs`, `infrastructure/scripts/egress-audit.mjs`, `infrastructure/scripts/egress-audit-rules.mjs`
- new `tests/unit/egress-audit-rules.test.ts`, `tests/unit/no-phone-home.test.ts`, `tests/stack/sovereign-acceptance.test.ts`
- `infrastructure/scripts/run-all-gates.sh`, `.github/workflows/ci.yml`, `tests/unit/gates.test.ts`, `package.json` (scripts only)
- `docs/05-operations/05-container-deployment-runbook.md`, `docs/05-operations/02-deployment-and-recovery.md`, `docs/02-architecture/03-data-model.md`
- `docs/specifications/traceability.csv`, `qa-scenarios.csv`, `implementation-backlog.csv`, `threat-register.csv`
- new `docs/06-delivery/evidence/M6-report.md`, `docs/06-delivery/06-end-to-end-delivery-plan.md`, `docs/specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md`
- **`docs/MANIFEST.json`, last of all.** `node docs/specifications/tools/regenerate-manifest.mjs`

**`SEC-05`, threats `SEC-013`, `TR-021`:**

- `no-phone-home.test.ts` runs in the unit project: no shipped package reaches a telemetry or update host, `NEXT_TELEMETRY_DISABLED` is set in the images, no dependency in the production tree is on a known telemetry list, and `packages/sovereign` and `workers/workflow/src/tools` stay off the network.
- `egress-audit.mjs` builds on `air-gap-gate.mjs`'s capture, and adds `--capture` to save a pcap and DNS log for the evidence record. `egress-audit-rules.mjs` is pure and unit-tested, and passes a capture only with no packet or lookup leaving the allowlisted private ranges.

**`sovereign-acceptance-gate.mjs`:** walks each bullet of `SOVEREIGN_OFFLINE_ACCEPTANCE.md`, in order, on a stack with no route out: first boot, enrolment, `sovereign-license.js verify`, login, ordinary work. A Work Unit through a local agent and local retrieval, where M4 and M5 have landed, and otherwise reported as not run. Approval across a restart. Power cycle. Packet capture. Encrypted backup to a clean instance. **Maintenance date advanced in isolation: the purchased version keeps working, with only a notice.** Upgrade from a signed bundle with no registry lookup. Digests, SBOM and signature checked with no vendor. A diagnostic export with approval. It writes the evidence record's fields, and fails rather than skipping anything silently.

**Docs:**

- The runbook links `docs/05-operations/sovereign/*`, adds the trust root and the three settings, and corrects "A full backup and restore ... comes in M6".
- `qa-scenarios.csv` and the backlog move only on evidence, and **nothing moved without a run**. `M6-report.md` says what ran, on what, and what did not, and claims nothing that has not run.
- **The plan's exit needs the acceptance test passed on built binaries and a restore run by someone else, and no sales claim of air-gap readiness.** Say all of that as still open.
- Say in `SOVEREIGN_OFFLINE_ACCEPTANCE.md` which commands do each proof.

## Merge order

Nothing depends on order for compiling, since every signature exists. For tests to pass end to end: license, tools, bundle, export, import, restore, console, then acceptance. If the ownership above held, there are no conflicts to resolve.

Sibling milestones plug in at the final merge, with no slice here waiting on them:

| Port | Who implements | Added to |
|---|---|---|
| `PortabilitySection` for `agents`, `skills`, `policy` | M4 | `workers/workflow/src/portability-sections.ts` |
| `PortabilitySection` for `knowledge`, with no derived data | M5 | same |
| `PortabilitySection` for `custom-objects` | M7 | same |
| `RestoreContributor` for agent runs and budgets | M4 | `workers/workflow/src/restore-contributors.ts` |
| `RestoreContributor` for chunks and embeddings, rebuilt with fresh ACLs | M5 | same |
| New tombstone types, as ADR-026 expects | M5 | `@ensemus/domain/tombstone-ledger`, which the archive's tombstones already carry |
| `readVerifiedLicenseFacts`, for the entitlement check | M8 | their code calls it |

## Handoff

Each builder reports: tickets, files, behaviour, commands actually run with results, anything stubbed or left over, what could not run, what the owner must decide, and any report under "If you need a change". Commit messages end with the attribution line. Do not push. Finish with `git checkout --detach`.
