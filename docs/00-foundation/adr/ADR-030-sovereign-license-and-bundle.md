# ADR-030: Sovereign license, bundle and organization archive

**Status:** Proposed. Foundation written on 2026-11-06, and most of it is typed stubs for the M6 slices. Nothing here has run on real infrastructure. **D1, D3, D4, D6 and D8 need outside security review before any real key or customer data is used.** Legal wording is out of scope throughout: this records mechanisms, and counsel writes the terms.
**Date:** 2026-11-06
**Deciders:** Project owner for every open decision listed below. Security owner for D1, D3, D4, D6, D8 and D12.
**Backlog:** `COMM-03`, `COMM-04`, `COMM-05`, `OPS-02`, `OPS-03`, `OPS-11`, `SEC-05`, `SOV-01` to `SOV-06`.

## Context

The delivery plan says this of the license format: "Mistakes here are very hard to fix, since lapsed customers may have no upgrade rights." That sentence sets the bar. Anything that ships in a customer's image may have to keep working, unchanged, on an isolated machine, for as long as they run the software, with no way for us to send a correction.

The spec's promises are plain:

- The license is perpetual for the licensed version. Maintenance is optional and separate.
- Offline validation needs no phone-home. There is no kill switch. A lapse changes support status and nothing else (`SOV-02`, `QA-021`).
- A restore on a clean instance works, and no revoked content comes back (`OPS-02`, ADR-026).
- Exports contain no credentials, and imports need no vendor (`QA-023`, `QA-024`).
- **No sales claim of air-gap readiness**, until the [acceptance test](../../specifications/deployment/SOVEREIGN_OFFLINE_ACCEPTANCE.md) has passed on released binaries. Nothing in this ADR, the product or its pages makes one.

Three decisions the format depends on are still the owner's: who holds the signing key, security patches after a lapse, and supported branches with major-version rights. So the format has to work whichever way they go.

## Decisions

### D1: One signed envelope, built from published parts

Every document we issue is a DSSE envelope (`payloadType`, `payload`, `signatures`) with Ed25519 from Node's own crypto. A signature covers the payload's exact bytes and its type, through DSSE's pre-authentication encoding.

- **Why not JSON with a signature field:** that needs canonical JSON, a classic source of forgery bugs. Here the bytes are signed and then parsed.
- **Why not a JWT or a certificate chain:** a JWT's expiry and algorithm headers invite the two mistakes this format must never make, and X.509 brings a parser and date checks we would have to disable. DSSE is small and carries several signatures, which a second key holder would need.
- **Why the type is signed:** a maintenance statement can never be replayed as a license.
- **Every signature that names a known key has to be good.** One that fails refuses the document rather than being skipped, so a damaged file is never half-believed.

`@ensemus/sovereign/envelope` and `@ensemus/sovereign/verify`, with tests in `verify.test.ts`.

### D2: The license says what was bought, and nothing can make it stop

**The format has no expiry field, no heartbeat and no machine binding. The verifier takes no clock.** There is no function that answers "may this run", and no type with a field for it, in `@ensemus/domain/license`. The only outputs are a standing and a list of notices. So a lapse, a stopped clock, a missing trust root or a damaged file can change what an administrator reads, and cannot refuse a request.

| Choice | Reason |
|---|---|
| Four separate document types: license, maintenance, advisory, support policy | Renewing maintenance adds a small signed file. It never touches or reissues the license, so a customer's perpetual file never needs replacing. |
| No hardware or network binding | Restoring to a clean instance is a required proof. A binding is a kill switch by another name. |
| A signature is the only proof | A row in `sovereign.license_records` proves nothing. The envelope is re-verified on every read, so anything writing a row directly has only stored a file that does not verify. That is also why no new database role is needed, which matters because a migration cannot create one and a customer's upgrade should not need a superuser. |
| Attached per organization, as the data model's `license_records` says | Row-level security holds as for anything else. On a deployment with several organizations an operator attaches it to each. `@ensemus/sovereign/verify` also runs with no database, for the acceptance test's first boot, before any organization exists. |
| Unknown fields are ignored, and a newer `format_version` is refused by name | A customer who stopped upgrading can still read what is issued later. A newer format reports `FORMAT_NOT_SUPPORTED`, leaving everything installed as it was. The issuing tool must keep writing version 1 for anyone whose release cannot read more. |
| Frozen corpus | `tests/fixtures/license-corpus/v1/` holds signed documents that every future release must still verify. Files there are never regenerated. |
| A pilot license is a term kind with a review date | The pilot gate says "Pilot license, not perpetual yet". The date shows as a notice and disables nothing, so the safest default holds until the owner decides otherwise. |
| The entitlement port never refuses in Sovereign mode | M4's `Entitlements` port (ADR-028 FD-8) says M6's license implements it. `createSovereignEntitlements` does, and its return type has no refusal in it, so an agent run can never be stopped by a lapse. `@ensemus/commercial` delegates to it at the final merge. A `components`-based "feature not licensed" answer is deliberately not built: it would be a new way to stop purchased software, so it waits for an owner's decision. |

