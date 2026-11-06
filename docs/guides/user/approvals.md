---
title: Approvals
audience: user
area: work
tickets: [WORK-05, WORK-07, UX-14]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/approvals/page.tsx, apps/web/src/app/o/[organizationId]/approvals/[approvalId]/page.tsx, apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx, apps/web/src/components/confirm-form.tsx, apps/web/src/components/ui.tsx, apps/web/src/lib/messages.ts, apps/web/src/server/work-actions.ts, packages/application/src/approvals.ts, packages/application/src/work.ts, packages/domain/src/approval.ts, tests/stack/product-flows.test.ts, tests/stack/pages.test.ts, tests/stack/api.test.ts]
tests: []
---

# Approvals

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

An approval is one named person's decision on exactly what they were shown. If the work changes, it needs a new approval.

## Ask for a review

1. Open the work. Under **Verification**, go to **Reviews**.
2. Choose a person under **Ask for a review from**.
3. Press **Request review**.

You can choose only someone else, who is active and can already see the work. Being asked does not give them access. If nobody can, you see **Nobody else who can see this work is able to review it.** Add someone to the work first.

They have 3 days to decide, and it appears in their **Approvals**, on their **Home** and in their **Inbox**.

There is one review at a time. A new one can be asked for once the open one is decided.

## Reviews that pause the work

| When you ask | What happens |
|---|---|
| The work is **In progress** | It pauses, as **Waiting for approval**. Approving lets it carry on. Denying it, or running out of time, stops it for good |
| The work is paused, and its reviewer can no longer decide | The new review takes over, and the work stays paused until it is decided |
| The work is in another open status | It is a plain review. It does not start or stop anything |

While work is paused, its details and files cannot change, because they are what is being reviewed.

A plan names its own reviewer when someone presses **Run the plan**, and nobody can swap that person afterwards. See [Work Units](work-units.md).

## Decide

Open **Approvals**. It lists **Decisions waiting for you, soonest first**, each with the time it is good **Until**. Select one, and you see **Your decision is needed**.

The page shows what you are deciding:

- **Action**: what you are asked to do, such as **Review this work and decide whether it is acceptable**.
- **Destination**: the work, its status and its sensitivity.
- **Risk**: what your decision does. It says **Nothing outside Ensemus changes.** for a review, and warns you if the work is sensitive.
- **What this affects** and **What this review covers**: the title and objective as they stood, and each file, with a link.
- **Asked by**, **Who decides** and **Valid until**.
- **Technical details**: the exact action, as stored.

Then, under **Decide**:

- To approve, add a note if you want one, and press **Approve**. People on this work can read the note.
- To deny a plain review, add a reason if you want one, and press **Deny**. The work stays as it is, without your approval.
- To deny a review that has paused the work, open **Deny**, answer **Why are you denying this? People on this work can read it.**, tick the box, and press **Deny and stop the work**. This stops the work for good, and it cannot be restarted.

## What changes an approval

| What happens | What you see |
|---|---|
| The title, objective or files change while it is open | It closes, as **Closed**. The person who asked is told |
| The title, objective or files change after it was approved | It shows **Out of date**, and no longer counts as evidence. Ask for a new review |
| A due date changes | Nothing. A review does not cover the due date |
| The time runs out | It shows **Expired**, and can no longer be approved. Paused work stops at the next periodic check, usually within 15 minutes, unless someone asks for a new review first |
| An approved review runs out | It shows **Out of date**, and no longer counts as evidence |
| The person asked loses access | It closes. Paused work stays paused until someone asks another person. A plan's run ends as **Failed** |
| The work finishes, fails, is stopped, or is reopened | It closes. Reopening also ends what was already approved |
| A file it covered is deleted | The approval says how many files have since been deleted |

## What it will not do

- You cannot approve your own request, even if it was assigned to you. **You asked for this approval, so someone else has to decide it.**
- Only the person named can decide. Others who can see the work read it, and see who decides.
- Pressing **Start** or **Mark ready** cannot release paused work. Only the decision can.
- A later review cannot overrule the one that paused the work.
- Approving does not do the work or finish it. See [Evidence and completing work](evidence-and-completion.md).

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| This approval has already been decided or closed. | Nothing further can be decided on it | Read what it says, or ask for a new review |
| This approval has expired. | The time ran out | Ask for a new review, if it is still needed |
| This approval is assigned to someone else. | You are not the person named | Ask them |
| You cannot approve your own request. | You asked for it, or you named yourself | Ask someone else |
| The action changed after you reviewed it. Please review it again. | What you saw is not what it now covers. Your decision was not recorded | Read the page again, then decide |
| This work changed after the review was requested. Ask for a new review. | The work no longer matches what was asked about | Ask for a new review |
| A review of this work is already open. It has to be decided first. | There is one review at a time | Wait for it, or for it to run out |
| Please give a reason. | Stopping paused work needs a reason | Write one |
| Please check the details and try again. | The box was not ticked, or the person cannot be asked | Tick it, or choose someone who can see the work |
| Not found, or you do not have access. | You cannot see this work, so you are not told the approval exists | Ask someone who can see it |

## What another organization can see

Nothing. An approval from another organization gets the same **Page not found** as one that does not exist. A decision from another organization is refused, and changes nothing.
