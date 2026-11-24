---
title: Sent, failed and unknown
audience: user
area: connections
tickets: [CONNECT-06]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/components/receipt-words.tsx, apps/web/src/components/receipt-list.tsx, apps/web/src/components/resolve-form.tsx, apps/web/src/app/o/[organizationId]/external-actions/page.tsx, apps/web/src/app/o/[organizationId]/external-actions/[externalActionId]/page.tsx, apps/web/src/app/o/[organizationId]/inbox/page.tsx, apps/web/src/server/external-action-actions.ts, apps/web/src/lib/messages.ts, packages/application/src/receipts.ts, packages/application/src/external-actions.ts, packages/domain/src/external-action.ts, packages/connectors/src/email/index.ts, tests/browser/specs/external-actions.spec.ts, docs/00-foundation/adr/ADR-027-verified-external-actions.md]
tests: []
---

# Sent, failed and unknown

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Ensemus tells you how an email ended in one of three ways, and they are not shades of one another. **It went. It did not go. Nobody knows.** Ensemus would rather tell you it does not know than guess.

| On the screen | What it means | What to do |
|---|---|---|
| **Sent** | Your mail server accepted it | Nothing |
| **Sent: confirmed by** a person | That person looked and said it went. It rests on their word, and not on your mail server | Nothing |
| **Not sent** | It did not go | Ask for it again if you still want it to go |
| **Not sent: confirmed by** a person | That person looked and said it did not go. It rests on their word | Ask for it again if you still want it to go |
| **We don't know whether this was sent** | Nobody can say. It may have gone, and it may not have | Read the next section |
| **Cancelled, so not sent** | It stopped before it could go, and it never will | Propose a new email if you still want it to go |

## We don't know whether this was sent

**This means nobody knows.** Not Ensemus, and not your mail server's answer, because that answer never came. It is not a failure and it is not a success. It may have reached everyone, and it may have reached no one.

It happens when the message had already been handed to your mail server and the conversation broke before the server said it had taken it: the server stopped answering, the connection dropped, or Ensemus was interrupted. A mail server has no way to be asked about it afterwards, so Ensemus cannot find out by itself.

**What Ensemus does:** it stops. It will not try again by itself, however long this waits, because trying again could send it twice. It tells the accountable owner of the work and whoever proposed the email, in their inbox: "We don't know whether something was sent, and it needs you to look".

**What you do:** someone has to go and look.

1. Open the action, from your inbox or from **Needs a decision** at the top of **External actions**.
2. Find the **Message-ID** on its page. It looks like `<id@mail.example.invalid>`. If the page says "The Message-ID starts with:", search for that part. It is enough to find it.
3. Search your mail server's log for it, or ask whoever runs your mail server to.
4. Under **Say what you found**, choose **It went: I found it** or **It did not go: it is not there**.
5. Under **How do you know?**, say what you checked. This is required, and it cannot be changed afterwards.
6. Choose **Record what I found**.

### Saying what you found never sends anything

The form says so: "This records your word and sends nothing." That is true of both answers.

- **If you say it went,** it shows **Sent: confirmed by** you. Nothing is sent.
- **If you say it did not go,** it shows **Not sent: confirmed by** you. Nothing is sent. If you still want it to go, that is a separate step, under **Ask for it again**, and it needs a new approval, even if the same person approved it a minute ago.

### If you cannot find out

**Leave it.** It can wait as long as it needs to, and nothing goes out while it does. Do not choose an answer to clear it.

Choosing **It did not go** and asking again, when the first one did go, sends the message twice. Ensemus cannot stop that, because it is relying on your word. The record will show who decided and why.

### After you have answered

- Your name and your reason are on the page. People who can read this work can read them, and they cannot be changed.
- The receipt reads "On the word of" your name, ", who looked". It never reads as your mail server's word.
- Others who were asked about it stop being asked.
- If the work asks for a receipt, **It went** counts towards it, and the page shows that it rests on your word. See [Evidence and completion](evidence-and-completion.md).

### If your mail server answers late

An answer that arrives after the wait is believed, because it is your mail server's own word. If nobody has answered yet, the status moves to **Sent** or **Not sent** by itself, and nothing is sent. If someone has already answered, their answer stays what the status says, and your mail server's word is added under **Receipts**, so anyone can see the two disagree.

### Who can answer

The accountable owner of the work, and organization owners and admins who can see it. Someone only assigned to the work can read all of this, and sees: "The accountable owner of this work or an organization admin says what they found." Nobody else is asked.

