---
title: Dependencies between work
audience: user
area: work
tickets: [WORK-02]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx, apps/web/src/server/work-actions.ts, apps/web/src/lib/messages.ts, packages/application/src/work.ts, packages/domain/src/work-unit.ts, tests/stack/product-flows.test.ts, tests/stack/pages.test.ts, tests/stack/api.test.ts]
tests: []
---

# Dependencies between work

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

A dependency says one piece of work has to finish before another can go ahead. It is on the work's page, under **Dependencies**.

- **Has to finish first** lists what this work is waiting on.
- **Waiting on this** lists work that is waiting on this one.

## Add a dependency

1. Open the work that has to wait.
2. Under **Dependencies**, choose under **Add**.
3. Press **Add dependency**.

You can add one only while the work is **Waiting to start** or **Blocked**, and only if you can change it. The list offers work you can see, your 50 most recent items at most, and leaves out **Stopped** work, which can never finish. If the list is cut short, it says **Showing only your 50 most recent items.**

## What it does

While anything it depends on is not **Done**, the work cannot be marked ready. You see **This cannot be marked ready until what it depends on is done.**, and **Mark ready** is not offered.

When the last thing finishes, work that is **Waiting to start** moves to **Ready** by itself. **Blocked** work stays **Blocked** until someone presses **Mark ready**.

Reopening finished work does not move work that has already gone ahead.

## Stop waiting

Press **Stop waiting** next to the item. You need to be able to change the work, and it must not be finished. Do this if something it depends on was **Stopped**, because that can never finish, and the work would wait for good.

## Work you cannot see

Something it depends on may be something you are not allowed to see. Ensemus tells you how many, and never what they are.

- **This is also waiting on one piece of work you do not have access to.** Someone who can see it can tell you more.
- **Nothing you can see.** appears under **Has to finish first** when all of what it waits on is hidden from you.
- **One of these was stopped, so it can never finish.** Press **Stop waiting on stopped work**, if you can change this work. This does not show you what it was, or change it.

Hidden work that can still finish keeps holding your work. Ask someone who can see it, or the work's accountable owner.

## What it will not do

- It will not let work wait on itself, or on anything that leads back to it.
- It will not start anything for you when a prerequisite finishes. **Ready** still means nothing runs until someone starts it.
- It does not let you add a dependency once the work is **Ready**, **In progress** or later. You see **Dependencies can only be added before work is ready, or while it is blocked.**
- A dependency gives nobody access to the other piece of work.

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| That dependency would create a loop. | This would make work wait on itself, directly or through other work. Nothing was added | Remove the dependency that closes the loop, or choose different work |
| This work is waiting on prerequisites that are not done. | Something it depends on is not **Done**, possibly something you cannot see | Finish it, or stop waiting on it |
| That cannot be done while the work is in this status. | It has moved past the point where a dependency can be added, or it is finished | Mark it blocked first if it is **In progress**, or leave it |
| You do not have permission to do that. | You can see this work, but cannot change it | Ask its accountable owner, or an owner or admin |
| Not found, or you do not have access. | The other work does not exist, or you cannot see it. Nothing was changed | Ask someone who can see it |

## What another organization can see

Nothing. Work from another organization is not offered, and asking for it by its reference gets the same answer as something that does not exist. A dependency can only join two pieces of work in one organization.
