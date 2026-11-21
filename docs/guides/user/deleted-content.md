---
title: What happens to deleted content
audience: user
area: work
tickets: [LIFE-01]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx, apps/web/src/app/o/[organizationId]/work/[workUnitId]/files/[fileId]/route.ts, apps/web/src/app/o/[organizationId]/approvals/[approvalId]/page.tsx, apps/web/src/app/restoring/route.ts, apps/web/src/server/tenant.ts, apps/web/src/server/work-actions.ts, apps/web/src/server/api.ts, packages/application/src/artifacts.ts, packages/application/src/tombstone-ledger.ts, packages/application/src/work.ts, packages/domain/src/work-unit.ts, tests/stack/product-flows.test.ts, tests/stack/pages.test.ts]
tests: []
---

# What happens to deleted content

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

In Ensemus today, you can delete a file attached to work. Deleting one is permanent.

## Delete a file

1. Open the work, and go to **Files**.
2. Press **Delete** next to the file.
3. Tick the box. It says **for good. It cannot be recovered.**
4. Press **Delete permanently**.

You need to be able to change the work. You can delete a file while work is open, and on **Stopped** work. You cannot while it is paused for a review, or **Done**. **Files on finished work are its record. Reopen it to change them.**

## What you will see afterwards

- The file is gone from **Files** straight away, for everyone.
- A saved download link answers **Not found**, the same as a link that never existed.
- A review open on that work closes, because what it covered has changed. Whoever asked is told.
- An approved review of that work shows **Out of date**, and no longer counts as evidence.
- An old review page says how many files it covered have since been deleted, such as **One file this covered has since been deleted.**
- If the work asked for **Someone attaches a file** and this was the only one, **Verification** goes back to **Still needed**.

## If the file's contents cannot be removed straight away

You are done once access is blocked, and that happens first. If the file store is unavailable at that moment, Ensemus keeps trying at its periodic check. Nobody can download the file meanwhile.

## After a restore from a backup

If your administrator restores your organization from a backup, a file deleted after that backup could come back with it. Ensemus keeps its own record of deletions to prevent that.

When Ensemus finds the restored organization is behind that record, you see **This organization is being restored**, and it stays unavailable until your administrator has put those deletions back. Try again later, or ask your administrator how it is going.

## What stays

- The work's **History** and the record that a file was deleted stay. That record holds a reference, not the file's name or contents.
- A note, a reason or a title you wrote stays with its work. Deleting a file does not remove them.

## What it will not do

- It has no undo, and no recycle bin.
- It has no way to delete a piece of work, a client, a project, a team or a person. Work can be stopped, and people can be disabled. See [Work Units](work-units.md) and [People and teams](people-and-teams.md).
- This page does not say how long a backup copy lasts. Your operator or your agreement decides that. See [Retention](retention.md).

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| That cannot be done while the work is in this status. | The work is paused or **Done**, so its files cannot change | Wait for the decision, or reopen it |
| You do not have permission to do that. | You can see this work, but cannot change it | Ask its accountable owner, or an owner or admin |
| Please check the details and try again. | The box was not ticked. Nothing was deleted | Tick it, and press the button again |
| Not found, or you do not have access. | The file has already gone, or it is not on this work | Reload the page |
| This organization is being restored | Your organization is unavailable until the restore is finished | Try again later |

## What another organization can see

Nothing, before or after. A file can be reached only through its own work in its own organization, and a restore of one organization does not tell anyone outside it that it is happening.
