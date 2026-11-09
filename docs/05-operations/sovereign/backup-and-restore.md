# Backup and restore

The operator's procedure for `OPS-02`: a backup set across PostgreSQL, Temporal and the object store, a restore from it, and a command that reconciles what the stores disagree about. Why it works this way is in [ADR-026](../../00-foundation/adr/ADR-026-tombstones-survive-restore.md), [ADR-027](../../00-foundation/adr/ADR-027-verified-external-actions.md) D2 and [ADR-030](../../00-foundation/adr/ADR-030-sovereign-license-and-bundle.md) D11.

**What has been shown so far.** The unit tests of the sealing, the key rule, the command's arguments and the drill's helpers have run. In CI (run 42675052977, on commit 26a76eb), on Linux and with outbound traffic blocked, the reconcile's integration test (`tests/integration/restore-reconcile.test.ts`) and the stack drill (`tests/stack/restore-drill.test.ts`) passed. The stack drill runs `sovereign-backup.mjs` and `sovereign-restore.mjs` over the running stack, then takes the 0422 steps below itself, with their commands: inspect, a revocation, the review, a reconcile refused before the acknowledgment, the real cooldown, the acknowledgment, and then the reconcile. It does not re-prove restore debt or delete raw survivors (step 7). Step 7's database paths have integration tests on real PostgreSQL: in that run `tests/integration/raw-restore-requalify.test.ts` (0543, 0545), `tests/integration/raw-restore-survivors.test.ts` (0547) and `tests/integration/restore-entry-refusal-first.test.ts` (0549) passed, and `tests/integration/raw-restore-active-source.test.ts` (0550) failed three of its nine tests. 0551 (below) is written for those and has not run yet. `restore-drill.mjs` itself has not been run through: in that run it was only started with a project name that does not say `drill`, and it stopped there. Nothing here should be relied on until someone has run [the drill](restore-drill-record.md) on their own install.

**No recovery time or data-loss limit is stated, here or anywhere.** Those depend on your data, your hardware and how often you take a backup, and only your own drills can tell you. Nothing is scheduled. You run these when you decide to.

## What you need

- A checkout of the release with its dependencies installed, and the tools built into `workers/workflow/dist/tools`. The scripts load the tools from there.
- A recipient key pair from `recipient-key`. The backup is sealed to the public key. **Keep the private key away from the machine and the backups.** Without it nothing in a backup can be opened, by anyone, including Ensemus.
- The object store's address and an identity that can list, read and write the whole store. The default compose file does not publish the store's port, so you need a way to reach it from where you run the scripts.

## What is in a backup

Sealed parts, each at most `MAX_PART_PLAINTEXT_BYTES` of plain text, and a sealed `manifest.json.sealed`, in `backupManifestSchema`:

| Component | What it holds |
|---|---|
| `postgres_ensemus`, `postgres_temporal`, `postgres_temporal_visibility` | A `pg_dump` custom-format dump of each database |
| `objects` | Every object's bytes, one after another |
| `object_manifest` | A line for each object: its key, hash and size |
| `license_documents` | The signed documents you named with `--license-file` |
| `configuration_hashes` | A SHA-256 of each file you named with `--config-file`, and never its contents |

**The tombstone ledger is never in a backup.** `excludes_tombstone_ledger` is the literal `true` in the schema, the backup script skips those keys without reading them, and the object manifest refuses one if it slips through. A backup holding the ledger could roll it back on restore, which would forget deletions.

A backup still holds whatever existed when it was taken, including the names and bytes of files deleted since. This keeps them out of the product. It does not erase them from your backups, so how long you keep a backup is a decision about that too.

## Take a backup, in this order

```sh
node infrastructure/scripts/sovereign-backup.mjs \
  --out /backups/2026-11-06 --recipient recipient.pub \
  --release "$RELEASE" --schema-version "$LAST_MIGRATION" \
  --object-endpoint "$STORE" --object-access-key-file access --object-secret-key-file secret
```

1. **Drain the ledger backlog.** The script runs `ledger-backlog.js` and stops if `queued` or `dead` is above zero. Those are deletions a restore could not put back if the database were lost now. Fix the cause and try again. `--accept-ledger-backlog` goes on anyway, and then those deletions can come back, so note the counts it prints and tell the people affected.
2. **The database**, `ensemus`.
3. **Temporal**, `temporal` and then `temporal_visibility`.
4. **Objects**, every key but the ledger's, with the manifest of keys and hashes.
5. **License documents and configuration hashes**, then the sealed manifest.

The product can stay up while this runs, which is why the next section matters.

## What a gap between stores means

