---
title: People and teams
audience: user
area: start
tickets: [UX-15]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/people/page.tsx, apps/web/src/components/confirm-form.tsx, apps/web/src/server/work-actions.ts, apps/web/src/lib/messages.ts, packages/application/src/people.ts, packages/application/src/work.ts, packages/domain/src/policy.ts, tests/stack/product-flows.test.ts]
tests: []
---

# People and teams

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**People and teams** shows who is here, and how they are organized.

## Who can do what

| | Member | Admin | Owner |
|---|---|---|---|
| See names, access and who is active | Yes | Yes | Yes |
| See email addresses | Only their own | Yes | Yes |
| Create work, clients and projects | Yes | Yes | Yes |
| Invite people | No | Yes | Yes |
| Change access and disable people | No | Not owners | Yes |
| Make someone an owner | No | No | Yes |
| Manage teams | No | Yes | Yes |
| Choose a new owner for restricted work nobody can reach | No | No | Yes |

## Members

Each member shows their name, **Active** or **Disabled**, and their access. If you cannot manage them, you see their access as text. An admin looking at an owner sees **and only an owner can change this**. An organization with one owner shows **the only owner**, and that owner cannot be changed or disabled until there is another.

### Change someone's access

Choose **Owner**, **Admin** or **Member** next to their name, and press **Save**. An admin is not offered **Owner**.

Moving someone to **Member** withdraws the invitations they made. Any review they can no longer see closes.

### Disable someone

1. Press **Disable** next to their name.
2. Tick the box. It says they lose access on their next click, the invitations they made stop working, and open reviews they were asked for close.
3. Press **Disable** again.

It takes effect on their next click. There is no button to bring them back, and a new invitation does not do it.

## Work whose owner was disabled

This appears for owners and admins when there is such work. It says **This work needs someone new to answer for it.**

- Work you can see is listed by title. Open it and use **Hand over to**.
- **Restricted work** you cannot see appears only to organization owners, with no title. Press **Choose a new owner**, choose under **New owner**, tick the box, and press **Make them the owner**.

Choosing a new owner this way shows you nothing about the work, and you still cannot open it unless you chose yourself. It goes in the audit log, and any other owners are told.

## Teams

Owners and admins can create and arrange teams.

- To create one, fill in **Team name**, choose **Part of (optional)** if it sits inside another team, and press **Create team**.
- To add someone, use **Add to** and the team's name, then press **Add**.
- To take someone off, press **Remove** next to their name.
- To move a team, use **Move** and the team's name, choose a team or **No parent team**, and press **Move**.

Everyone sees which teams there are, how they nest, and how many people each has. Who is on a team is shown only to the people on it, and to owners and admins.

## What it will not do

- **A team gives no access to work.** Access comes from a work's sensitivity, and from being its owner or on it. See [Work Units](work-units.md).
- It has no way to rename or delete a team. Members can be removed from it.
- You are not offered **Disable** next to your own name.
- An organization always keeps at least one active owner.

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| An organization must keep at least one owner. | This would leave no active owner | Make someone else an owner first |
| You do not have permission to do that. | Your role cannot do this. An admin cannot change an owner, for example | Ask an owner |
| A team cannot sit inside itself or inside one of its own teams. Choose a different parent. | This would make a loop of teams | Choose a different parent |
| Please check the details and try again. | The box was not ticked, the name is empty or too long, or the person is disabled or is not in this organization | Check the form, and try again |
| Not found, or you do not have access. | That person or team no longer exists here, or is not in this organization | Reload the page |

## What another organization can see

Nothing here. Members, teams and invitations are visible only inside their own organization. A form that names a person or a team from another organization is refused with one of the messages above, and the answer is the same whether or not they exist.