**What this is not:** it is not copy protection. The customer controls the machine and the trust root, so anyone with that control can edit either. A license here is honest evidence for people who want to know where they stand, and for support and audit.

### D3: The trust root is configuration, and custody stays open

`ENSEMUS_LICENSE_TRUST_ROOT_FILE` names a file of public keys, each with its purposes, and with a threshold for each kind of document. It is delivered out of band, the first time, with the contract. **Private keys are not in the repository, the images, or any environment.**

- **Rotation cannot hurt a perpetual license.** A key has `retired_on` and `compromised_on`, and no expiry. A document issued on or before that day stays good for ever, and a later one is refused.
- **A leaked key has a limit we accept:** the date checked is the one inside the document, which a thief could backdate. A customer's trust root only learns of a leak if they take an update, and a lapsed customer may not. The harm is contained, because a forged license grants nothing that a customer's own control of their machine did not already allow, and a forged **bundle** is what matters, so bundle signing keys are a separate purpose.
- **Issuing is a port.** `DocumentSigner` in `@ensemus/sovereign/issuer` is what a hardware token, KMS or second holder implements. The only implementation refuses to run unless told `rehearsal: true`, and it marks what it signs. Keys with `test_only` make every page that shows their documents say so.
- **The issuer never ships.** Lint blocks `@ensemus/sovereign/issuer` from the web tier and workers, and a test checks the worker build does not reach it.

**Outside review:** key separation by purpose, the threshold rule, and the leak limit above.

### D4: The offline bundle verifies itself against a root you already hold

A bundle is a folder, not one file, so a tool can check it with streams and an operator can move it however their site requires. `bundle-manifest.dsse.json` lists every file with its hash, size and role, every image with its digest, and what it can upgrade from and roll back to.

- **Anything in the folder not listed is refused, and so is any symbolic link.** Nothing unsigned can sit beside what was signed.
- **The trust root is never taken from the bundle.** It is the one the operator already holds, or the first bundle would vouch for itself.
- **The verifier is the operator's own copy where they have one.** The tool in a new bundle is only trusted after an older tool has checked that bundle. For a first install its hash comes out of band with the trust root. This is the same bootstrap problem any signed distribution has.
- **No registry.** Images load from the OCI archives in the folder, and the compose overlay forbids pulling. A digest that does not match what the manifest says stops the install.
- **`packages/sovereign` has no network.** Lint refuses it `net`, `http`, `dns`, `fetch`, and every package that could reach one, so the tools a customer runs cannot phone home. The packet capture in `SEC-05` is what proves the running product does not.
- **Going backwards is a rollback, not an upgrade.** `planInstall` refuses an older version unless the manifest lists it in `rollback_to`, which also stops an old, unpatched bundle being replayed as an upgrade. Rollback limits travel as codes in the manifest, as the runbook requires.

Update rights are checked here and only here: `evaluateUpdateRight` runs on the signed dates, and its answer can warn, or if the license says so refuse, a **new install**. It can never affect the version already running.

### D5: Patch rights, branches and majors are data

Each is a value the issuing tool reads from a file with no default, so no code chooses:

| Field | Meaning | Where |
|---|---|---|
| `security_patches_after_lapse` | Whether a lapsed customer may install security patches on their line | License |
| `major_versions_with_maintenance` | Whether maintenance reaches a new major version | License |
| `releases_published_during_maintenance` | Whether a release published while maintained stays installable after a lapse | License |
| `outside_rights_on_install` | Warn or refuse, for a bundle outside these rights. Only ever a new install | License |
| `branches`, `security_patches_after_lapse_grant` | Supported lines, and a grant to everyone | Signed support policy, in each bundle |

**A later document can only add.** A support policy has no way to subtract from a license, and a test holds that. So the narrow choice today can be widened later with no new license and no contact with the customer, while the wide choice could never be taken back. That is why the narrow value is the reversible one, and the tool's rehearsal policy uses it.