The stores are taken one after another, so a backup is never one moment. These are not failures. They are what this order leaves, and the reconcile is what finds them:

| What happened during the gap | What you get after a restore | What deals with it |
|---|---|---|
| A file deleted after the database was taken, before the objects | The row returns, and the bytes may be gone | The ledger entry. The re-apply removes the row and the tenant is refused until it has |
| A file uploaded after the database was taken | Bytes with no row | Listed as `OBJECT_UNREFERENCED`. **Never deleted by this.** A person decides |
| A row whose bytes went between the two | A row with no bytes | Reported as `BYTES_MISSING` |
| A run started after the database was taken | Temporal knows a run the database does not | The run finds nothing it can claim. Nothing reports it here |
| A run that ended after the database was taken | The database says running, and Temporal, taken later, says closed | The work is failed, the same way the upkeep does it |
| An email sent after the database was taken | The intent is `ready` with no attempt, as if it never went | **Nothing can tell.** See below |
| An archive made after the database was taken | Bytes with no export row | Listed. One the database knows stays subject to its own expiry |
| A deletion still in the backlog when the database was taken and then lost | The row returns with nothing to say it was deleted | **Nothing.** That is what the drain in step 1 is for |

The reverse order would make different gaps, and worse ones. Objects taken before the database would leave rows pointing at bytes the backup does not hold.

## Restore, in this order

Do this with every reader/worker stopped, including overlay replicas, and keep the connector worker
stopped throughout. The 0422/0515 auth/material restore additions below are in the migration journal,
and what has run of them is stated at the top of this page. Earlier backup/restore evidence does not
qualify them; do not rely on this revised procedure until someone has run [the drill](restore-drill-record.md)
on their own install.

1. **Check that the ledger is still there.** It is what stands between an old database and everything deleted since. If the store you are restoring into is the one that was running, it is. If you are restoring into a new store, copy `tombstone-ledger/` from the old store at its newest state, if any of it survives, before going further. **If the ledger is lost with the store, deletions made after this backup cannot be put back**, and those files return. Tell the people affected.
2. **Restore.** It checks every part before mutation, enumerates and stops all configured project readers
   (retaining PostgreSQL/object storage), and verifies none remain running. It restores the three
   databases, applies the image's schema, and invokes actual migrator begin. Begin closes authentication,
   creates a new auth generation/cutoff, rotates the protected material UUID, and revokes outstanding
   invitations and SCIM bearer sets. The separate auth-only job then uses the native crypto key to
   invalidate sessions/assurances/transient state/recovery codes before objects are written:

   ```sh
   node infrastructure/scripts/sovereign-restore.mjs \
     --backup /backups/2026-11-06 --key recipient.key \
     --project "$PROJECT" --replace-databases-of "$PROJECT" \
     --object-endpoint "$STORE" --object-access-key-file access --object-secret-key-file secret
   ```

   Every key goes through `mayRestoreObject`, which refuses `tombstone-ledger/` and `tombstone-ledger-quarantine/` however they are spelled. A file with an entry in the ledger does not get its bytes back, and is printed as `left_out_as_tombstoned`. Those bytes stay in the sealed backup. If an entry turns out to be forged, that is how you get the file back.

3. **Complete the independent authority review below.** The script prints the pending auth generation
   and never acknowledges or restarts anything. Missing 0422/0515/helper/job/key or incomplete cleanup
   stops the restore. Every partial restore retry creates fresh generations before new object bytes.
   The real 15-minute cooldown is a minimum, not automatic admission.
4. **Start Temporal, and nothing else.** The reconcile asks it about runs. **If Temporal is not restored, every run looks closed to it**, and applying would fail all of that work, so check this first.
5. **Read the report.** This changes nothing, the ledger included:

   ```sh
   node dist/restore-reconcile.js
   ```

