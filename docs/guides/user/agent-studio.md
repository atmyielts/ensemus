---
title: Agent Studio
audience: user
area: agents
tickets: [AGENT-08, AGENT-09]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/studio/page.tsx, apps/web/src/app/o/[organizationId]/studio/reviews/[reviewId]/page.tsx, apps/web/src/server/studio-actions.ts, packages/application/src/product/agent-drafts.ts, packages/application/src/product/simulations.ts, packages/application/src/product/publish-reviews.ts, packages/application/src/ai/agents.ts, tests/integration/studio-publishing.test.ts, tests/stack/studio-evaluation-api.test.ts]
tests: []
---

# Agent Studio

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Automation Studio lets you prepare an assistant draft, rehearse its proposed permissions and request a review. A draft runs nothing and grants no access. An installed department pack can also supply a starting draft; see [Bundled workflows and packs](workflows-and-packs.md).

## Prepare and rehearse

Open **Automation Studio** and choose the assistant draft you want to work on. Describe its role, intended outcome, boundaries, responsible person, permitted sources and tools, and its limits. Missing settings remain work to do. Saving a draft does not publish it.

Rehearsals use generated facts to check the proposed behavior and permission gates. Read their failures and what would need approval. A passed rehearsal does not show that a real model produces a good result.

When the current revision has passed its required rehearsal, ask for a review. The review binds to that revision and its responsible person. Where an independent reviewer is required, the person who asked cannot decide it. Changing the draft makes the older rehearsal or review stale.

## Publish the approved revision

Open the approved review and read what it would publish. Publishing requires a recent authenticator or recovery code and permission to publish.

For an assistant, **Signed evaluation report** is also required. Paste the independently signed report from the evaluator your installation trusts, for this exact specification and current policy. The report must be recent and pass the required evaluation suite. A report changed after signing, from an untrusted evaluator or for another revision is refused. A scripted-model report can publish only a sandbox agent; a rehearsal is not a substitute.

The report must fit within the size shown beside the field. Studio does not hold an evaluator's private signing key and cannot create a report for you. If no evaluator is configured, ask the person operating your installation to arrange an evaluation before publishing.

Confirm **Publish approved snapshot**. A successful publication creates an immutable version and its review receipt together. Repeating that completed request returns the same receipt. Publication makes the version available and starts no work by itself. Work already under way keeps its pinned version.

A workflow review needs its own rehearsal, review and security check, but no assistant evaluation report.