Coverage rests on the release's signed publication date, not on today, so moving a clock cannot grant a release. `not_kept` is the one value that asks today's date, because it is what it means.

### D6: Encryption holds only a public key

Export parts, backups and diagnostic bundles are sealed with `@ensemus/sovereign/sealed`: X25519 to agree a key, HKDF-SHA256, then AES-256-GCM, with a new ephemeral key for each object. This is the same shape as HPKE's base mode, using only Node's primitives, because Node does not expose HPKE.

- The customer generates the pair, and gives us the public half. A worker that wrote an archive cannot read it back, and neither can an administrator of the deployment.
- Objects are bounded at 32 MiB of plain text, so there is no chunked stream format to design, and each worker holds at most one part.
- **What this does not do:** sealing proves who can read it, and not who wrote it, since anyone with the public key can seal. So an import treats an archive as hostile however it arrived (D8), and a backup's manifest is checked only for what it covers: a part being changed, lost or reordered.

**Outside review:** this construction, and that the header is authenticated correctly. If review prefers it, `age` or a library HPKE can replace it behind these two functions, for anything not yet written.

### D7: An archive is a plain tar of sealed parts

As `docs/07-commercial/03-data-portability-and-exit.md` asks: a manifest with schema version, organization, date, who asked, counts, checksums and encryption metadata, then folders of JSONL and original files.

- **Plain tar, sealed parts.** A customer can open it with tools they already have, plus a documented, standalone unsealing tool, so they are not trapped. Names in the tar are IDs and record kinds, so the outer layer leaks counts and sizes and no names.
- **No new dependency.** `@ensemus/sovereign/tar` is about a hundred lines, regular files only, with a reader that treats its input as hostile and never touches a file system. A path is checked by `isArchivePath`, an allowlist rather than a hunt for `..`.
- **The export runs in the worker, through the outbox.** `organizationExportWorkflow` calls one bounded Activity at a time, with only IDs and counters crossing Temporal, and its place kept in `organization_exports.progress`. The web tier streams the finished archive from the store a part at a time.
- **Each record has a schema** in `@ensemus/contracts/portability-records`, and both ends use it. They are strict, so a new column reaches an archive only by a reviewed change, and a credential has no field to sit in. No record has an organization ID, so an archive cannot name a tenant.
- **Other milestones plug in** through the `PortabilitySection` port: agents and skills (M4), knowledge (M5), custom objects (M7). A section with no implementation exports nothing, and the manifest shows that. **Derived data is never exported.** Search chunks and embeddings are rebuilt with fresh ACLs through `RestoreContributor`.
- **No consistent snapshot across a long export.** One transaction cannot span an hours-long job. Parts are read in order, tombstones **last**, and `tombstones_through` records when. Import checks relations and reports what dangles.

### D8: An import goes into a new organization, once, run by an operator

- **Empty target only.** An owner creates a new organization and asks for the import. `organization_imports_one_only` means an organization takes one archive ever, unless it failed. So an archive can never be merged over live data, and record IDs can be kept as they were, since keys are `(organization_id, id)`. That is what keeps every relationship intact with no ID map.
- **An operator's command, not a workflow.** Opening an archive needs the private key, and the only way to promise that key never reaches Temporal, a table or a log is to keep it in one short process, read from a file they mount. A re-run is safe: each part's row is written in the transaction that applied it.
- **Hostile input.** Paths are checked, the manifest is checked against the parts actually present, each part's sealed and plain hashes are checked, and each record goes through its strict schema. A foreign reference finds nothing, because everything is confined to the new tenant.
- **Revoked content stays gone.** Tombstones are applied first, and a tombstoned artifact is skipped entirely, bytes and row. The new organization gets its own tombstones and ledger entries. **And the source organization's ledger is consulted when this store has it, so an old archive imported on the same deployment cannot bring back what was deleted after it was made.** On another deployment that ledger is not there, which the operator's guide states as a limit: an archive is a copy the customer holds, and we cannot reach into it. As with ADR-026, this stops it returning to the product through this path.

**Outside review:** the parsing of a hostile archive.

### D9: An import starts nothing, and says nothing false

