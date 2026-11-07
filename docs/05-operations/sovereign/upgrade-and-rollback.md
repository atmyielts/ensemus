# Upgrading and rolling back

For anyone installing a release from an offline bundle (`OPS-03`, `OPS-11`, ADR-030 D4). [offline-bundle.md](offline-bundle.md) covers checking a bundle and what each stop means.

**State of this:** the rules below are unit tested with a double for Docker. The real upgrade and rollback have not run yet. `infrastructure/scripts/bundle-rehearsal.mjs` is written to run them, and nothing here states how long any of it takes or how much data you could lose: those depend on your backups and your site, so measure them with your own drill.

## Read this first

1. **Back up first.** Every install asks you to name a backup, and the tool cannot check that it exists or that it restores. That part is yours, and testing a restore is the only way to know.
2. **Migrations are not undone by a rollback.** No release ships a way to reverse its database changes.
3. **A rollback means restoring that backup.** Going back to an older version means putting back the database from before the upgrade. Everything written since that backup is lost.
4. **What ran elsewhere does not unhappen.** A message sent, a record changed in another system, or a file someone downloaded stays that way. A restore reaches none of it. After a restore, the reconcile command reports what it finds, and sends and retries nothing (`backup-and-restore.md`).

Nothing here can affect the version you are running because of a license. A lapsed agreement or a release outside your rights can only change what happens to a **new** install, and only if your license says to.

## Upgrade

1. Check the bundle with the copy of `verify-bundle` you already trust.
2. See the plan, which also lists the limits on coming back:

   ```text
   node install-bundle.mjs <folder> --trust-root <file> --state-dir <dir> --dry-run
   ```

3. If the plan runs must drain for this upgrade, do that now. See the rule below.
4. Take a backup, following `backup-and-restore.md`. Note exactly what it is called.
5. Run it for real:

   ```text
   node install-bundle.mjs <folder> --trust-root <file> --state-dir <dir> \
     --operator "<your name>" --backup-reference "<which backup>"
   ```

The tool loads and checks every image while the old version is still running, so a bad bundle stops there and costs you nothing. Then it stops the services, runs migrations, starts everything, confirms each running container is the signed image, and appends one line to the record.

**Only the versions a bundle lists can upgrade to it.** Anything else is refused with `UPGRADE_PATH_NOT_LISTED`, and needs an intermediate bundle first.

**An old bundle cannot be replayed as an upgrade.** An older version is refused with `ROLLBACK_NOT_REQUESTED`, however good its signature still is. That is how an old, unpatched release is kept from being installed by mistake or on purpose.

### Plan runs must drain

From the container runbook, and it still applies: plan runs must drain before upgrading across migration 0004 to any later release. A run started before `work_units.run_id` existed replays correctly and then ends without moving its work or reporting it. Before such an upgrade, let every plan run finish or stop it, and check that no work is `running` or `awaiting_approval` under a plan. No deployment of that code is known to exist.

If a run did cross that migration, its work is left `running` or `awaiting_approval` with an empty `run_id`, and a person has to move it by hand, using the ordinary buttons on its page.

A bundle whose release has a rule like this lists `PLAN_RUNS_MUST_DRAIN`. The tool shows it and does not check it, since it has no connection to your database.

## Roll back

A rollback needs three things: you asked for it, the version going away lists the target in its own `rollback_to`, and you have the backup from before the upgrade. An old bundle cannot vouch for its own return, which is why the list that counts is the one in what is installed now.

1. Read the limits the plan prints:

   ```text
   node install-bundle.mjs <older folder> --trust-root <file> --state-dir <dir> --dry-run --rollback
   ```

2. Take a new backup of where you are now, in case you want any of it back later.
3. Start the rollback:

   ```text
   node install-bundle.mjs <older folder> --trust-root <file> --state-dir <dir> --rollback \
     --operator "<your name>" --backup-reference "<the backup from before the upgrade>"
   ```

   This checks the images, stops the services, and **stops with `RESTORE_REQUIRED`**. Nothing has been migrated or started.

