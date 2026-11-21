---
title: Live status and reconnecting
audience: user
area: work
tickets: [API-13]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/components/live-status.tsx, apps/web/src/components/edit-work-form.tsx, apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx, apps/web/src/app/api/v1/organizations/[organizationId]/work-units/[workUnitId]/events/route.ts, packages/application/src/work.ts, tests/stack/api.test.ts]
tests: []
---

# Live status and reconnecting

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

The page of a piece of work follows that work while you have it open. There is nothing to press, and nothing on the page says it is happening.

## What you will see

The page updates by itself when:

- the status changes
- the details or the owner change
- a file is added or deleted
- a review is asked for or decided, or runs out

If you are typing in **Edit the details**, your text stays. If someone else changes the same text, you see **This changed while you were editing. Your text is still below. Saving replaces what is there now:**, and you decide.

## If the connection drops

The page tries again by itself, waiting a little longer each time, and picks up from where it was. It also tries again if Ensemus restarts while you are looking. If it never reconnects, the page is out of date but nothing is lost. Reload it, and it shows what is true.

If you act on an out-of-date page, you see **Someone else changed this first. Check the latest version and try again.**, and your change is not made.

## What it will not do

- **Only the page of a piece of work is live.** **Home**, **Work**, **Approvals** and **Inbox** show what was true when you opened them. Reload them to see what is new.
- Not every change moves the page. Someone added to the work, or a dependency added, shows when you reload.
- It will not interrupt you with a message. Things that need you are in your **Inbox**. See [Notifications and reminders](notifications.md).
- It does not say who is looking at the work.

## When it stops

The page stops updating in these cases. A restore is the only one it tries again after.

| What happened | What you see next |
|---|---|
| You were disabled, or taken off work you can only see by being on it | The page does not change, and the next thing you do shows **Page not found** |
| You signed out, or your session ended | The next thing you do takes you to **Sign in to Ensemus** |
| Your organization is being restored from a backup | The next thing you do shows **This organization is being restored** |

Reloading always gives the true answer.

## What another organization can see

Nothing. The page checks again, while it is open, whether you may still see this work, so access you have lost stops the updates. Someone in another organization cannot follow your work, and gets the same answer as for work that does not exist.

If you build on this yourself, see [The public API](public-api.md).
