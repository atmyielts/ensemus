---
title: Work Units
audience: user
area: work
tickets: [WORK-01, WORK-03, UX-13]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/work/page.tsx, apps/web/src/app/o/[organizationId]/work/new/page.tsx, apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx, apps/web/src/components/new-work-form.tsx, apps/web/src/components/edit-work-form.tsx, apps/web/src/components/ui.tsx, apps/web/src/lib/work-view.ts, apps/web/src/lib/messages.ts, apps/web/src/server/work-actions.ts, packages/application/src/work.ts, packages/domain/src/work-unit.ts, packages/domain/src/policy.ts, tests/stack/product-flows.test.ts, tests/stack/pages.test.ts]
tests: []
---

# Work Units

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

A piece of work records an outcome, who answers for it, how you will know it is done, and what has happened to it. On screen it is simply called work.

## Create work

Press **New work**. Creating it only records the outcome, with you as the accountable owner. Nothing runs until someone starts it.

| Field | What to put |
|---|---|
| **What should be true when this is done?** | The outcome. Required, up to 300 characters |
| **Objective** | Optional. Any detail someone needs to do this well |
| **Due date** | Optional. The whole of that day, in UTC |
| **Project** | Optional. Shown when there are projects |
| **Sensitivity** | Who can see this work and its files. **It cannot be changed afterwards** |
| **How will we know it is done?** | **Someone attaches a file**, **A reviewer approves**, or neither. See [Evidence and completing work](evidence-and-completion.md) |
| **Plan** | **Ensemus runs the checklist plan**, if you want it |

Press **Create work**. If it is refused, what you typed stays in the form and the field at fault is named.

## Who can see it

| Sensitivity | Who can see it |
|---|---|
| **Public** | Everyone in this organization. Nothing in it is secret |
| **Internal** | Everyone in this organization |
| **Confidential** | The people on this work, plus organization owners and admins |
| **Restricted** | Only the people on this work. Owners and admins cannot see it unless they are on it |

**Public** does not mean public outside your organization. Files have the same sensitivity as their work.

## Who can do what

- **The accountable owner** answers for the work. There is always exactly one.
- **People on this work**, listed under **Also on this work**, can work on it, move it along, attach files and ask for a review. They can take themselves off.
- **Organization owners and admins** who can see it can do what the accountable owner does, except **Confirm this is done**.
- **Anyone else who can see it** can only read it, and sees no **Actions**.

Only the accountable owner, or an owner or admin who can see it, can use **Hand over to**, **Add someone**, **Remove** and **Stop this work**. The person who created the work is on it, and is removed like anyone else.

## Statuses

| Status | What it means | What you can press |
|---|---|---|
| **Waiting to start** | Not started | **Mark ready**, **Stop this work** |
| **Ready** | Ready, and nothing runs until someone starts it | **Start**, **Run the plan** if it has one, **Stop this work** |
| **In progress** | Being worked on | **Send for checking**, **Mark blocked**, **Mark failed**, **Stop this work** |
| **Blocked** | Blocked until someone clears the way | **Mark ready**, **Stop this work** |
| **Waiting for approval** | Paused for a review | Only the reviewer's decision lets this carry on. **Stop this work** still works |
| **Checking** | Being checked | **Mark done**, **Back to in progress** |
| **Done** | Finished | **Reopen**, with a reason |
| **Failed** | Did not finish | **Try again**, with a reason |
| **Stopped** | Stopped for good | Nothing. It cannot be edited or restarted |

Every change appears under **History**, with who made it, when, and any reason.

## Edit the details

Open **Edit the details**, change **Title**, **Objective** or **Due date**, and press **Save changes**. You cannot edit while the work is paused, **Done** or **Stopped**. Changing the title or objective means any review of it has to be asked for again. See [Approvals](approvals.md).

If someone changes it while you are typing, your text stays, and you see **This changed while you were editing. Your text is still below. Saving replaces what is there now:** with what is there now. Press **Keep my text** if it is offered, then decide whether to save.

## Hand it over

Choose a person under **Hand over to**, and press **Change owner**. They are told in their **Inbox**. This also works on finished work, so nothing is left with someone who has gone. A review by someone who can no longer see the work closes.

## Stop it

Open **Stop this work**, say why under **Why is this being stopped?**, tick the box, and press **Stop this work**. This is for good. It cannot be restarted, and any running plan and open review end too.

**Checking** and **Failed** work cannot be stopped directly. From **Checking**, press **Back to in progress** first. From **Failed**, press **Try again** first.

## Run a plan

If you ticked **Ensemus runs the checklist plan**, **Run the plan** appears once the work is **Ready**. If the work needs a reviewer, you choose one here. They cannot be you.

The plan adds a checklist file, asks for the review if one is needed, and sends the work for checking. It does not do the work, and it does not mark it done. A person does that once the evidence is in place.

The status changes when the plan actually starts. If nothing has picked it up after a few minutes, Ensemus asks again at its periodic check, about every 15 minutes. Starting by hand instead cancels that request, and whoever asked is told.

## Find work

**Work** lists everything you have access to, newest first, with **Status**, **Owner**, **Evidence**, **Due** and **Sensitivity**. Choose a **Status** and press **Filter** to narrow it. **Next page** shows more.

## What it will not do

- It does not do the work, or decide it is done. People do.
- It has no way to delete a piece of work. Stop it instead. See [What happens to deleted content](deleted-content.md).
- You cannot change a work's sensitivity, its project, or how it will be checked after creating it.
- You cannot add people to finished work. You can still take people off it.
- It will not send anything outside Ensemus from this page.

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| Someone else changed this first. Check the latest version and try again. | The page was out of date. Your change was not made, and the later change stands | Look at the page again, then redo it |
| That status change is not allowed from the current status. | The status cannot go there from here | Use the buttons the page offers |
| That cannot be done while the work is in this status. | It is paused or finished, for example | Wait for the decision, or reopen it |
| You do not have permission to do that. | You can see this work, but cannot change it this way | Ask its accountable owner, or an owner or admin |
| Not found, or you do not have access. | It does not exist, or you may not see it. The answer is the same for both | Ask someone who can see it |
| Page not found. This page does not exist, or you do not have access to it. | The same answer, for a whole page | Ask someone who can see it |
| Please give a reason. | Stopping, reopening and trying again each need one | Write a reason |
| Please check the details and try again. | A field is not usable, or a page link is no good. On **Work**, it starts again from the top | Check the form |
| Someone already asked this plan to run. That request still stands. | Pressed twice, or by two people | Wait for the status to change |
| You cannot approve your own request. | You named yourself as a plan's reviewer | Choose someone else |
| Write what should be true when this is done. It cannot be only spaces. | The outcome is empty | Write it |
| That is not a date. | The due date cannot be read | Choose a date |

## What another organization can see

Nothing. Another organization's members get the same **Page not found** for your work as for something that does not exist, and two organizations can use the same names without seeing each other. Restricted work is hidden in the same way from people inside your own organization who are not on it.
