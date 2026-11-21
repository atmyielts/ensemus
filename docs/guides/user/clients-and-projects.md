---
title: Clients and projects
audience: user
area: work
tickets: [UX-16]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/clients/page.tsx, apps/web/src/app/o/[organizationId]/work/page.tsx, apps/web/src/components/new-work-form.tsx, apps/web/src/server/work-actions.ts, packages/application/src/people.ts, packages/application/src/work.ts, packages/domain/src/policy.ts, tests/stack/product-flows.test.ts]
tests: []
---

# Clients and projects

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**Clients and projects** shows who the work is for, and how it is grouped. Everyone in the organization can see this page, and anyone can add to it.

## Add a client

Fill in **Client name**, up to 200 characters, and press **Add client**. A client is a name. It holds no contact details.

## Add a project

Fill in **Project name**, up to 200 characters. If there are clients, choose one under **Client (optional)**, or leave **No client**. Press **Add project**.

## Put work in a project

When you create work, choose the project under **Project**. It is shown when there are projects. See [Work Units](work-units.md).

A work's page shows its **Project**, with the client's name if it has one.

## See a project's work

Select a project's name. **Work** opens with **Showing work in** and the project's name. It lists only work you can see. **Show all work** goes back to everything. You can also use the **Status** filter on this list.

## What it will not do

- It has no way to rename or delete a client or a project.
- You cannot move work into or out of a project after creating it.
- A project gives nobody access to its work. Who can see work depends on its sensitivity, and on who is on it. Everyone can see that a client or project exists, and restricted work in a project stays hidden from those not on it.
- It does not total or report on a project's work.

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| Please check the details and try again. | The name is empty or too long, or the form named a client or project this organization does not have | Check the name, and reload the page |
| No work matches this filter. | No work in this project, or none that you can see | Choose **Show all work** |

## What another organization can see

Nothing. Each organization has its own clients and projects, and two organizations can each have a client of the same name without seeing the other. A form that names a client or project from another organization gets the same answer as a typing mistake.
