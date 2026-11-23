---
title: Getting support
audience: user
area: admin
tickets: [OPS-22]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/lib/messages.ts, apps/web/src/app/error.tsx, apps/web/src/app/not-found.tsx, apps/web/src/app/restoring/route.ts, docs/00-foundation/adr/ADR-036-release-readiness.md, packages/application/src/saas/support.ts, packages/sovereign/src/diagnostics.ts]
tests: []
---

# Getting support

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

This guide names no address and no hours. Your agreement or whoever runs your deployment gives you those. Ensemus has no support page, no ticket form and no published coverage hours yet, so you cannot ask for help from inside the product.

## Who to ask

| Your question | Ask |
|---|---|
| Your access, your role or an invitation | An owner or admin of your organization |
| Anything else, on Ensemus Cloud or Ensemus with your own models | The contact your agreement names |
| Anything else, on Ensemus Sovereign | Whoever runs your deployment. They reach the supplier as your agreement says |

## What to send

- What you were doing, and which page you were on.
- The exact words on the screen.
- The reference, if you see one. The **Something went wrong** page may say "give your administrator this reference", followed by a short code. That code lets someone find the error in the server's logs.
- Roughly when it happened.

Do not send a password, an API key, a setup code or an invitation link. Nobody helping you should ask for one. Share your organization's content only as far as your agreement and your own policy allow.

## Messages you can act on yourself

| What you see | What it means | What to do |
|---|---|---|
| You do not have permission to do that. | Your role does not allow this. | Ask an owner or admin of your organization. |
| Not found, or you do not have access. | It does not exist, or you cannot see it. Both get the same answer. | Ask someone who can see it to check. |
| **Page not found** | The same, for a whole page. | Check the address, then ask an owner or admin. |
| Someone else changed this first. Check the latest version and try again. | Another person saved a change before you. | Reload the page, read it again, then redo your change. |
| Something went wrong on our side. Please try again. | The request failed for a reason you cannot fix. | Try again. If it keeps happening, send what is listed above. |
| **This organization is being restored** | Your administrator is restoring it from a backup. | Try again later, or ask your administrator how it is going. |

## What it cannot do

- **It states no response time.** Anything promised about that is in your agreement.
- **It cannot look into your organization for you.** The product has no feature that lets support staff open your organization's content. This page does not describe what the host of a deployment can reach outside the product. Your agreement covers that.
- **It cannot send diagnostics.** There is no diagnostics export yet.

## Where modes differ

On Ensemus Sovereign, your organization runs the deployment, so its operator is your first contact. If your maintenance has lapsed, that changes your support status only, and the product keeps working. See [Your license and maintenance](sovereign-license-status.md).

On Ensemus Cloud and Ensemus with your own models, Ensemus hosts the service, and your agreement says how to reach support.
