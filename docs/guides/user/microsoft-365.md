---
title: Microsoft 365
audience: user
area: connections
tickets: [CONNECT-05, CONNECT-07, CONNECT-09]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [packages/domain/src/workspace-suites.ts, apps/web/src/server/oauth-actions.ts, apps/web/src/app/o/[organizationId]/connections/page.tsx, apps/web/src/app/o/[organizationId]/settings/connections/page.tsx]
tests: []
---

# Microsoft 365

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

This guide describes the current implementation. Consent and provider wire formats still need acceptance with a provider test tenant; local checks do not establish that your account is connected.

## Connect company files and groups

An owner or admin opens **Connections**, then **Connect Google Workspace or Microsoft 365**, and chooses **Microsoft 365**. Name the connection and select **Read files**, **Read groups**, or both. Expand **Exactly what Microsoft 365 will ask you to allow** to review the requested scopes.

Choose Ensemus's configured app or your own app. Your own app requires its client details and the callback address shown in the form. Continue to the provider's consent page. Ensemus does not ask for your provider password. Finish within ten minutes; an expired or denied attempt does not create a connection. The page shows **Finishing** until the worker completes the exchange, and **Connected** only after it succeeds.

Files remain limited to people who can open them at the provider. Directory groups are mirrored as teams, and are controlled by sync rather than manual membership edits. Revoking the connection ends its use; a provider membership change is reflected on the next successful sync.

## Connect your own account for assistant tools

Open your personal **Connections** settings. The organization decides which capabilities people may connect. Select only the mail, calendar, document or chat capabilities you need and finish the provider's consent. Available capabilities vary by provider and configuration; an unavailable capability cannot be granted by changing a form value.

Assistant reads use the initiating person's access. An external change requires review of its exact payload and records a receipt or an explicit uncertain result. If the result is uncertain, check the provider before trying again; an uncertain send is not safe to repeat automatically.

An owner or admin can revoke company or member connections from **Connections**. A revoked connection cannot be resumed; its owner must connect again.