4. Restore that backup, following `backup-and-restore.md`, up to and including the tombstone ledger re-apply and the reconcile report, so deleted content stays deleted.
5. Run the same command again with `--backup-restored`:

   ```text
   node install-bundle.mjs <older folder> --trust-root <file> --state-dir <dir> --rollback --backup-restored \
     --operator "<your name>" --backup-reference "<the backup from before the upgrade>"
   ```

The tool takes `--backup-restored` on your word, because it has no connection to your database. **Passing it without having restored starts an older version on a newer database**, which is the thing this whole procedure exists to prevent.

### When it refuses

| Code | Why |
|---|---|
| `ROLLBACK_NOT_REQUESTED` | The bundle is older than what runs, and you did not pass `--rollback` |
| `ROLLBACK_NOT_LISTED` | The version going away does not list this target. Going back this far is not supported as one step |
| `NOT_A_ROLLBACK` | You passed `--rollback`, and this bundle is not older than what runs |
| `SAME_VERSION` | This version is already installed |
| `RESTORE_REQUIRED` | Expected the first time. See above |

## Rollback limits

The manifest of each release lists these codes in `rollback_constraints`. The tool prints them before an upgrade, since they decide whether you can come back, and again before a rollback. **An empty list means none are known, and is no promise that there are none.** A code this tool does not know is still printed: look in that release's guide.

| Code | What it means |
|---|---|
| `MIGRATIONS_NOT_REVERSIBLE` | This release changes the database in a way no rollback undoes. Going back means restoring the backup taken before upgrading |
| `RESTORE_LOSES_LATER_WORK` | Restoring that backup loses everything written after it was taken |
| `WORKFLOW_HISTORY_NOT_COMPATIBLE` | Workflows started on this release may not replay on the older one. Let them finish, or stop them, before going back |
| `PLAN_RUNS_MUST_DRAIN` | Every plan run has to finish or be stopped first. Check that no work is `running` or `awaiting_approval` under a plan |
| `EXTERNAL_EFFECTS_NOT_UNDONE` | What this release sent or did in other systems stays done. A restore does not reach them |

## Maintenance and update rights

Pass `--license` and any `--maintenance` files to have the tool check rights. Each is verified against your trust root, and the support policy comes from the bundle. The answer rests on the signed publication date of the release and your signed agreements, so moving a clock changes nothing, except for a license that says `not_kept`, which asks about today by its meaning.

| The answer | What happens |
|---|---|
| No license given, or a license that does not verify | The install goes on, and says so. Your running system was never in question |
| Covered | The install goes on |
| Not covered, license says `warn` | Stops until you pass `--confirm-outside-rights`, which the record keeps |
| Not covered, license says `refuse` | Refused with `OUTSIDE_RIGHTS_REFUSED`. What you run now goes on running |

A maintenance statement that does not verify or belongs to another license is left out, and a message says so. No signed document can make a running system stop.

## Rehearse it

```text
node infrastructure/scripts/bundle-rehearsal.mjs --operator "<your name>"
```

From a clean stack in its own Compose project, with a throwaway key, it does the following, and fails if any refusal does not happen:

- builds two bundles, then refuses an added file, a changed file and a trust root inside the folder
- installs the older bundle, then refuses the same version and an upgrade with no backup named
- refuses a signed manifest whose digest differs, and checks the running stack did not change
- backs up, upgrades, and refuses the older bundle replayed as an upgrade
- starts a rollback, stops at the restore, restores, finishes, and checks the record

It writes a record of what happened, with who ran it, under `.local/bundle-rehearsal/`. With no `--from-image` and `--to-image`, both bundles hold the same images, which rehearses the mechanics and not a real difference between releases, and the record says so. A rehearsal is one run on one machine: it says nothing about a customer's site.