6. **Decide about the whole files**, the same way the [runbook](../05-container-deployment-runbook.md#backup-and-restore) describes for `reapply-ledger.js`: `--confirm`, `--confirm-file` or `--quarantine`. The rule is ADR-026 D3's. A file whose row and bytes both exist is destroyed only when you name that entry, and **the list you write is what stands between a forged entry and a live file**. `--quarantine` changes something, so it needs `--apply`.
7. **Apply:**

   ```sh
   node dist/restore-reconcile.js --apply
   ```

   **Re-prove restore debt, one object at a time** (ADR-026 D3a; 0543, 0545). FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person. Once the restore is admitted, name each object the report or a purge left in restore debt:

   ```sh
   node dist/restore-reconcile.js --apply \
     --requalify-organization <org> \
     --requalify-artifact <org>/<artifact> \
     --requalify-archive <org>/<import>/<source artifact> \
     --requalify-source <org>/<source> \
     --delete-raw-survivor <org>/<source>/<document> \
     --requalify-active-source <org>/<source>
   ```

   Each option names exactly one object by its IDs; there is no pattern and no form for a whole tenant. `--requalify-organization` lets the tenant upload Knowledge again after the restore. The `--requalify-*` options observe each object with the store's physical-absence check and record what they saw; they delete nothing themselves. A generated file is then deleted by the ledger re-apply in the same run, and an archive file by the archive quarantine purge. **An object observed present stays owed**: every source purge in that tenant stays refused until its deletion is proven. A source whose raw bytes survived prints `present` with their document IDs and is not re-proven.

   **Delete each raw object that survived** (0547; FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person). For each document ID a `present` source printed, run `--delete-raw-survivor <org>/<source>/<document>`, one option per object; a source or tenant alone is refused, and so is anything not exactly three IDs. The object is deleted through the ordinary deletion lifecycle (admission, one DELETE, an independent absence check, the proof), and only once that deletion is proven is the source re-proven as above. The log line `restore_debt.requalification` with `reasonCode` `REQUALIFY_SURVIVOR` says what happened: `deleted:requalified:absent` means the object is gone and the source's restore debt is retired for this generation; `deleted:present` means the object is gone and others of the source still survive (`count`), so name those too; `held` means a legal hold covers the tenant and nothing was deleted; `unconfirmed` means nothing was proven (the source is not restore debt, the restored database shows it mid-purge, the store could not certify the deletion, or the deletion's outcome is unknown) and the source stays unconfirmed. Running it again after `unconfirmed` retries only the absence check of a DELETE that completed; a DELETE whose outcome is unknown is never sent again and keeps the source unconfirmed. Like every other proof here, a later restore reopens it.

   **Re-prove each source that was still active** (0550; FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person). A restore leaves the raw inventory of every source that was active and never sealed in restore debt. Until it is re-proven, that source cannot be withdrawn or deleted and no new version of it can be written. Run `--requalify-active-source <org>/<source>`, one option per source, after `--requalify-organization` for the same tenant, in this run or an earlier one. Every catalogued object is read and hashed. The observation is recorded only when each object matches its catalog row and live header, every writer of the source has concluded and no deletion of its objects is unresolved. Nothing is written to the store or deleted. `requalified` means the source can be closed and written to again; `missing` lists the document IDs the store reports physically absent, and nothing is recorded; `unconfirmed` means nothing was observed.

   **Close what was re-proven, and what cannot be** (0551; FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person, and not yet run). Once a requalified source is closed, its older raw bytes are deleted through a narrow survivor path, one object at a time, through the ordinary deletion lifecycle as the survivor deletion above is. A source left in debt with a catalogued object missing or changed, which cannot be re-proven, can still be withdrawn: the person can revoke it, and it stops being served. Revoking it proves nothing about its bytes. A new version of a requalified source supersedes the older one through `record_raw_supersede`, which accepts its requalified `restore_debt` inventory.

   Anything not re-proven makes the command exit 1. `reapply-ledger.js` takes the same options.

8. **Review what it lists**, below. Running it again is always safe, and changes nothing that has already been done.
9. **Start the web tier and other workers only after exact-generation authority acknowledgment AND
   actual material reconciliation.** Then, after explicit intent/charge/send review, start the connector
   worker last. No command here restarts serving processes automatically.

### Authentication and external-authority review (0422, not yet drilled on an install)

The reviewed migration must preserve the original tenant-helper OID and be composed with the final
0999 admission extension after all actual SaaS tables/eraser grants. Missing/uncovered RLS or an
unknown reachable application schema refuses that extension; it grants no new table/body access.
An ordinary app, auth, agent, support, secrets or eraser login cannot acknowledge.

Use the exact generation/backup/manifest printed by the restore. In a private directory writable only
by the operator/container identity, run the image's offline commands through the migrator service,
mounting that directory at /review. Never place review bodies or auth secrets in command arguments
or logs. For example, with the normal Compose project/options:

    docker compose run --rm --no-deps -v "$PRIVATE_REVIEW_DIRECTORY:/review" migrate \
      node dist/auth-restore.js inspect --generation "$GENERATION" --out /review/snapshot-1.json

Inspect writes a new file only, never overwrites a prior review, and prints hashes/phase/IDs only.
The snapshot contains bounded explicit IDs, permission/security state and identity/provider hashes,
not XML, password/token/cookie/assertion/factor bodies. Compare it to genuinely current independent
identity, membership, team, provider and SCIM authority. A restored dump cannot prove later
revocations. Large inventories refuse instead of silently truncating.

