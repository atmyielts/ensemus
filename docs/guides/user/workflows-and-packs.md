---
title: Bundled workflows and packs
audience: user
area: agents
tickets: [AGENT-12, AGENT-13, AGENT-14, EXP-01]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/studio/page.tsx, apps/web/src/app/o/[organizationId]/packs/page.tsx, apps/web/src/app/o/[organizationId]/packs/installations/[installationId]/page.tsx, apps/web/src/server/pack-actions.ts, packages/application/src/product/packs.ts, packages/packs/src/index.ts, packages/department-packs/src/marketing/index.ts, tests/integration/marketing-pack.test.ts]
tests: []
---

# Bundled workflows and packs

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

A pack supplies record types, assistant drafts and workflow drafts. It comes with the release and downloads nothing. Installing a pack does not run its assistants or workflows and gives nobody new permissions.

## Review a pack

An owner or administrator opens **Automation Studio**, then **Packs**. This release offers **Sales operations** and **Marketing operations**, each at versions **1.0.0** and **1.1.0**. HR, finance and learning packs are still being developed and are not offered.

1. Choose **Review what it asks for** on the version you want.
2. Read **What this pack asks for**. Each request explains why it is needed, what it may read and what it may change.
3. Choose **Accept** or **Decline** for each request. There is no decision that accepts them all.
4. Check **What it would make** and **Left out**. Declining a request leaves its dependent items out. A missing tool also leaves the item out; accepting its request does not create a tool or a connection.
5. Once every request is decided, open **Install this version**, read and tick the confirmation, and press **Install**. If asked, complete the security check and return to the review.

**What it made** links to the record types and drafts. Each assistant and workflow still needs its own settings, rehearsal, review and publication before it can run. A cost limit, permissions, model and external connection are separate settings; the pack chooses none of them for you.

## Marketing operations

This pack creates **Campaign** and **Claim source** record types, plus **Campaign planner** and **Claims checker** assistant drafts. The assistants read only separately permitted work and artifacts, prepare drafts and contact nobody. Missing sources remain unchecked for a person to review.

The proposed **Review a campaign message** workflow puts the attached claim/source review and a person's approval before a proposed email. The email still needs its own configured connection and approval. Declining **email.send** leaves that workflow out while the record types and assistant drafts can still be made. The pack offers no bulk send.

Version **1.1.0** adds an optional **Review note** field to Campaign. It introduces no new capability.

## Upgrade and roll back

Open **Packs** and review the newer version the same way. New capabilities always require a new decision. Installing the newer version supersedes the old installation.

Where an installed version offers **Roll back this version**, read and confirm the action. Rollback restores the earlier pack's drafts and retains entered records and additive fields. It does not undo an external action or erase record data. Anything already published needs its own review and cannot silently become an older draft.

## When an item is unavailable

If the tool list cannot be read, the page says so and leaves tool-dependent items out. If a capability was declined or a tool is missing, **Left out** states the reason. Review these results before treating an installation as ready for use.

A workflow starter is also a draft. In particular, a meeting or accounting step shown in a starter does not mean its provider connection or the underlying feature has been completed.
