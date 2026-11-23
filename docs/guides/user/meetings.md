---
title: Meetings and private notes
audience: user
area: work
tickets: [EXP-03]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [packages/application/src/meeting-manual.ts, apps/web/src/app/o/[organizationId]/meetings/page.tsx, apps/web/src/app/o/[organizationId]/meetings/[meetingId]/page.tsx, apps/web/src/app/o/[organizationId]/meetings/actions.ts, packages/database/migrations/0752_meeting_consent_administration.sql]
tests: [tests/integration/meeting-manual.test.ts, tests/stack/meeting-manual-api.test.ts, tests/browser/specs/meeting-manual.spec.ts]
---

# Meetings and private notes

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Open **Meetings** in the workspace. This workflow registers a meeting and stores plain-text notes. It does not record a call or contact a model or provider. Summaries, proposed work and connector imports are not available through this page yet.

## Turn meetings on

An owner or administrator opens **Meeting settings**, chooses **Allow new meetings**, and enters a notice reference. Your organization holds the notice itself; the reference identifies its document or version. Ensemus supplies no legal terms. Company sign-in and administrative identity policy also apply to this change.

Switching meetings off stops new meetings and notes. People can still withdraw consent. Keep the notice reference while an open meeting exists; clearing it is refused so participants retain a current reference for withdrawal.

## Register the meeting and its participants

Open **New meeting**, enter its title and when it occurred in UTC, choose a classification, and create it. Confidential is the default. The organizer is listed automatically.

On the meeting page, the organizer opens **Add someone**. Choose a company member, or choose an outside participant and enter their name. That name is a label, not an invitation or address. Nothing contacts an outside participant.

Each listed member records their own answer. The organizer can attest to an outside participant’s answer, and that is displayed as an attestation. Nobody, including an administrator, can answer for another company member. The notice reference must still be current when the answer is recorded.

An unanswered participant can be removed before notes exist. A recorded answer stays with its participant as history, and the organizer stays listed. Once notes exist, the participant list is fixed.

## Store notes

Everyone listed must agree first. The organizer then opens **Add notes**, enters plain text and chooses **Store notes**. Another save creates a new version. The page shows the latest version. Empty notes and notes exceeding the byte limit are refused.

Only the organizer and listed participants can read the title, participants and notes. Owners and administrators outside the room see only meeting status and metadata; their role does not give them the content. A person outside the company cannot read it here.

## Withdraw

A participant opens **Withdraw consent**, reads the consequence, checks the confirmation, and chooses **Withdraw and remove notes**. For an outside participant, the organizer attests to the withdrawal.

Withdrawal closes the meeting and removes every version of its notes and derived text in one transaction. It keeps the consent history and records the removal in the deletion ledger, so restoring an older database does not make notes readable again. Work someone separately created stays. People and providers may already have read an earlier copy; withdrawal cannot recall it.

A refused save keeps the submitted fields on the form. If someone changed the meeting first, reload its current version before trying again.
