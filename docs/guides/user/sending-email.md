---
title: Sending email from Ensemus
audience: user
area: connections
tickets: [WORK-08]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/components/new-email-form.tsx, apps/web/src/components/new-work-form.tsx, apps/web/src/components/receipt-email.tsx, apps/web/src/components/receipt-words.tsx, apps/web/src/app/o/[organizationId]/work/[workUnitId]/page.tsx, apps/web/src/app/o/[organizationId]/external-actions/[externalActionId]/page.tsx, apps/web/src/app/o/[organizationId]/approvals/[approvalId]/page.tsx, apps/web/src/server/external-action-actions.ts, apps/web/src/lib/messages.ts, packages/application/src/external-actions.ts, packages/application/src/approvals.ts, packages/domain/src/external-action.ts, packages/contracts/src/external-actions.ts, packages/connectors/src/email/index.ts]
tests: []
---

# Sending email from Ensemus

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

An email from Ensemus always belongs to a piece of work, and it always needs someone else to approve exactly what it says. Nothing goes until they do. Once it goes, it cannot be taken back.

## Propose an email

You need to be involved in the work, or be an organization owner or admin who can see it. Your organization needs an email connection. See [Connecting other systems](connections.md).

1. Open the piece of work, and go to **Emails from this work**.
2. Choose **Propose an email**.
3. Fill in the form.
4. Under **Who approves it?**, choose someone other than you who can see this work.
5. Choose **Ask for approval**.

The action's own page opens, showing **Waiting for approval**. You can reach it again from **External actions** in the main navigation.

| Field | What to put |
|---|---|
| **Send through** | Which connection it goes through. Each one shows the address it sends as |
| **To** | One or more whole email addresses, separated by commas |
| **Copy to** | Optional |
| **Blind copy to** | Optional. The other recipients do not see these, and your approver does |
| **Replies go to** | Optional |
| **Subject** | Up to 200 characters, on one line |
| **Message** | Plain text, up to 200,000 characters. It is sent exactly as written |

To, copy and blind copy can hold 50 addresses between them. An email cannot carry an attachment or formatting. The sender is not a field: it comes from the connection when you propose it, and it is written into what your approver agrees to.

## What the approver sees

The person you chose finds it under **Approvals** and in their inbox. No approval request or reminder goes by email. They see **The exact email**, blind copies included.

- **Approve:** "Ensemus then sends exactly this, once, through your mail server."
- **Deny:** "It is not sent, and it will not be without a new approval."

The approval stays open for 72 hours. If nobody decides by then, it closes and the email will not go. An approval also runs out on one that has been approved and has not gone yet, and the email ends with "Nobody sent it before its approval ran out, so it will not go late."

Work has one open approval at a time, so a second email on the same work has to wait until the first is decided.

## Follow what happens

| On the screen | What it means |
|---|---|
| **Waiting for approval** | Nothing has been sent |
| **Approved, not sent yet** | It goes out as soon as Ensemus can reach your mail server |
| **Sending now** | Ensemus is handing it to your mail server |
| **Checking what happened** | Your mail server did not answer, and Ensemus is working out what is known. Nothing is sent again while it does |
| **Sent** | Your mail server accepted it |
| **Not sent** | It did not go |
| **We don't know whether this was sent** | Nobody can say. It waits for a person |
| **Cancelled, so not sent** | It stopped before it could go, and it never will |

[Sent, failed and unknown](sent-failed-unknown.md) says what to do about each of the last four, and it matters most for **We don't know whether this was sent**.

Ensemus tries again by itself only when it is sure the last try did not go, and it gives up after five tries. Once a message may have reached your mail server, Ensemus does not send it again.

**Sent does not mean it reached an inbox.** It means your mail server took it. What happens after that is outside what Ensemus can see.

## Change it before it goes

While nothing has been tried, you can change what would be sent, even if it is already approved.

1. On the action's page, under **Exactly what this covers**, open **Change what would be sent**.
2. Make your changes, and choose who approves it.
3. Choose **Replace it and ask again**.

"This closes the current version and its approval, even if it was already approved, and asks for a new one." The old version shows **Cancelled, so not sent**, and the new one links back to it with **See the version this replaced**. The approval never carries over.

## Work that needs a receipt

When you create work, you can tick **The outside system confirms it happened** as what proves it done. It is offered only if your organization has an active email connection.

"This counts an email below once your mail server has accepted it, or once someone who answers for this work has looked and said it went. That second case rests on their word, and the email shows it." An email with **We don't know whether this was sent** does not count. See [Evidence and completion](evidence-and-completion.md).

## When it refuses

| What you see | What it means | What to do |
|---|---|---|
| "Sending email is not turned on for this deployment." | Your operator has not turned connectors on | Ask your operator |
| "Restricted work cannot be sent outside this deployment." | Nothing leaves from restricted work, and no role changes that | Nothing here will send it. Whether the message belongs on other work is for your organization to decide |
| "This organization has no connection that can send email." | There is no active email connection | An owner or admin adds one under **Connections** |
| "An email needs someone else to approve it, and nobody else who can see this work is able to." | You are the only person who could see it, and you cannot approve your own | Add someone to the work |
| "You cannot approve your own request." | You chose yourself | Choose someone else |
| "A review of this work is already open. It has to be decided first." | This work already has an open approval | Wait for that decision, or ask the person to make it |
| "Check these addresses. Each one needs to be a whole email address." | An address could not be read, or there are more than 50 | Fix the field. What you typed is kept |
| "Please check the details and try again." | Something else in the form did not fit | Check each field |
| "This connection is not active." | The connection was revoked | Choose another, or ask an owner or admin |
| "This can no longer be changed, because Ensemus has already tried to send it." | The change came too late | See where it ended up, on [Sent, failed and unknown](sent-failed-unknown.md) |
| "That cannot be done while the work is in this status." | The work has finished or stopped | Nothing more can go from it |
| "This approval is assigned to someone else." | Only the person named can decide it | Ask them |
| "Not found, or you do not have access." | You cannot see this work | Ask its owner |

## What others can see

- **Recipients** see the sender, **To**, **Copy to**, **Replies go to**, the subject and the message. They do not see **Blind copy to**.
- **Everyone who can read the work** can read the whole email on its page, blind copies included, and every receipt. Write it with that in mind.
- **Someone who cannot read the work** gets not found, and the email does not appear in their list.
- **Another organization** sees nothing of it, by any page or by the API.

## Where the email goes

Ensemus hands every email to the one mail server your operator has set for this deployment, and nobody in an organization can name another. On a Sovereign deployment, your operator makes that a mail server on your site. What your mail server does next is up to it.
