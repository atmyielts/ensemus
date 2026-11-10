# Restore drill record

What `infrastructure/scripts/restore-drill.mjs` does and writes, field by field. **Nobody has run it through to a record yet, and none of this is evidence until someone has.** In CI (run 42675052977, on commit 26a76eb) it has only been started with a project name that does not say `drill`, and it stopped there, before asking anything, as it should. `tests/stack/restore-drill.test.ts` takes the same steps with the same commands and passed in that run, but it takes them itself: it does not run this script. The unit tests of the script's helpers (`tests/unit/restore-drill-authority.test.ts`) have run.

It writes two files: the path you give with `--record`, for a person, and the same path with `.json` added, for anything that wants to compare records. Both refuse to replace an existing file. It writes them only at the end: a drill that stops part way writes no record.

**A record says what one run saw. It sets no target, and no time in it is a promise about any other run.** No recovery time or data-loss limit is stated anywhere in this product.

## How to run it

```sh
mkdir -m 700 drill-review
node infrastructure/scripts/restore-drill.mjs \
  --project ensemus-drill --wipe-project ensemus-drill \
  --backup /backups/2026-11-06 --key recipient.key --record drill-2026-11-06.md \
  --review-directory drill-review \
  --object-endpoint "$STORE" --object-access-key-file access --object-secret-key-file secret
```

`--bucket` and `--compose-file` (which can be given more than once) are optional. Without `--compose-file` it uses `infrastructure/compose/compose.yaml`.

**This wipes the compose project you name**, volumes included, which is what a clean instance means. So the name has to contain `drill`, and it has to be given twice. Use a store that belongs to the drill as well: objects written there are not removed by `compose down` if the store is not part of the project.

A clean instance has no tombstone ledger, so a drill run this way does not by itself prove that a deleted file stays deleted. `entries` under the ledger counts tell you whether it was exercised. To exercise it, copy `tombstone-ledger/` from the source store into the drill's store first, or use `tests/stack/restore-drill.test.ts`, which restores over the running store.

### The review folder

`--review-directory` is required. It is the private folder where the restored authority is inspected and the review is written, and the drill checks it before it changes anything:

- It must exist and be a folder. A path that does not exist stops the drill.
- It must be empty, so an earlier review is never reused or overwritten (`REVIEW_DIRECTORY_NOT_EMPTY`).
- On a system with user IDs, it must be owned by the user running the drill and give no permission to its group or anyone else (`REVIEW_DIRECTORY_NOT_PRIVATE`). On a system without them, only the first two are checked.

The folder is mounted at `/review` in each one-shot `migrate` container that runs `auth-restore.js`: read-write for `inspect`, read-only for `reconcile` and `acknowledge`. It is the one mount the drill adds. On a system with user IDs the one-shot gets `--user <uid>:<gid>`, the user and group running the drill, so it can write into a folder only that user can open. Without them no `--user` is passed. The command lines carry generation, IDs and hashes only, and every body is in the folder.

What ends up in it:

| File | Written by | When |
|---|---|---|
| `snapshot-1.json` | `auth-restore.js inspect`, in the one-shot | The first inspection of the restored authority |
| `revocations.json` | You | Only if the review finds something to revoke: a JSON array of exact IDs, written before you answer `yes` |
| `snapshot-2.json` | `auth-restore.js inspect`, in the one-shot | Only after revocations were applied. Its fingerprint is the one reviewed and acknowledged |
| `review.json` | The drill, from your answers | After the review questions. Mode `0600`, and it refuses to replace an existing file |

Each snapshot is checked against what `inspect` printed (the same bytes, generation, authority hash and phase), and the first against the backup this restore used. Anything else stops the drill.

### It needs a person at a terminal

The authority review is a person's, and the drill cannot acknowledge without one. If standard input is not a terminal it stops with `DRILL_NEEDS_A_PERSON_AT_A_TERMINAL`, after checking its options and the review folder and before it changes anything. It asks its questions on that terminal, in this order:

1. `Who is running this drill? Write your own name:`
2. `Are you the owner of this product? Write yes or no:`
3. `Who will review intents before the connector worker starts? Leave empty if not yet known:`

These three come before the wipe. The rest come after the first inspection:

4. `Compare <review folder>/snapshot-1.json with current independent identity, membership, team, provider and SCIM authority. If anything must be revoked, write it to <review folder>/revocations.json as a JSON array of exact IDs first. Does it need anything revoked? Write yes or no:` Anything but `yes` or `no` stops the drill. `yes` with no `revocations.json` file stops it too.
5. `Who reviewed this authority? Write their name:`
6. `Which independent identity and provider reports did they compare it with? Name them:`
7. `What shows no send, charge or other effect was still in flight? Name the evidence:`

