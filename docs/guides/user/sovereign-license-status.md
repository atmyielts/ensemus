---
title: Your license and maintenance
audience: user
area: admin
tickets: [COMM-03, SOV-02]
modes: [sovereign]
status: written_untested
sources: [packages/application/src/licensing.ts, packages/domain/src/license.ts, workers/workflow/src/sovereign-license-command.ts, docs/05-operations/sovereign/license-and-maintenance.md, tests/unit/no-license-gate.test.ts, tests/integration/licensing.test.ts, docs/00-foundation/adr/ADR-030-sovereign-license-and-bundle.md, apps/web/src/lib/messages.ts]
tests: []
---

# Your license and maintenance

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Ensemus has no page for this yet. Whoever runs your deployment installs your license and maintenance files with a command, and that command reports the statuses on this page. Ask them what it says.

## What a lapse does

When maintenance lapses, that changes your support status only. Ensemus keeps running, and so do sign-in, your work and your agents. The same is true of a wrong clock, a missing key file or a damaged license file. Nothing in the product checks a license before letting you work.

## The two files

- **The license** says what was bought. The file has no expiry date, and is not tied to a machine. A pilot license has a review date, which is a date for people to talk and switches nothing off.
- **The maintenance statement** says maintenance runs from one day to another. Renewing adds a new statement, and leaves the license as it is.

Your agreement says what those mean for you. This guide states none of it.

## What the status means

Your license has one of these standings:

| Standing | What it means | What to do |
|---|---|---|
| `licensed` | A license is installed, and its signature checks out. | Nothing. |
| `unlicensed` | Nothing is installed yet. | Ask whoever runs your deployment to install it. |
| `unverifiable` | Something is installed, and none of it could be checked. Usually the file of trusted keys is missing, or a key was removed from it. | Ask whoever runs your deployment to check that file. |

Maintenance has one of these statuses:

| Status | What it means |
|---|---|
| `active` | A statement covers today. |
| `not_started` | A statement exists, and its first day has not come yet. |
| `lapsed` | The last covered day has passed. |
| `no_agreement` | No statement is installed. |

You may also be told one of these. Each one is information, and none of them stops anything:

| Notice | What it means | What to do |
|---|---|---|
| `no_license` | Nothing is installed yet. | Ask for the license to be installed. |
| `license_unverifiable` | What is installed could not be checked. | Ask for the file of trusted keys to be checked. |
| `no_maintenance` | No maintenance statement is installed. | Ask the contact in your agreement, if you expected one. |
| `maintenance_not_started` | Maintenance has not reached its first day. | Nothing, unless the date looks wrong. |
| `maintenance_lapsed` | The last covered day has passed. | Ask the contact in your agreement about renewing. |
| `pilot_review_due` | A pilot license has reached its review date. | Talk to the contact in your agreement. |
| `signed_with_test_key` | A file was signed with a generated test key. | Treat it as a rehearsal, and ask for a real one. |
| `signed_with_retired_key` | The file is still good. It was issued before its key was retired. | Nothing. |
| `clock_before_issue` | The machine's clock reads earlier than the license's issue date, so other dates here may be wrong. | Ask for the clock to be fixed. |
| `running_release_outside_rights` | The release you run is outside what the license covers. It keeps running. This affects only the next install. | Ask the contact in your agreement before the next upgrade. |
| `seats_above_footprint` | You have more active members than the license states. It is shown, and is not enforced. | Talk to the contact in your agreement. |

## When it refuses

Installing a file is the only thing here that can be refused. Refusing a file changes nothing that is already installed or running.

| What you see | What it means | What to do |
|---|---|---|
| That file could not be verified, so nothing was changed. Everything already installed stays as it was. | The file was changed or damaged, its signer is not trusted here, or it is a maintenance statement for a license not installed in this organization. | Install the license first. If that is not the cause, ask for a fresh copy of the file. |
| The code `FORMAT_NOT_SUPPORTED` | The file was issued in a newer format than your release reads. Nothing is wrong with the file. | Ask the contact in your agreement for a copy in a format your release reads. |
| The code `UNKNOWN_KEY` | The file of trusted keys does not know who signed this. | Ask whoever runs your deployment to check they have the right file of trusted keys. |

## What it cannot do

- **It cannot stop what you are running.** A license here is not copy protection. Seats and other numbers in it are shown only.
- **It cannot tell you what you may install later.** Your license states that, and your agreement says what it means. It only ever affects a new install, and never the version you are running.
- **It cannot tell you about support itself.** See [Getting support](support.md).

## Other organizations

A license is installed for one organization. On a deployment with several, it has to be installed for each, and each organization sees only its own files.
