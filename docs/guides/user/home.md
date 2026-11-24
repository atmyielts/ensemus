---
title: Your Home page
audience: user
area: start
tickets: [UX-12]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/page.tsx, apps/web/src/lib/work-view.ts, apps/web/src/components/ui.tsx, packages/application/src/work.ts, packages/application/src/approvals.ts, packages/domain/src/work-unit.ts, tests/stack/pages.test.ts]
tests: []
---

# Your Home page

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**Home** shows what needs you first, and then what you are on. It says **Hello** and your first name, and **What needs you, and what is moving.** Press **New work** to start something. See [Work Units](work-units.md).

## What you will see

### Waiting for your approval

Each approval waiting for your decision, with the work's title and **Expires** and a date. Select one to decide it. This section appears only when something is waiting. See [Approvals](approvals.md).

### Needs attention

Work you own or are on that is **Blocked** or **Failed**, or whose due date has passed. Each line says **You own this** or **You are on this**, and **Was due** with the date if it is late. Work due today is not late until that day is over, in UTC.

This section appears only when it has something in it. If it says **There is more than this**, choose **See all your work**.

### Your work

The rest of your open work, soonest due first, with work that has no due date last. Each line shows **You own this** or **You are on this**, the due date if there is one, and the status.

| You see | What it means |
|---|---|
| You are not on any open work. Start by describing the outcome you want. | You own nothing open and are on nothing open. **Describe an outcome** starts some |
| Everything you are on is listed above. | All of it is under **Needs attention** |
| These are the most urgent. | There is more. **See all work** shows it |
| The most urgent are listed above, and there is more. | The same, when everything shown is under **Needs attention** |

## What it will not do

- It shows only work you own or are on. Other work you are allowed to see is under **Work**.
- It does not show **Done** or **Stopped** work. Find those under **Work**, with the **Status** filter.
- It does not show anyone else's trouble, even if you are an owner or admin of the organization.
- It does not change by itself. Reload it to see what is new. Only the page of a piece of work follows changes live. See [Live status and reconnecting](live-status.md).

## When it refuses

Home itself refuses nothing. A line can lead somewhere that does.

| You see | What it means | What to do |
|---|---|---|
| Page not found. This page does not exist, or you do not have access to it. | You lost access to that work, or to the organization, since the page was loaded | Reload **Home**, or ask an owner or admin |

## What another organization can see

Nothing on this page. Your **Home** in one organization lists only that organization's work and approvals, and another organization cannot see it.
