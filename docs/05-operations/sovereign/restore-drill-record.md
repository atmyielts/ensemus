# Restore drill record

What `infrastructure/scripts/restore-drill.mjs` writes, field by field. **No drill has been run yet, and none of this is evidence until one has.** The script has been written and has not been run.

It writes two files: the path you give with `--record`, for a person, and the same path with `.json` added, for anything that wants to compare records. Both refuse to replace an existing file.

**A record says what one run saw. It sets no target, and no time in it is a promise about any other run.** No recovery time or data-loss limit is stated anywhere in this product.

## How to run it

```sh
node infrastructure/scripts/restore-drill.mjs \
  --project ensemus-drill --wipe-project ensemus-drill \
  --backup /backups/2026-11-06 --key recipient.key --record drill-2026-11-06.md \
  --object-endpoint "$STORE" --object-access-key-file access --object-secret-key-file secret
```

**This wipes the compose project you name**, volumes included, which is what a clean instance means. So the name has to contain `drill`, and it has to be given twice. Use a store that belongs to the drill as well: objects written there are not removed by `compose down` if the store is not part of the project.

A clean instance has no tombstone ledger, so a drill run this way does not by itself prove that a deleted file stays deleted. `entries` under the ledger counts tell you whether it was exercised. To exercise it, copy `tombstone-ledger/` from the source store into the drill's store first, or use `tests/stack/restore-drill.test.ts`, which restores over the running store.

## Who ran it

The script asks for these on the terminal. There is no flag for them and no default, and it writes down what it is told. With no answer they stay empty, the record says it is not complete, and the command exits non-zero. The plan's exit needs **someone other than the owner** to have run a restore, and this is the only place that gets recorded.

| Field | What it is |
|---|---|
| `ran_by` | Who ran it, in their own words |
| `ran_by_is_owner` | Their own answer |
| `intents_reviewed_by` | Who will review intents before the connector worker starts. Empty until someone is known |

## The backup

Read from the sealed manifest, after every part has been opened and checked.

| Field | What it is |
|---|---|
| `backup_id` | From the manifest |
| `release_version` | The release the backup was taken from |
| `database_schema_version` | What the operator gave as the last migration |
| `recipient_key_id` | A hash of the key it is sealed to. Never a key |
| `backup_manifest_sealed_sha256` | The sealed manifest's hash, the same as the backup script printed. This is the backup's checksum |
| `parts_checked` | How many parts opened and matched both of their hashes |

## The restore

| Field | What it is |
|---|---|
| `started_at`, `finished_at` | Times on this run, covering the wipe through the last reconcile |
| `object_manifest_sha256` | The hash of the object manifest that was restored from. This is the restore's checksum, and it should match the one the backup printed |
| `objects_listed` | Lines in the object manifest |
| `objects_written` | Objects put in the store |
| `refused_by_key` | Keys `mayRestoreObject` refused. Should be zero, since a backup should not hold one, and above zero fails the restore |
| `left_out_as_tombstoned` | Files with an entry in the ledger, whose bytes were not written back |

## Versions

| Field | What it is |
|---|---|
| `versions.node`, `versions.docker`, `versions.postgres` | What the drill ran on |

## Tenants

| Field | What it is |
|---|---|
| `tenant_ids` | Every organization the reconcile looked at, by ID. No names |

## Three runs of the reconcile

`reconcile_report` is the report before anything changed. `reconcile_apply` is `--apply`. `reconcile_second` is `--apply` again, which should show nothing further done: `tombstonesAdded`, `artifactsRemoved`, `bytesRemoved`, `runsClosed` and `actionsMovedToUnknown` all zero. If they are not, that is a finding. Each holds:

| Field | What it is |
|---|---|
| `exit_status` | 0 if nothing needs a person, 1 if something does |
| `ledger` | `entries`, `tombstonesAdded`, `artifactsRemoved`, `bytesRemoved`, `organizationsMissing`, `invalid`, `unconfirmed`, `failed` |
| `tenants` | For each: `runsClosed`, `runsUnknown`, `runsOpen`, `actionsNeedingReview`, `actionsMovedToUnknown`, `actionsReadyUnattempted`, `unreferencedObjects`, `artifactsMissingBytes`, `bytesUnchecked`, `checksFailed`, `contributors` |
| `finished` | `needsAttention`, `objectsWithoutTenant`, `contributorsNotRun` |
| `findings` | Each thing found: a code, IDs, and a key only where Ensemus made the whole of it. In the `.json` file |

The drill does not confirm or quarantine anything, so whole files named by the ledger show as `unconfirmed`, and exit status 1 is the expected result there. It is a person's decision, and the drill does not make it for them.

## What it leaves to a person

- Deciding about `unconfirmed` entries, and running again.
- Reviewing intents, and starting the connector worker. The drill never starts it.
- Starting the web tier and checking that a tenant is served, and that a deleted file is not.
- Saying whether the record is good enough. It records and does not judge.
