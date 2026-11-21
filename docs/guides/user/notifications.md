---
title: Notifications and reminders
audience: user
area: work
tickets: [UX-17]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/inbox/page.tsx, apps/web/src/app/o/[organizationId]/layout.tsx, apps/web/src/server/work-actions.ts, packages/application/src/inbox.ts, packages/application/src/approvals.ts, packages/application/src/work.ts, workers/workflow/src/dispatcher.ts, tests/stack/pages.test.ts]
tests: []
---

# Notifications and reminders

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**Inbox** shows what needs you. Reminders come first, then anything else you have not opened, then what you have already opened. **Inbox** in the menu shows how many you have not opened.

## What you will see

Select a line to open what it is about. That marks it as opened. A line shows when it happened, **New** if you have not opened it, and **Reminder** if it has been raised again.

| Line | What it is about |
|---|---|
| An approval needs your decision | A review you were asked for. Its work's title is shown while it is waiting |
| A review of your work was decided | Someone approved or denied it |
| A review of your work ran out of time | Nobody decided it in time |
| A review of your work was closed, because the reviewer lost access | Ask someone else |
| A review of your work was closed, because the work changed | Ask for a new review |
| A review you asked for was closed, because a plan started and asks its own reviewer | The plan has its own review |
| A review you asked for was closed, because the work finished | Nothing is left to decide |
| A review you asked for was closed, because the work was reopened | Ask for a new review |
| A plan you asked to run was withdrawn, because someone moved the work | Look at the work, and ask again if you still want it |
| Work you own was stopped | Read the reason in its **History** |
| Work you own did not finish | It is **Failed**. See [Evidence and completing work](evidence-and-completion.md) |
| You were put on some work | You were added to it, or it was handed to you |
| Another owner chose a new owner for restricted work whose owner was disabled | For organization owners. It opens no work. See [People and teams](people-and-teams.md) |
| Someone is asking to join, and needs confirming | See [Inviting people](members-and-invitations.md) |

You are not told about what you did yourself.

## Reminders

Only an approval waiting for a decision gets reminders. The first comes about 4 hours after you are asked, and then about once a day, up to 3 in all. Ensemus checks for reminders due about every 15 minutes.

A reminder brings the line back to the top, unread, with **Reminder** on it. Opening the request is not answering it, so having opened it does not stop the reminders. Deciding it does. So does the approval closing or running out.

## When there are many

The inbox shows 50 lines at most. If you have more unopened than that, it says **You have** and the number, then **unopened items, and this shows 50 of them. Each one you open brings the next one up.**

## What it will not do

- **Reminders appear here, and nothing is sent by email yet.** You see them when you next open Ensemus. No other channel is used.
- It has no settings. You cannot mute a kind of line, or mark everything as opened at once.
- It has no way to delete a line.
- A line holds no content of its own. It points to the work or approval, and that page decides whether you may still see it.
- An inbox belongs to one organization. Switch organization to see the other one.

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| Page not found. This page does not exist, or you do not have access to it. | You opened a line about work you can no longer see. Being told about it once gives you no access | Ask its accountable owner, or an owner or admin |
| Please check the details and try again. | The form that opens the line could not be used | Reload **Inbox** |

If a reminder never comes, reload **Inbox**. If the approval is still waiting, you will find it under **Approvals** either way, and that list does not depend on reminders.

## What another organization can see

Nothing. Your inbox is yours alone, within one organization. Nobody else in it can read it, and neither can anyone in another organization.
