---
title: Offline upgrades and maintenance lapse
audience: operator
area: op-sovereign
tickets: [OPS-11]
modes: [sovereign]
status: written_untested
sources: [docs/05-operations/sovereign/upgrade-and-rollback.md, docs/05-operations/sovereign/offline-bundle.md, workers/workflow/src/tools/install-bundle.ts, packages/sovereign/src/bundle.ts, infrastructure/scripts/bundle-rehearsal.mjs, packages/domain/src/license.ts, packages/application/src/licensing.ts, workers/workflow/src/sovereign-license-command.ts, docs/05-operations/sovereign/license-and-maintenance.md, tests/unit/no-license-gate.test.ts, docs/00-foundation/adr/ADR-030-sovereign-license-and-bundle.md]
tests: []
---

# Offline upgrades and maintenance lapse

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**A real upgrade has not been run,** and cannot be yet, because no bundle can be built until the Compose overlay exists. See [Installing from an offline bundle](offline-install.md). The rules below have unit tests, with a stand-in for Docker. Nothing here states how long any of this takes, or how much data you could lose, because those depend on your backups and your site. Measure them with your own drill.

## What a lapse changes

**A lapse changes what an administrator reads, and nothing else.** No code path refuses a request because of a license, and the same holds for a stopped clock, a missing trust root and a damaged file. Software already running keeps running, including agents, workflows and sign-ins. There is no heartbeat, and no check over the network. `tests/unit/no-license-gate.test.ts` on the `m6-license` branch fails if anything starts to use a license as a gate.

The offline acceptance test's advanced-date round is what would show this on built binaries, and it has not been run.

| Notice or status | What it means | What to do |
|---|---|---|
| Support status `active` | A maintenance statement covers today | Nothing |
| Support status `lapsed`, notice `maintenance_lapsed` | The last covered day has passed | Your agreement decides what comes next. The software keeps running |
| `maintenance_not_started` | The only statement starts later | Nothing, or check the dates |
| `no_maintenance` | A license is installed, with no statement | Attach the statement, if you hold one |
| `running_release_outside_rights` | The running release is outside what the license covers. It keeps running | This affects only your next install. Talk to whoever you hold the license from |
| `clock_before_issue` | This machine's clock reads earlier than the license was issued, so the dates above may be wrong | Fix the clock if you can. Nothing else changes |
| `unverifiable` standing, `license_unverifiable` | Something is installed, and none of it could be checked. Usually the trust root is missing, or a key was removed from it | Check `ENSEMUS_LICENSE_TRUST_ROOT_FILE` |

Renewing adds one small signed file, and never touches the license. Attach it as in [Issuing and installing a license](license-issuance.md).

## Before you upgrade

- **Back up first.** Every install asks you to name a backup, and the tool cannot check that it exists or that it restores. See [Backup and restore](backup-and-restore.md).
- **Migrations are not undone by a rollback.** No release ships a way to reverse its database changes.
- **A rollback means restoring that backup,** and everything written since that backup is lost.
- **What ran elsewhere does not unhappen.** A message sent, or a file someone downloaded, stays that way.

## Upgrade

First, check the bundle with the copy of `verify-bundle.mjs` you already trust, not the one inside the new bundle.

```sh
node verify-bundle.mjs ./bundle-new --trust-root /secure/trust-root.json
```

Then see the plan. It lists the limits on coming back, and changes nothing.

```sh
node install-bundle.mjs ./bundle-new --trust-root /secure/trust-root.json \
  --state-dir /srv/ensemus-state --dry-run
```

If the limits include `PLAN_RUNS_MUST_DRAIN`, do that now. The tool shows this limit and cannot check it, because it has no connection to your database.

Take a backup, and note exactly what it is called. Then run it.

```sh
node install-bundle.mjs ./bundle-new --trust-root /secure/trust-root.json \
  --state-dir /srv/ensemus-state \
  --operator "A. Example" --backup-reference "backup-before-2.1.0" \
  --license /secure/license.dsse.json --maintenance /secure/maintenance.dsse.json
```

The tool loads and checks every image while the old version is still running, so a bad bundle stops there and costs you nothing. Then it stops the services, runs migrations, starts everything, confirms each running container is the signed image, and appends a line to the record. Success ends with `done direction=upgrade version=2.1.0`.

**Only versions a bundle lists can upgrade to it.** Anything else needs an intermediate bundle first.

## Update rights

