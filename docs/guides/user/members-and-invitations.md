---
title: Inviting people
audience: user
area: start
tickets: [ID-02]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/people/page.tsx, apps/web/src/app/invite/[token]/page.tsx, apps/web/src/components/invite-form.tsx, apps/web/src/server/work-actions.ts, apps/web/src/lib/messages.ts, packages/application/src/people.ts, packages/domain/src/policy.ts, tests/stack/product-flows.test.ts]
tests: []
---

# Inviting people

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Owners and admins can invite people to their organization. Everyone else does not see the **Invitations** section.

## Invite someone

1. Open **People and teams**, and go to **Invitations**.
2. Under **Invite someone**, fill in **Email address**.
3. Choose **Access**: **Member** or **Admin**.
4. Press **Create invitation**.
5. Copy the **Invitation link**, and send it privately yourself.

The form shows the link once. Copy it before you leave or reload the page. You can share it privately in chat. If your installation has mail enabled, Ensemus can also send the invitation by email.

The link works once, for the email address you invited. It expires in 7 days, or as soon as you lose the right to invite people.

## Accept an invitation

1. Open the link. You see **You have been invited**. The page shows no organization or role until you accept, because anyone holding the link could read them.
2. Use the address your inviter entered. Sign in if you have an account. Otherwise, choose **Create an account** and enter your name, the invited address, and a password. The invitation form can create your account on an installation that has public sign-up disabled.
3. Press **Accept invitation**.

If your address has already been proven, you join and the organization opens. If it has not, you see **Waiting for confirmation**, and someone in the organization has to confirm you.

If you are signed in with the wrong account, choose **Use a different account**.

## Confirm someone who is asking to join

Someone who holds a link and has an account with the invited address has not proven the address is theirs. So they wait.

1. The person who invited them sees **Someone is asking to join, and needs confirming** in their **Inbox**. Their invitation says **Asking to join** on **People and teams**.
2. Check with that person directly. Any owner or admin can confirm.
3. Press **Confirm**, tick the box, and press **Confirm** again. The box names their address and says: "Someone holding this link signed in with this address, but nothing has proven the address is theirs. Only confirm if you have checked with them."

Once confirmed, the person selects **Ensemus** at the top of their page, and their organization opens, or is listed if they have several. The invitation link itself has been used, so it no longer works.

## See and withdraw invitations

Each invitation shows its address, its access and one state. Those no longer open are under **Past invitations**.

| State | What it means |
|---|---|
| **Waiting** | Sent, and not used. **Withdraw** cancels it |
| **Asking to join** | Someone used it, and needs confirming. **Confirm** or **Withdraw** |
| **Accepted** | They joined. Withdrawing cannot undo this. See [People and teams](people-and-teams.md) to disable someone |
| **Withdrawn** | Someone withdrew it, or the person who sent it lost the right to invite |
| **Expired** | The 7 days ran out |

## What it will not do

- An invitation cannot make someone an owner. An owner can change their access afterwards on **People and teams**.
- It cannot bring a disabled member back. A disabled member stays disabled, and a new invitation does not change that.
- It gives only the organization it was made in. It gives nothing in any other organization.
- A link cannot be shown again, because only a scrambled copy of it is kept.

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| This invitation is not valid. Ask for a new one. | The link is used, withdrawn, expired or guessed, or it was sent to a different address. The person who sent it may have lost the right to invite, or you may be disabled in this organization. The answer is the same for all of these, so a link tells a stranger nothing | Check you are signed in with the invited address. If you are, ask for a new invitation |
| You do not have permission to do that. | Your role cannot invite, withdraw or confirm | Ask an owner or admin |
| Please check the details and try again. | The email address was not usable, or the box was not ticked when confirming | Fix it, and press the button again |
| Page not found. This page does not exist, or you do not have access to it. | The link is damaged, or you are not in that organization yet. Waiting for confirmation does not give you access | Ask for the link again, or ask them to confirm you |

## What another organization can see

An invitation's link, address and state are visible only to the owners and admins of its own organization. Nobody in another organization can see it. Someone invited to a second organization keeps what they have in the first, and neither organization sees the other's work.