If real revocations are needed, prepare a strict JSON array of exact tenant/target IDs. Supported kinds
are disable_member, downgrade_member (role member/admin only), disable_provider,
deprovision_member, revoke_scim, revoke_invitation and remove_team_access (all that person's team
access in the named tenant). Exact selected-account actions revoke_password and revoke_oauth_tokens
only clear the selected credential/token material after checking that account's person belongs to the
named tenant. They preserve user/account identity and TOTP. They cannot install a new credential or
relink an account. Clearing tokens does NOT disable a retained provider-account login binding;
its current authorization remains a separate explicit external-authority review/revocation gate.
Reconcile requires the current snapshot hash; stale input rolls back:

    docker compose run --rm --no-deps -v "$PRIVATE_REVIEW_DIRECTORY:/review:ro" migrate \
      node dist/auth-restore.js reconcile --generation "$GENERATION" \
      --snapshot "$SECURITY_SHA256" --actions /review/revocations.json

There is no promotion, activation, owner invention or policy weakening. If the last independently
confirmed owner is revoked, admission stays pending with AUTH_RESTORE_OWNER_REPAIR_REQUIRED;
the deny-only command cannot invent a replacement. A separate explicitly reviewed repair is required.
Inspect again after any change; its new fingerprint is mandatory.

Prepare a bounded nonempty review JSON artifact with exactly version=1, generation, backupId,
manifestSha256, securitySha256, reviewer, reviewedAt, authorityEvidence and
inFlightEffectsEvidence. The evidence fields must identify the actual independent reports reviewed.
This records an operator declaration, not automated live-provider truth. The command reads/hashes
the real file; SQL independently rechecks the exact generation/backup/manifest, current locked
metadata, cleanup counts/ciphertext digest, cooldown and surviving owner. It does not decrypt
ciphertexts or claim SQL password verification:

    docker compose run --rm --no-deps -v "$PRIVATE_REVIEW_DIRECTORY:/review:ro" migrate \
      node dist/auth-restore.js acknowledge --generation "$GENERATION" \
      --manifest "$MANIFEST_SHA256" --snapshot "$SECURITY_SHA256" --review /review/review.json

Passwords/accounts and enrolled TOTP secrets/flags are preserved. All backed-up sessions,
assurances, primary/pre-auth/trusted-device/SAML purpose verification records are removed; setup
tokens, outstanding invitations and SCIM bearers are revoked. Backup-code sets become a real native
encrypted empty list, so a code consumed after the backup cannot return. Failure/rate counters are
preserved and factor lock deadlines cannot shrink. Native stateless email-verification tokens are
checked against the actual retained cutoff/signature/issued-at form, including conservative refusal
of the cutoff's coarse second.

A UUID check is MVCC metadata admission, not a lock across external I/O. A transport admitted before
begin may still finish; stopping a process, losing a response or seeing an empty queue does not prove
no send/charge occurred. Such financial/action debt stays unresolved until genuine external review.
Post-I/O generation mismatch blocks stale acceptance/refund/release; it cannot recall delivered bytes.
No ordinary worker receives the auth key, and the dedicated cleanup job has no provider, vault,
object or Temporal credential. A process accidentally started while pending fails closed and must be
restarted after real acknowledgment. The script starts none.

### The connector worker stays stopped, and only you can make sure of that

**The code does not enforce this.** A connector worker started early acts on whatever the restored database says is ready, and the command prints a reminder on every run for that reason. The reconcile itself sends nothing, retries nothing, and has no path to the connector queue.

The dispatcher delivers events queued in the dump again, including `external_action.ready`. If Temporal still has that run, it refuses a duplicate. If Temporal was restored too, the mail can go a second time (ADR-027 D2). This is a gap, and the review below is what stands in it.

## Reading the report

It prints one line of JSON for each thing, with counts, IDs, codes and keys Ensemus made, and no names. A key that Ensemus did not make can hold anything, so it is counted and not shown. It exits 0 when nothing needs a person, 1 when something does, and 2 for an argument it will not take. In report mode, anything applying would do counts too, so a report that exits 0 means there is nothing to do.