Pass `--license`, and each `--maintenance` file, for the tool to check rights. Each is verified against your trust root, and the support policy comes from the bundle. The answer rests on the release's signed publication date and your signed statements, so moving a clock changes nothing. The one exception is a license that says `not_kept`, which asks about today by its meaning.

| The answer | What happens |
|---|---|
| No license given, or one that does not verify | The install goes on, and says so |
| Covered | The install goes on |
| Not covered, license says `warn` | Stops with `OUTSIDE_RIGHTS_NOT_CONFIRMED` until you pass `--confirm-outside-rights`, which the record keeps |
| Not covered, license says `refuse` | Refused with `OUTSIDE_RIGHTS_REFUSED`. What you run now goes on running |

Which releases are covered depends on values in your license, and those are set by your agreement. See [Security advisories and supported branches](advisories-and-branches.md).

## Roll back

A rollback needs three things: you asked for it, the version going away lists the target in its own `rollback_to`, and you hold the backup from before the upgrade.

Read the limits first, with `--dry-run --rollback`, using the older bundle. Then take a new backup of where you are now, in case you want any of it back. Then start the rollback.

```sh
node install-bundle.mjs ./bundle-old --trust-root /secure/trust-root.json \
  --state-dir /srv/ensemus-state --rollback \
  --operator "A. Example" --backup-reference "backup-before-2.1.0"
```

It checks images, stops the services, and **stops with `RESTORE_REQUIRED`**, with nothing migrated or started. Now restore that backup, as in [Backup and restore](backup-and-restore.md), including the steps in [After a restore](after-a-restore.md), so deleted content stays deleted. Then run the same command again, with `--backup-restored` added.

**The tool takes `--backup-restored` on your word.** Passing it without having restored starts an older version on a newer database, which is what this procedure exists to prevent.

## Rollback limits

Each release lists these in its manifest, and the tool prints them. **An empty list means none are known, and is no promise that there are none.** The tool still prints a code it does not know, for you to look up in that release's guide.

| Code | What it means |
|---|---|
| `MIGRATIONS_NOT_REVERSIBLE` | No rollback undoes this release's database changes. Going back means restoring the earlier backup |
| `RESTORE_LOSES_LATER_WORK` | Restoring that backup loses everything written after it |
| `WORKFLOW_HISTORY_NOT_COMPATIBLE` | Workflows started on this release may not replay on the older one. Let them finish, or stop them, first |
| `PLAN_RUNS_MUST_DRAIN` | Every plan run has to finish or be stopped first. Check no work is `running` or `awaiting_approval` under a plan |
| `EXTERNAL_EFFECTS_NOT_UNDONE` | What this release did in other systems stays done |

## When it refuses

Each of these prints `stopped code=`, and leaves what you run now as it was, unless the table says otherwise.

| Code | Why | What to do |
|---|---|---|
| Any code in [the bundle check](offline-install.md) | The bundle is damaged, tampered with, or not signed by a key you trust | Do not use it |
| `UPGRADE_PATH_NOT_LISTED` | This bundle does not list your version | Install an intermediate bundle first |
| `ROLLBACK_NOT_REQUESTED` | The bundle is older than what runs. **An old, unpatched bundle cannot be replayed as an upgrade, however good its signature** | Use `--rollback`, if you mean to go back |
| `ROLLBACK_NOT_LISTED` | The version going away does not list this target | Going back this far is not supported as one step |
| `NOT_A_ROLLBACK` | You passed `--rollback`, and this bundle is not older | Look again at which bundle you meant |
| `SAME_VERSION` | Already installed | Nothing |
| `STOP_FAILED` | Unclear: services may be partly stopped | Look at `docker compose ps`, then run again |
| `RESTORE_REQUIRED` | Expected on a rollback. Services are stopped, and no migration has run | Restore, then run again with `--backup-restored` |
| `MIGRATIONS_FAILED`, `START_FAILED`, `SMOKE_TEST_FAILED` | Migrations may have run, and nothing was recorded | Read the logs. If it cannot go forward, restore the backup |

The rest of the list, for backups, state and images, is in [Installing from an offline bundle](offline-install.md).

## Rehearse it

In a Compose project of its own, with a throwaway key, `bundle-rehearsal.mjs` builds two bundles and goes through an upgrade and a rollback. It fails if any expected refusal does not happen. It writes what happened, with who ran it, under `.local/bundle-rehearsal/`.

```sh
node infrastructure/scripts/bundle-rehearsal.mjs --operator "A. Example"
```

**It has not been run,** and it will not start until the overlay exists. It needs Docker and several GB of disk. One rehearsal on one machine says nothing about your site.