- **Nothing runs.** No workflow, no event a workflow listens to, no pending approval, no connection with a credential. `importedWorkStatus` leaves anything that was moving as `blocked`, for a person.
- **History is kept as history.** Approvals, decisions, status changes, sends and receipts go to `sovereign.imported_records`, read-only, with the work's own read rule. They are never recreated in the live tables, for two reasons: a send or an approval must never be repeatable here, and pointing a decision at whoever ran the import would state something false about who decided. It would also trip M3's triggers, which rightly refuse an intent that does not start at the start.
- **An import makes no accounts.** `identity.users` is the auth role's, and creating people there would walk around sign-up controls and invite account takeover by email. Each person becomes a row in `imported_people`. What they owned is held by the import's fallback membership, and says so. They join through an ordinary invitation, and an owner links them, which moves their work and grants no role.

**The cost:** until someone is linked, their work shows the fallback as owner, and a restored organization needs its people re-invited. A database restore (D11) has none of these limits, and is the path for getting one deployment back. An archive is the path for moving between deployments.

### D10: Restricted work stays out, by default and at both ends

Restricted work is limited to the people on it, and being an owner does not change that (`docs/04-security/01-security-blueprint.md`). An export taken by an owner must not be the way around that rule. So `scope` has one value, `standard`:

- Restricted work, and artifacts and clients classified restricted, are excluded. So are an artifact whose only links are to restricted work, and that work's history.
- The record schemas have no `restricted` classification, so a slip at either end is refused rather than copied.
- `excluded_restricted_*` reaches the manifest, the page and the import's warnings. **Nothing is missing silently.**

A wider scope, such as two owners approving it, is a migration away. It is the owner's decision.

An archive in the store also has to respect a later deletion. So it has a retention time (`ENSEMUS_EXPORT_RETENTION_HOURS`, configuration and not a promise), and **any tombstone newer than `tombstones_through` makes it undownloadable** (`EXPORT_SUPERSEDED`) and purges it at the next upkeep. A person makes a new one.

### D11: A backup set, and one command to reconcile after it

`OPS-02` says that restored PostgreSQL, Temporal and object state reconcile workflows, receipts, tombstones and derivatives, and no revoked content returns.

- **A backup set** is sealed parts and a sealed manifest, in `backupManifestSchema`: both PostgreSQL databases Temporal uses as well as ours, and a manifest of objects with their hashes. Backups are operator-run scripts. Nothing is scheduled, and no RTO or RPO is stated, because those depend on what the customer tests.
- **The ledger never goes back.** `excludes_tombstone_ledger` is the literal `true` in the schema, and `mayRestoreObject` refuses to write under `tombstone-ledger/`, closing the gap ADR-026 left open ("The code does not enforce this").
- **`restore-reconcile`** runs after a restore, before anyone is let back in, in report mode first:
  1. Re-applies the tombstone ledger, as ADR-026 D3 does, keeping its rule about a person confirming a whole file.
  2. Work holding a run Temporal has no open record of is failed, as upkeep does. A run Temporal cannot answer about is left alone and reported.
  3. An intent caught `sending` or `reconciling` goes to `unknown` where its attempts allow, or is reported. **It sends nothing, and retries nothing** (ADR-027 D2).
  4. Bytes with no row are listed, and not deleted, since a person may want them. Rows whose bytes are missing or differ are reported.
  5. `RestoreContributor`s run: agent runs (M4), derivatives rebuilt with fresh ACLs (M5).

  A non-zero count of things needing a person is a non-zero exit.
- **Someone other than the owner runs a restore.** The plan's exit requires this and code cannot supply it. The drill script writes the evidence record and leaves room for who ran it.

### D12: Diagnostics are an allowlist that a person reads first

- **Every field is a version, count, code or hash**, in a strict schema, so a new field is a reviewed change. No name, address, title, body, URL, credential or tenant name has a place to go. A value that fails the schema stops the report rather than being trimmed.
- **It is written in the open, to a local folder, for a person to read**, with `renderReviewText` listing every field.
- **Sealing for someone outside needs an approval naming the exact report and the recipient.** A changed report needs a new approval. The approval travels inside the bundle.
- **Nothing sends it.** The command writes a file. There is no upload code in the package, and lint keeps it that way. Moving that file is the customer's own act, which is what "explicit approval" should mean on a network that may have no way out.

## What this does not cover

- **Local model weights.** The manifest has a place for them, and it stays empty until the owner decides what can be redistributed.
- **Whether a never-licensed install should refuse to start.** Today nothing stops it. That is the safe side of a choice the owner may want to revisit, and a Cloud or BYOM deployment has no license at all.
- **Footprint.** Seats and bands are shown and never enforced, and `readVerifiedLicenseFacts` gives M8 what its entitlement check needs. A license grants no provider or tool that policy refuses.
- **Backups held by the customer, or archives already downloaded.** They hold what they held. This stops revoked content returning to the product, and cannot erase a copy. Retention is `LIFE-02`.
- **A customer's own tampering.** See D2.
- **Claims.** This ADR proves nothing about any real deployment. M6's exit needs the acceptance test on built binaries, with a packet capture, and a restore run by someone else. The evidence report says what ran.

