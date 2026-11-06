---
title: Webhooks
audience: user
area: connections
tickets: [CONNECT-02]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [m3-verified-actions:apps/web/src/app/api/webhooks/[token]/route.ts, m3-verified-actions:apps/web/src/lib/webhook-limiter.ts, m3-verified-actions:apps/web/src/app/o/[organizationId]/connections/page.tsx, m3-verified-actions:apps/web/src/app/o/[organizationId]/connections/webhook-form.tsx, m3-verified-actions:apps/web/src/server/external-action-actions.ts, m3-verified-actions:apps/web/src/server/api.ts, m3-verified-actions:packages/application/src/webhooks.ts, m3-verified-actions:packages/application/src/receipts.ts, m3-verified-actions:packages/connectors/src/inbound/index.ts, m3-verified-actions:packages/connectors/src/runtime/webhook-signature.ts, m3-verified-actions:packages/contracts/src/external-actions.ts, m3-verified-actions:packages/domain/src/webhook.ts, m3-verified-actions:packages/database/src/schema-integrations.ts, m3-verified-actions:packages/workflows/src/webhook-activities.ts, m3-verified-actions:docs/00-foundation/adr/ADR-027-verified-external-actions.md]
tests: []
---

# Webhooks

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

A webhook here is a signed request from one of your own systems to Ensemus, which Ensemus calls a callback. It goes one way: Ensemus does not call your systems.

**A callback can only ask.** An email it proposes still waits for a person to approve it, and nothing is sent because a callback arrived.

## Make a callback address

You need to be an organization owner or admin, and your operator has to have turned connectors on.

1. On **Connections**, add a connection of the kind **A signed callback from your own systems**. It needs no credential. See [Connecting other systems](connections.md).
2. Beside it, choose **Make a callback address**.
3. Copy the **Callback address** and the **Signing secret**.

"These are shown once, so copy them now and keep them private." Ensemus keeps only a hash of the address and a sealed copy of the secret, so nobody can show them to you again. If you lose them, make a new address.

Treat the address as a secret too. Anyone holding it can send requests that use up its limits, even though they cannot sign them.

## Sign a request

Send a `POST` to the callback address, with these headers.

| Header | What goes in it |
|---|---|
| `x-ensemus-timestamp` | The time now, in whole seconds since 1970 |
| `x-ensemus-event-id` | Your own ID for this event: up to 255 letters, digits, `_`, `:` or `-`. A dot is not allowed |
| `x-ensemus-signature` | The signature, as 64 lower-case hexadecimal characters |
| `content-type` | `application/json` |

The signature is HMAC with SHA-256. The key is the signing secret, as its text. What you sign is the timestamp, a dot, the event ID, a dot, and the exact bytes of the body:

```text
{timestamp}.{event id}.{body}
```

The scheme's name, `ensemus_hmac_sha256_v1`, is shown beside the secret when you make the address.

## What to send

The body is JSON, in one of two forms. Anything else is refused.

To propose an email:

```json
{
  "type": "external_action.proposed",
  "work_unit_id": "00000000-0000-4000-8000-000000000001",
  "connection_id": "00000000-0000-4000-8000-000000000002",
  "email": {
    "to": ["client@example.invalid"],
    "subject": "Your order has shipped",
    "text_body": "It left the warehouse this morning."
  }
}
```

`email` can also hold `cc`, `bcc` and `reply_to`. Its limits are the ones on [Sending email from Ensemus](sending-email.md). The work and the connection both have to be in your organization, and the connection has to be an active email connection. A piece of work's ID is in its page's address. A connection's ID comes from the list of connections in the [public API](public-api.md), because no page shows it.

The email appears on **External actions** as **Waiting for approval**, and the person asked to approve it is the work's accountable owner. The sending address comes from the connection, and nothing in the body can set it.

To ask for a sync:

```json
{ "type": "connector.sync_requested" }
```

Today's connections do not read from anywhere, so this has no effect you will see.

## What you hear back

Every answer has an empty body.

| Answer | What it means | What your system should do |
|---|---|---|
| `202` | Stored. **It does not mean the signature was good** | Nothing |
| `404` | Not an open address, or connectors are off | Check the address. Do not keep sending |
| `413` | The body is too large. The limit is 256 KiB | Send less |
| `429` | Too many requests. The limit is 120 a minute for each address, and there are limits on bytes as well | Wait for the time in `Retry-After`, then send again |
| `503` | Not now | Wait for the time in `Retry-After`, then send again |

A request with a bad signature hears the same `202` as a good one, so nobody learns anything from the answer. That means your system cannot tell from here whether it is signing correctly.

## See how it went

**Recent callbacks** on **Connections** is the only place that shows whether a signature passed. It lists the last 20, and shows no content.

| On the screen | What it means |
|---|---|
| **Waiting to be checked** | It has been stored, and nothing has looked at it yet |
| **Signature good, and acted on** | It was verified and did what it asked |
| **Signature good, and already seen** | That event ID was already used on this address, so it did nothing |
| **Refused** | It did nothing, for the reason below it |
| **Could not be processed** | Something went wrong while handling it |

| Reason under **Refused** | What to do |
|---|---|
| "The signature did not match." | Check the secret, and that you sign the exact bytes you send |
| "It had no signature." | Add `x-ensemus-signature` |
| "It had no time on it." | Add `x-ensemus-timestamp`, as whole seconds |
| "Its time was too far from now, as an old request replayed would be." | The time has to be within five minutes of its arrival. Check your system's clock |
| "The signature was good, and the body was not something Ensemus understands." | Check the body against the forms above. This also covers a body the rules refused: work or a connection that is not in your organization, restricted work, finished work, or work that already has an open approval |
| "The address had been turned off." | The connection was revoked before it was checked |
| "Ensemus could not open the signing secret, which is not the sender’s fault." | Tell your operator |
| "Nothing checked it in time, so it was dropped." | Nothing looked at it within 24 hours. Tell your operator, and send it again |

Bodies are dropped once a callback has been dealt with. What is left of the record goes after about a week.

## Replays and repeats

- **The same bytes again** are stored once, and hear `202`.
- **A new request with an event ID already used** ends as **Signature good, and already seen**. Your event ID is what makes a retry safe, so use the same one when you retry an event.
- **A valid request sent again later** is refused once its time is more than five minutes from when it arrived.

A worker being down does not turn a good callback into an old one: the time is measured against when the request arrived, not when it was checked.

## If the address or the secret gets out

Nothing on the page closes one address, or replaces a secret. **Making a new address does not close the old one.** The only way to close an address is to revoke its connection, which closes every address on that connection:

1. Add a new connection of the same kind, and make an address on it.
2. Move your system over to the new address and secret.
3. Revoke the old connection.

## When it refuses

| What you see | What it means | What to do |
|---|---|---|
| No **Make a callback address** button | Connectors are off, the connection is not active, or it is an email connection | Check the connection's kind and state |
| "You do not have permission to do that." | Only owners and admins can make an address | Ask one of them |
| "This connection is not active." | It was revoked | Add a new one |
| "This connector is not available on this deployment." | Connectors are off | Ask your operator |

## What others can see

- **Another organization** can do nothing with your address, and sees nothing of what arrives. A callback on your address that names their work or their connection does nothing, however well it is signed, and it shows as refused on your page. It tells you nothing about what they hold.
- **A stranger** with no secret hears the same answer for every signature, and an address that is not open answers the same as one that never existed.
- **Your organization:** only owners and admins can see **Recent callbacks**.