## Not sent

The page says why. When Ensemus or your mail server is the one saying so, nothing went. When it shows **confirmed by** a person, it rests on what they found.

| What the page says | What to do |
|---|---|
| "Ensemus could not connect to your mail server." | Ask your operator whether it is reachable, then ask again |
| "Ensemus could not reach your mail server after several tries." | The same. Ensemus has already waited and tried again by itself |
| "Your mail server stopped answering before the message was handed over." | Ask again. The message had not been handed over, so it did not go |
| "Your mail server was too busy to take it." | Ask again later |
| "Your mail server did not offer an encrypted connection, so nothing was sent." | Tell your operator. Ensemus will not send in the clear unless they set it to |
| "Your mail server did not accept the credential." | An owner or admin adds a new connection with the right credential, and revokes the old one |
| "The credential for your mail server could not be opened." | Tell your operator |
| "Nothing on this deployment was able to pick it up." | Tell your operator. Also check that the connection has its certificate name, as [Connecting other systems](connections.md) says |
| "Your mail server refused it." | Your mail server said no. Ask whoever runs it why |
| "Your mail server refused a recipient." | Check the addresses. Propose a new email if one was wrong, because asking again uses the same words |
| "What was stored no longer matched what was approved, so it was stopped." | Tell your operator. Propose a new email if it is still needed |

### Ask for it again

1. On the action's page, go to **Ask for it again**.
2. Under **Who approves it this time?**, choose someone other than you.
3. Choose **Ask for approval**.

"This makes a new action with the same words, and it needs its own approval. Nothing goes until someone gives it." The new one links back with **See the action this asks for again**. It uses the connection's current sending address. Only one can be open at a time, because two would be two emails.

## Cancelled, so not sent

"This was not sent, and it never will be." It cannot be asked for again. To send it, propose a new email from the work.

| What the page says | Why |
|---|---|
| "The person asked to approve it said no." | They denied it |
| "Nobody sent it before its approval ran out, so it will not go late." | The approval ran out first |
| "Its approval no longer covered exactly this." | The approval was closed, for example because the person asked lost access to the work |
| "Someone changed what would be sent, so this version was replaced." | There is a newer version, which the page links to |
| "The work it belongs to was stopped." | The work finished or was stopped first |
| "The connection it would go through is no longer active." | The connection was revoked first |
| "What was stored no longer matched what was approved, so it was stopped." | Tell your operator |

## Receipts

**Receipts** on the action's page lists everything recorded about it, and on whose word.

| On the screen | Whose word it is |
|---|---|
| "On your mail server’s word" | Your mail server answered at the time |
| "On your mail server’s word, when asked afterwards" | What is known once the answer was lost. Read the line under it |
| "On the word of" a person ", who looked" | A person, not your mail server |
| "On Ensemus’s own record, because nothing was sent" | Ensemus knows it never got that far |

On an unknown email, the second line appears beside "Your mail server has no way to say whether it took a message." That is the whole of what it says: your mail server gave no answer about this message.

It also says how many times Ensemus tried. "Ensemus has tried 3 times, and every earlier try definitely did not go." "No receipt yet, because nobody has said what happened." means exactly that.

## When it refuses

| What you see | What it means | What to do |
|---|---|---|
| "Only an action in an unknown state can be resolved." | It is no longer waiting, because someone else answered or your mail server did | Reload the page and read what it says now |
| "Only an action that was not sent can be asked for again." | It is not **Not sent**, or an earlier ask for it again is still open or went through | Look at the newer action it links to |
| "You do not have permission to do that." | You can read this work, and you cannot answer for it | Ask its accountable owner or an organization admin |
| "Please give a reason." | **How do you know?** was empty | Say what you checked |
| "Someone else changed this first. Check the latest version and try again." | It changed while you had the page open | Reload the page |
| "This connection is not active." | The connection was revoked, so **Ask for it again** is no longer offered | Propose a new email through another connection |
| **Page not found**, or "Not found, or you do not have access." | You cannot read the work this belongs to, or it does not exist | Ask the work's owner |

## What others can see

- **Your organization:** the whole of an action, including who answered and why, is visible to people who can read its work. **External actions** lists only those. **Needs a decision** lists only what you can answer.
- **Restricted work:** an email cannot be proposed from it, so it never reaches this page.
- **Another organization:** nothing. Its people get not found, by any page or by the API, and these actions do not appear in their lists.
