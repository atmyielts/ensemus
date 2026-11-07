# Exporting an organization

What an owner gets when they ask for an archive, what is left out of it, and what an operator can do about one that went wrong. The decisions behind this are in [ADR-030](../../00-foundation/adr/ADR-030-sovereign-license-and-bundle.md), D6, D7 and D10.

**Status: written, and not yet run on real infrastructure.** The code and its tests exist. The integration tests have not run, because migrations 0300 and 0301 are not in the journal until the final merge. No workflow history has been recorded. The sealing construction has had no outside security review, so no real customer data should go through it until it has.

## Who can do it

Only an owner of the organization. An admin or a member is refused, and neither can see that an export exists.

## What the owner has to bring

A public key of their own, X25519, as base64 SPKI. They keep the private half. The worker seals every part to the public key and holds nothing that could open it, so neither the deployment nor its administrators can read an archive once it is written.

**If the private key is lost, the archive cannot be opened by anyone.** Make a new key and a new export.

## How it runs

1. The owner asks, and the row is written with an outbox event, in one transaction. One export per organization can run at a time.
2. The dispatcher starts `organizationExportWorkflow`. Only the organization ID, the export ID and counters go through Temporal. The place reached is in `sovereign.organization_exports.progress`.
3. Each Activity does one bounded piece: one page of records, or one file's bytes. It seals them, writes the object, then records the part and its new place in one transaction. No transaction stays open across a store call.
4. The order is fixed: sections, then each file's bytes, then the records about files, then **tombstones last**, then the manifest.
5. The owner gets a notification, and downloads a plain tar from the `data` page.

A retried step finds the part already recorded and moves on. Two attempts at one step cannot both record it. A store outage is waited out for up to 24 hours, and then the export fails with `STORE_UNAVAILABLE`.

## What is in an archive

A ustar file, which ordinary `tar` opens, holding `manifest.json.sealed` first and then sealed parts:

| Section | Part files | Holds |
|---|---|---|
| `organizations` | `organizations-NNNNNN.jsonl` | Its name, mode and creation time |
| `people` | `people`, `teams`, `team_memberships` | Names, emails and roles. No account, session or password |
| `clients` | `clients` | Clients that are not restricted |
| `projects` | `projects` | Projects. One under a restricted client stays, without the link |
| `work` | `work_units` | Work that is not restricted |
| `relations` | `work_dependencies`, `work_assignments` | Only between things in the archive |
| `artifacts` | `artifacts`, `work_artifacts`, and `{id}.bin` | Facts about files, their links, and their bytes |
| `history` | `approvals`, `approval_decisions`, `work_transitions`, `external_actions`, `external_action_receipts` | History of work that is not restricted |
| `connections` | `connections` | A connection's type, name and scopes |
| `tombstones` | `tombstones` | IDs, a type and a time for what was deleted |
| `audit-redacted` | `audit_events` | Action, target, decision, reason code and time, and the actor only where it is a membership |

Each part name carries a sequence, so `work/work_units-000001.jsonl.sealed`. Names in the tar are IDs and record kinds, so the outer layer shows counts and sizes and no names. The sections for knowledge, agents, skills, policy and custom objects show zero until their milestones add them, and the manifest says so.

`docs/05-operations/sovereign/archive-format.md` describes the format and how to open one.

## What is left out, and why

**Restricted work.** It is limited to the people on it, and being an owner does not change that, so an export must not be the way around that rule. Left out:

- Restricted Work Units, with their assignments, dependencies, links, approvals, decisions, status changes, external actions, receipts and audit entries.
- Clients and artifacts classified restricted.
- An artifact whose only links are to restricted work, whatever its own class.

The manifest, the page and the row all count these as `excluded_restricted_*`, so nothing is missing silently. A wider scope is a decision for the owner of the product, and is not available today.

**Credentials.** `integrations.connections.config` and `credential_secret_id` are not selected by any query in this code, and nothing here reads the `secrets` schema or webhook endpoints. Invitations are not exported. A record that has a field its schema does not know fails the export with `RECORD_REFUSED`.

A connection comes back through an import as disabled, and someone authorized has to bind a new credential.

**Derived data.** Search chunks and embeddings are rebuilt after an import, with fresh access rules.

## Deletions

| When the file was deleted | What happens |
|---|---|
| Before the export read it | Its bytes are never read. Its tombstone is in the archive |
| During the export, up to the point tombstones are read | Its bytes and its record leave the archive, and its tombstone is in it. The records about files are read again if they might name it |
| After the tombstones were read | The archive cannot be downloaded (`EXPORT_SUPERSEDED`), and upkeep removes its bytes. Make a new one |

A deletion in flight when the tombstones were read can carry an earlier timestamp than they do. So a download compares the number of tombstones too, and a different number refuses it just the same.

**This does not reach a copy already downloaded.** An archive held by the customer holds what it held. It is the customer's copy, and we cannot reach into it.

If a tenant deletes files without pause, the records about files are read again at most five times. After that, those records can name a deleted file, and the tombstones beside them tell an import to skip it. The bytes still leave the archive.

## How long an archive stays

`ENSEMUS_EXPORT_RETENTION_HOURS` sets it, and it is the operator's own setting, not a promise to anyone. Past that time, the archive cannot be downloaded. The tenant's next upkeep removes its bytes and marks the row `expired`. The row stays as the record of it having existed. Any download refused or purged is in the audit log.

## When something goes wrong

The failure is a code on the row, and never text from a record or from the store.

| Code | Meaning | What to do |
|---|---|---|
| `STORE_UNAVAILABLE` | The object store did not answer for a day | Fix the store, then ask for a new export |
| `BYTES_MISSING` | A file has a row and no bytes, and nobody deleted it | Run `restore-reconcile` in report mode, which lists these |
| `BYTES_CHANGED` | A file's bytes do not match the hash on its row | The same. Nothing altered was written to the archive |
| `RECORD_REFUSED` | A record failed its schema, or is over the size limit | Report it as a defect, with the export's ID. Nothing refused was written |
| `TOO_MANY_PARTS` | The archive would need more parts than the format holds, or a manifest over 32 MiB | Report it, since it needs a format change |
| `SECTION_FAILED` | A section's read kept failing, or the workflow was cancelled | Check the worker's log for the workflow ID, then ask for a new export |

A failed export's partial bytes are removed at the next upkeep, and its row stays `failed`.

The worker logs a workflow ID and a code, and no names, record text or keys.

### Limits worth knowing

- **No consistent snapshot across a long export.** One transaction cannot span an hours-long job. Anything made after the export started stays out, and sections are read at different moments, so a Work Unit changed during an export can show its older state, and something reclassified as restricted after its page was read will already be in the archive. Asking for an export while the organization is quiet avoids this.
- **A very slow retried step.** If an attempt is still writing after Temporal has given up on it and retried, its bytes could replace the retry's. The check against this stops an attempt from writing after eight minutes, and a mismatch that got through anyway is refused at download, and by an import, rather than being believed. The owner then asks for a new one.
- **Object left behind.** A worker dying between writing a part and recording it leaves bytes the retry overwrites. If the export then fails before any retry, those sealed bytes have no row. `restore-reconcile` lists them.

## What this does not claim

This describes a mechanism. It says nothing about any deployment being fit for a particular regulation, and it does not state how long an export takes.
