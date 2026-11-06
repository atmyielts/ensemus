---
title: Offline upgrades and maintenance lapse
audience: operator
area: op-sovereign
tickets: [OPS-11]
modes: [sovereign]
status: written_untested
sources: [m6-license:packages/domain/src/license.ts, m6-license:packages/application/src/licensing.ts, m6-license:workers/workflow/src/sovereign-license-command.ts, m6-license:docs/05-operations/sovereign/license-and-maintenance.md, m6-foundation:packages/sovereign/src/bundle.ts, m6-foundation:docs/00-foundation/adr/ADR-030-sovereign-license-and-bundle.md]
tests: []
---

# Offline upgrades and maintenance lapse

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**An offline upgrade cannot be done yet.** The tools that verify and install a bundle still refuse with `NOT_IMPLEMENTED`, so this page has no upgrade steps. What it can describe is what a maintenance lapse does and does not change, because that part is written.

## What a lapse changes

**A lapse changes what an administrator reads, and nothing else.** No code path refuses a request because of a license. The same holds for a stopped clock, a missing trust root and a damaged file. Running software keeps running, including agents, workflows and sign-ins. There is no heartbeat and no check over the network. `tests/unit/no-license-gate.test.ts` on the `m6-license` branch fails if anything starts to use a license as a gate.

The advanced-date round of the offline acceptance test is what would show this on built binaries, and it has not been run.

## What you will read

Each of these is a notice, and none of them stops anything.

| Notice or status | What it means | What to do |
|---|---|---|
| Support status `active` | A maintenance statement covers today | Nothing |
| Support status `lapsed`, notice `maintenance_lapsed` | The last covered day has passed | Your agreement decides what comes next. The software keeps running |
| `maintenance_not_started` | The only statement starts later | Nothing, or check the dates |
| `no_maintenance` | A license is installed, with no statement | Attach the statement, if you hold one |
| `running_release_outside_rights` | The running release is outside what the license covers. It keeps running | Affects only your next install. Talk to whoever you bought from |
| `clock_before_issue` | This machine's clock reads earlier than the license was issued, so the dates above may be wrong | Fix the clock if you can |
| `unverifiable` standing, `license_unverifiable` | Something is installed and none of it could be checked. Usually the trust root is missing, or a key was removed from it | Check `ENSEMUS_LICENSE_TRUST_ROOT_FILE` |

## Renewing

Renewing adds a small signed file, and never touches the license. Attach the new maintenance statement as in [Issuing and installing a license](license-issuance.md). A statement for a license not installed in that organization is refused with `LICENSE_NOT_VALID`, and nothing is stored. No issuing tool exists yet, so no real statement can be made today.

## What an upgrade will check

The format and the rules are decided, and the code that applies them is what is missing. An install checks a bundle's rights on the signed dates, using the license's `outside_rights_on_install` value. That check can only ever affect a new install. Which releases you may install after a lapse is set by your agreement and the values in [Security advisories and supported branches](advisories-and-branches.md).

## When it refuses

Nothing here refuses to run. The only refusals are for files: a maintenance statement that fails verification, with the codes in [Issuing and installing a license](license-issuance.md), or one with no license to attach to. An organization's license and statements are its own, and another organization cannot see them.
