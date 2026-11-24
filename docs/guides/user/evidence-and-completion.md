---
title: Evidence and completing work
audience: user
area: work
tickets: [WORK-04]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx, apps/web/src/app/o/[organizationId]/work/[workUnitId]/files/[fileId]/route.ts, apps/web/src/app/o/[organizationId]/work/page.tsx, apps/web/src/components/new-work-form.tsx, apps/web/src/components/file-field.tsx, apps/web/src/lib/work-view.ts, apps/web/src/lib/messages.ts, apps/web/src/server/work-actions.ts, packages/application/src/work.ts, packages/application/src/artifacts.ts, packages/domain/src/work-unit.ts, packages/domain/src/approval.ts, tests/stack/product-flows.test.ts]
tests: []
---

# Evidence and completing work

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Work cannot be marked done until what you asked for is true. You decide what that is when you create the work, under **How will we know it is done?**, and it cannot be changed afterwards.

## What you can ask for

| You tick | What counts |
|---|---|
| **Someone attaches a file** | A file a person attached. The checklist a plan adds does not count |
| **A reviewer approves** | An approved review that still covers the work as it stands. See [Approvals](approvals.md) |
| Nothing | No evidence. The accountable owner has to confirm it themselves |

Ensemus checks that the file or the approval exists. It does not read the file, or judge whether it is any good.

## See where it stands

On the work's page, **Verification** lists what was asked for, each marked **Still needed** or **In place**. **Reviews** lists each review and its state.

In the **Work** list, the **Evidence** column says **None asked for**, **In place**, **Met when done**, or how many are still needed, such as **1 of 2 still needed**.

## Attach a file

Under **Files**, use **Attach a file**, choose the file and press **Upload**. A file can be up to 25 MB, and has the same sensitivity as its work. Anyone who can see the work can download it, and a download is always saved as a file and never opened on the page.

Attaching or deleting a file changes what a review covers, so an approved review of the earlier files stops counting. You cannot change files while work is paused for a review, or once it is **Done**. **Files on finished work are its record. Reopen it to change them.**

## Mark it done

1. From **In progress**, press **Send for checking**. The status becomes **Checking**.
2. When the evidence is in place, press **Mark done**.

If nothing was asked for, the button says **Confirm this is done**, and only the accountable owner sees it. The owner sees **Your confirmation as accountable owner is the only check on this work, and its history will say so.** History then says **Confirmed by** their name **as accountable owner. No evidence was requested.**

## Reopen or try again

- **Done** work: say why under **Why does this need reopening?**, and press **Reopen**.
- **Failed** work: say why under **Why is it worth trying again?**, and press **Try again**.

The work goes back to **Ready**. The reason is kept in the history. Any earlier review stops counting, so this work will need a new one.

## What it will not do

- No person, plan or button can mark work done while evidence is still needed.
- A plan never marks work done, and its own checklist file proves nothing.
- A review of an earlier version does not count. Neither does one that has run out.
- It does not offer an outside system's confirmation as evidence when you create work.

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| The evidence this work requires has not been provided yet. | Something under **Verification** says **Still needed**. The status did not change | Attach the file, or get the review |
| This work asks for no evidence, so only its accountable owner can confirm it is done. | You are not the accountable owner | Ask them, or have the work handed to you |
| That status change is not allowed from the current status. | It has to be **Checking** before it can be **Done** | Press **Send for checking** first |
| Please give a reason. | Reopening and trying again each need one | Write a reason |
| That file is larger than 25 MB, so it was not added. Attach a smaller one. | The file is over the limit | Attach a smaller one |
| Please check the details and try again. | The file is empty, for example | Choose another file |
| That cannot be done while the work is in this status. | It is paused or finished, so its files cannot change | Wait for the decision, or reopen it |
| Not found | A download link for a deleted file, or a file you may not see. The answer is the same for both | Ask someone who can see the work |

## What another organization can see

Nothing. Files and evidence are reached only through their own work, by someone who can see that work. A file link from another organization answers **Not found**, the same as one that does not exist.