## Consequences

- **A new package**, `@ensemus/sovereign`, which depends only on the domain and `zod`, so its tools can be bundled and run on an isolated machine. **No new third-party dependency**, so `check:licenses` needs no entry.
- **A new schema**, `sovereign`, with reviewed SQL in migrations `0300` and `0301`, and no new database role.
- **Three new settings**, all optional, and one new operator mount (the trust root).
- **One new object prefix**, `organization-exports/v1/`, which the web and worker identities reach and the ledger identity does not.
- **Migrations are not in the journal yet.** The final merge stitches `meta/`. Until then these tables do not exist in any database a test starts, so integration tests in this milestone cannot pass on a slice's own branch. They are written and typechecked, and count as unverified.

## Reversal

Before anyone holds a license: anything. After that, the format's reading rules are permanent, as the frozen corpus enforces, and every other decision here can change behind them. The tables can be dropped, since nothing else depends on them, and a removed feature leaves customers' signed files as good as they were.

## Open owner decisions

| Decision | Safe default taken | Where it is data |
|---|---|---|
| Signing-key custody, second holder or escrow | Generated test keys only, a `DocumentSigner` port, threshold 1 | Trust root `thresholds`, issuer signer |
| Security patches after a lapse | `none`, which a later policy can widen | License, support policy |
| Supported branches | None stated | Support policy |
| Major-version rights | `separate_purchase` | License |
| Releases published during maintenance, after a lapse | `kept_after_lapse`, the customer's side | License |
| A bundle outside rights | `warn`, never blocking a security fix by default | License |
| What a pilot license's review date does | A notice, and nothing else | License `term` |
| Whether a never-licensed install should run | It runs, with a notice | No code path exists to stop it |
| Whether a license's `components` should limit features | No: shown only, and the entitlement port never refuses | License `components` |
| Restricted work in an export | Left out, and counted | `scope`, one value today |
| How long an archive stays in the store | 24 hours, an operator's setting | `ENSEMUS_EXPORT_RETENTION_HOURS` |
| Local model weights | None in a bundle | Manifest `models` |

## Approvals

| Role | Name | Decision | Date |
|---|---|---|---|
| Project owner | | | |
| Security owner (D1, D3, D4, D6, D8, D12) | | | |
| Outside security review | | | |
| Counsel, for the license terms this format carries | | | |


## Additive joined portability profile (0408/0409, source checkpoint)

The unpublished ensemus.m3-m7/3 profile extends strict definition/custom-record projections while preserving the exact meanings of ensemus.m3-m5/1 and /2. Its explicit 4 MiB record limit accommodates legal pinned custom schemas; older profiles retain 1 MiB and all retain 32 MiB parts. New business definitions and custom records import only as review quarantine. Native identity, MFA/SSO/provisioning/session state, simulation inputs/reviews, live grants/publications/runs, model jobs/spend approvals/private inputs and operational authority never become portable execution authority.

0408 binds actual service body reads to one admitted running export, the pinned profile/epoch and its fresh named owner. Draft body export receives SELECT only; existing human author/write predicates remain intact. Unknown table or profile inventory refuses. Existing target object catalogs govern quarantined copies; an absent-target archive identity receives only narrow custodian review and no live object/relation grant.

0409 captures genuine native organization.manage authority at import admission, including configured administration MFA. Later immutable worker effects do not retain a live-session FK, but recheck current requesting/fallback owners. The actual customer-key parser verifies all bytes/strict records. SQL pins archive/manifest metadata, verifies bounded plaintext part hashes/counts and admits exact one-use team/disabled-connector effects only after every part receipt exists. Connectors restore no scopes, consent or secret. No generic service management exception is introduced.

Archive-original artifact provenance remains an explicit open boundary: real 0208 writer/insert guards refuse unknown/generated origin, and old archives cannot invent missing input lineage. No fake human creator or empty source inventory is installed. Source checks and exact unrun migration, role, privacy, erasure, hosted-provider, bundle and restore limits are recorded in [the joined source evidence](../../06-delivery/evidence/M6-M7-joined-authority-source.md).
