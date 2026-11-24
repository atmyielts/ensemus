---
title: Connecting other systems
audience: user
area: connections
tickets: [CONNECT-01, EXP-02]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/connections/page.tsx, apps/web/src/app/o/[organizationId]/connections/new-connection-form.tsx, apps/web/src/app/o/[organizationId]/connections/webhook-form.tsx, apps/web/src/server/external-action-actions.ts, apps/web/src/server/api.ts, apps/web/src/lib/messages.ts, packages/application/src/connections.ts, packages/connectors/src/email/index.ts, packages/workflows/src/external-action-activities.ts, docs/00-foundation/adr/ADR-027-verified-external-actions.md]
tests: [tests/integration/business-connectors.test.ts, tests/stack/business-connection-setup.test.ts, tests/browser/specs/business-connection-setup.spec.ts]
---

# Connecting other systems

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

> **Before you enter a real credential.** This part of Ensemus has not had its outside security review. Until your operator tells you it has, use made-up values and a test mail server only.

A connection is how Ensemus reaches a system outside itself. It belongs to one organization, and it has a name people choose it by.

## What you can connect

| Kind | What it lets you do |
|---|---|
| **Email through your mail server** | Send an email that someone has approved. See [Sending email from Ensemus](sending-email.md) |
| **A signed callback from your own systems** | Let one of your systems ask Ensemus for something. See [Webhooks](webhooks.md) |

Google Workspace and Microsoft 365 also have their own consent forms. On a BYOM or Sovereign installation, an operator can offer CRM, ticketing and accounting adapters. Only configured business adapters appear; a Cloud deployment does not offer them until tenant routing is qualified.

## Who can do this

Organization owners and admins can open **Connections**, add a connection and revoke one. To get there, open **Administration**, then **Connections**.

Members use **My connections** for their own supported Google or Microsoft account. Company connection management remains limited to owners and admins. They can still choose an email connection when they propose an email, and they see its name and the address it sends as.

## Add a connection

If your operator has not turned connectors on, the page says: "Connectors are not turned on for this deployment, so nothing here can send or receive anything. An operator turns them on. Nothing is being simulated in the meantime." You will not see **Add a connection** until they do.

1. On **Connections**, go to **Add a connection**.
2. Under **Kind**, choose what you are connecting.
3. Under **Name**, give it a name people will recognize, such as the team or the purpose.
4. For email, fill in **For email**, using the table below. For a signed callback, leave that group empty.
5. Choose **Add connection**.

You will see: "Connection added. Any credential you gave is sealed, and cannot be read back."

| Field | What to put | Needed? |
|---|---|---|
| **Sends as** | The one address this connection may send from, such as `billing@example.invalid`. Nobody proposing an email can change it | Yes, for email |
| **Sender name** | The name recipients see beside that address | No |
| **Name on your mail server's certificate** | The name on your mail server's certificate. Ensemus checks the certificate against it | See below |
| **Credential** | The password for your mail server. Ensemus logs in with the **Sends as** address as the user name | Yes, for email. A signed callback must not have one |

**Fill in the certificate name.** The page calls it optional, but a deployment that requires encryption, which is what it does unless your operator has said otherwise, cannot send through a connection without it. Every email through that connection ends as **Not sent**, with "Nothing on this deployment was able to pick it up."

There is no field for your mail server's address. Your operator sets the one server this deployment may connect to, and nobody in an organization can name another.

## Add a business connection

When your operator has configured an adapter, its **Connect CRM (adapter)**, **Connect Ticketing (adapter)** or **Connect Accounting (adapter)** section appears. These forms configure that installation's adapter; they do not connect to a vendor by name or choose a network destination.

1. If asked, choose **Verify your identity to set up this connection**. Administrative MFA and SSO follow your company's existing security policy.
2. Open **Set up connection** and enter a name.
3. Under **Records to import**, select the record groups to retain. With none selected, the connector imports nothing and makes no source read.
4. Leave **Allow proposals for reviewed changes** clear for a read-only connection. Selecting it raises the local permission ceiling; the source must independently allow each request, and every proposed change still needs approval. Accounting can create drafts and edit notes, without paying or transferring money.
5. Enter the **Adapter certificate name** supplied by your operator and the **Credential**, then choose **Add connection**.

The credential is sealed and never returned. If validation refuses the form, the safe choices stay selected, the disclosure stays open and you must enter the credential again. With JavaScript enabled, safe choices can also survive a step-up round trip in the same account and tab; credentials never enter that draft store. Reloading or signing out clears those memory-only drafts.

Creation records the configuration and queues the existing background sync. It does not prove source connectivity or import permissions. Selected records appear under **Source records** only after a successful sync and source-ACL mapping. Company administration alone grants no access to their contents. **Active** means the connection is enabled, not that a provider test succeeded.

## What the list shows

Each connection shows its name, its kind and its state.

| On the screen | What it means |
|---|---|
| **Active** | It can be used |
| **Disabled** | It cannot be used. Nothing on this page sets this or clears it |
| **Revoked** | It has been closed for good |
| "A credential is on file." | Ensemus holds a sealed credential for it. Nobody can read it back, including you |
| "No credential is on file." | This kind needs one, and it has none, so it cannot send |
| "It needs no credential." | This kind has no use for one |
| "The last problem, with code" and a code | Something went wrong the last time it was used. Only people who can open this page see it |

A connection cannot be edited. To change its address or its credential, add a new connection and revoke the old one.

## Revoke a connection

1. On **Connections**, choose **Revoke** beside the connection.
2. Read what it says: "Anything not yet attempted will not go out through it, and any work asking for its receipt will need another connection."
3. Choose **Revoke for good**.

From that moment:

- An email that has not been tried yet will not go. It ends as **Cancelled, so not sent**, with "The connection it would go through is no longer active."
- An email already handed to your mail server is not called back. Revoking says nothing about what happened to it.
- Every callback address on that connection closes, and answers as if it never existed.
- The sealed credential is then revoked as well.

This cannot be undone. The connection stays on the list as **Revoked**, so you can see it existed.

## When it refuses

| What you see | What it means | What to do |
|---|---|---|
| **Page not found** | You are not an owner or admin of this organization, or the address is not one of its pages | Ask an owner or admin |
| "You do not have permission to do that." | Your role does not let you manage connections | Ask an owner or admin |
| "This connector is not available on this deployment." | Connectors are off, so no connection can be added | Ask your operator |
| "Please check the details and try again." | Something in the form did not fit. For email, **Sends as** and **Credential** are both needed. For a signed callback, a credential is refused. The certificate name has to be a plain host name | Fix the field, and type the credential again, because it is never put back in the form |
| "This connection is not active." | It has been revoked | Add a new one |
| "Someone else changed this first. Check the latest version and try again." | Someone revoked it while you had the page open | Reload the page |

## What others can see

- **Another organization** cannot see your connections, their names, their credentials or their callbacks. Asking for one of yours gets the same answer as asking for something that does not exist.
- **Members of your organization** see the name and the sending address of an email connection when they propose an email. They do not see the credential or the last problem.
- **Whoever approves an email** sees the address it will go from.
- **Nobody** can read a credential back: not you, an owner, or anyone using the product.