| In the report | What it means | What to do |
|---|---|---|
| `ledger.unconfirmed` | A whole file named by an entry. Its tenant stays refused | Step 6 |
| `ledger.invalid` | An object in the ledger that is not an entry. Its tenant stays refused | Quarantine it |
| `ledger.failed` | Could not be finished | Fix the cause, and run again |
| `RUN_CLOSED` | Temporal has no open record, so the work was failed, as upkeep does it | Nothing. Its owner can see it and try again |
| `RUN_UNKNOWN` | Temporal could not answer. **Never treated as closed.** The work is untouched | Get Temporal answering, and run again |
| `ACTION_MOVED_TO_UNKNOWN` | An attempt ended with no answer, so it now waits for a person, who has been told | Resolve it in the product. Searching the relay's log for the Message-ID on the receipt is how you find out |
| `ACTION_NEEDS_REVIEW` with `sending` | An attempt is still open, and this does not write its outcome. Nothing can send it again while that is so | If its workflow survived, starting the connector worker settles it. **If its workflow did not, nothing will, and there is no way in the product yet to settle it** |
| `ACTION_NEEDS_REVIEW` with `ready` | An earlier attempt definitely did not send. Starting the connector worker may try again | Decide before starting it |
| `ACTION_NEEDS_REVIEW` with `unknown` | Already waiting for a person | Resolve it in the product |
| `ACTION_READY_UNATTEMPTED` | Looks unsent. Not counted, because nothing here can settle it. **If the backup is older than a send, this is what that looks like** | Check against the relay's log for anything sent after the backup, before starting the connector worker |
| `OBJECT_UNREFERENCED` | Bytes with no row. **Not deleted** | Look, then keep or remove them yourself. It stays in the report until you do, so exit status 1 with only these left is an expected state |
| `OBJECT_WITHOUT_TENANT` | Bytes of an organization this database does not have. Not deleted | The same |
| `BYTES_MISSING`, `BYTES_DIFFER` | A row whose bytes are gone or are not what it recorded. Files cannot be read back | Find the bytes, or tell the people affected. Someone can delete the row through the product |
| `BYTES_UNCHECKED`, `CHECK_FAILED` | It could not look. **Not known to be fine** | Fix the cause, and run again |
| `contributorsNotRun` | Report mode cannot ask these to change nothing, so it does not run them | They run with `--apply` |

## What this does not cover

- **A deletion lost in the backlog** when the database was lost, above.
- **A lost ledger**, above. The ledger shares a store with the bytes. Object lock and a narrower identity belong with the production choice of store, as ADR-026 says.
- **An email that went after the backup.** Nothing can tell, as above. An SMTP relay cannot be asked.
- **Work done after the backup.** It is gone. Tell people what the restore point is.
- **Raw Knowledge bytes that survived the restore, beyond a fully purged source.** `--delete-raw-survivor` (step 7, not yet reviewed by a person) deletes them only for a closed source the restored database shows already purged. A source it shows mid-purge, or still active, keeps its restore debt, and nothing lists the survivors for you beyond what `--requalify-source` prints as `present`. A source re-proven with `--requalify-active-source` (0550) and then closed has its older raw bytes deleted by 0551's narrow survivor path, one object at a time; 0551 is flagged for human security review, has not been reviewed by a person and has not run, so until it has, treat those bytes as still owed. An active source with a catalogued object missing or changed cannot be re-proven. Under 0551 it can be revoked, so it is no longer served, but revoking it proves nothing about its bytes.
- **Secrets.** Keys that seal secrets and the private key that opens a backup are yours to keep elsewhere. A backup that holds sealed secrets is no use without the key that opens them.

## Drills

`restore-drill.mjs` runs this from a clean instance and writes [the record](restore-drill-record.md). The plan's exit needs someone other than the owner to have run it. It asks who that was, and code cannot answer for them.

It takes the authority review above in its order, before any reconcile: inspect into the review folder, the revocations if the review found any and a second inspect, `review.json` from what the person answers, a reconcile that must be refused before the acknowledgment, 0422's cooldown, and the acknowledgment through the `migrate` one-shot. Only then does it start Temporal and run the reconcile: a report, `--apply`, and `--apply` again. It does not decide about whole files (step 6), re-prove restore debt or delete raw survivors (step 7), or start anything that serves.

So it needs two things the commands above do not:

- **`--review-directory`**, an empty folder that is yours alone. It is mounted at `/review` in each one-shot, read-write for `inspect` and read-only for the rest, and the one-shot runs as your own user and group (`--user <uid>:<gid>`) where the system has them.
- **A person at a terminal.** It asks there who is running it, whether anything needs revoking, who reviewed the authority and against which reports. With no terminal it stops with `DRILL_NEEDS_A_PERSON_AT_A_TERMINAL` before it changes anything.

[The record](restore-drill-record.md) lists its questions, the files it leaves in the review folder, and every field it writes.