An empty answer to any of 5 to 7 stops the drill before `review.json` is written. Nothing is filled in for you.

### What it does, in order

1. Asks questions 1 to 3.
2. `compose down --volumes --remove-orphans` on the drill project, then starts `postgres` and `objects` and runs `temporal-schema`.
3. Runs `sovereign-restore.mjs` with your backup, key and store, replacing the drill project's databases.
4. Runs `migrate`, for migrations newer than the backup, so the snapshot inspected is the one acknowledged.
5. Inspects the restored authority into `snapshot-1.json`, and asks question 4. On `yes`, applies `revocations.json` with the snapshot's hash and inspects again into `snapshot-2.json`.
6. Asks questions 5 to 7 and writes `review.json`.
7. Runs the reconcile once, before the acknowledgment. It must be refused by 0422's fence with `RESTORE_PENDING`, having changed nothing. Anything else stops the drill.
8. Waits until 0422's `notBefore` has passed, plus five seconds, and acknowledges through the same one-shot. The cooldown is 0422's, and nothing here shortens it.
9. Starts Temporal, and nothing else, then runs the reconcile three times: a report, `--apply`, and `--apply` again.
10. Writes the record.

It never starts the web tier, the other workers or the connector worker. A drill that stops part way leaves the drill project as far as it got, and once the restore has run, authentication stays fenced until an acknowledgment is admitted.

## Who ran it

The script asks for these on the terminal (questions 1 to 3). There is no flag for them and no default, and it writes down what it is told. If either of the first two is left empty, the record says it is not complete and the command exits non-zero. The plan's exit needs **someone other than the owner** to have run a restore, and this is the only place that gets recorded.

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
| `started_at`, `finished_at` | Times on this run, covering the wipe through the last reconcile. This includes the wait for 0422's cooldown |
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
| `tenant_ids` | Every organization the applying reconcile looked at, by ID. No names |

## Authority review and acknowledgment (0422)

Under `authority`:

| Field | What it is |
|---|---|
| `generation` | The auth-restore generation the restore printed |
| `first_security_sha256` | The restored authority's hash at the first inspection |
| `revocations_changed` | The `changed` count the revocation step printed. Zero when the answer to question 4 was `no` |
| `reviewed_security_sha256` | The authority's hash that was reviewed and acknowledged: the second inspection's if revocations were applied, the first's if not |
| `reviewer` | The answer to question 5 |
| `review_sha256` | The hash of `review.json`, as the acknowledgment printed it |
| `not_before` | 0422's cooldown, from the snapshot reviewed |
| `admitted_at` | The drill's own clock, just after the acknowledgment was admitted |

`review.json` and the snapshots stay in the review folder. The record holds their hashes, not their contents.

## Four runs of the reconcile

`reconcile_before_acknowledgment` is the attempt before the acknowledgment. The drill goes on only if it exited 1, was refused with `RESTORE_PENDING`, and printed no ledger and no finish, so in a record it always shows that refusal. `reconcile_report` is the report before anything changed. `reconcile_apply` is `--apply`. `reconcile_second` is `--apply` again, which should show nothing further done: `tombstonesAdded`, `artifactsRemoved`, `bytesRemoved`, `runsClosed` and `actionsMovedToUnknown` all zero. If they are not, that is a finding. Each holds:

| Field | What it is |
|---|---|
| `exit_status` | 0 if nothing needs a person, 1 if something does |
| `ledger` | `entries`, `tombstonesAdded`, `artifactsRemoved`, `bytesRemoved`, `organizationsMissing`, `invalid`, `unconfirmed`, `failed` |
| `tenants` | For each: `runsClosed`, `runsUnknown`, `runsOpen`, `actionsNeedingReview`, `actionsMovedToUnknown`, `actionsReadyUnattempted`, `unreferencedObjects`, `artifactsMissingBytes`, `bytesUnchecked`, `checksFailed`, `contributors` |
| `finished` | `needsAttention`, `objectsWithoutTenant`, `contributorsNotRun` |
| `failed` | The refusal, with its `errorCode`, when the reconcile refused. `RESTORE_PENDING` before the acknowledgment |
| `findings` | Each thing found: a code, IDs, and a key only where Ensemus made the whole of it. In the `.json` file |

The drill does not confirm or quarantine anything, so whole files named by the ledger show as `unconfirmed`, and exit status 1 is the expected result there. It is a person's decision, and the drill does not make it for them.

## What it leaves to a person

- Deciding about `unconfirmed` entries, and running again.
- Reviewing intents, and starting the connector worker. The drill never starts it.
- Starting the web tier and checking that a tenant is served, and that a deleted file is not.
- Keeping or removing the review folder. The drill does not delete it.
- Saying whether the record is good enough. It records and does not judge.
