---
title: Connecting an identity provider
audience: operator
area: op-install
tickets: [ID-03]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/server/runtime.ts, packages/auth/src/index.ts, apps/web/src/app/sign-in/page.tsx, infrastructure/compose/compose.yaml, infrastructure/compose/compose.test.yaml, tests/integration/auth.test.ts, docs/00-foundation/adr/ADR-024-build-start-runtime-contracts.md, docs/00-foundation/adr/ADR-025-m1-implementation-decisions.md, docs/05-operations/05-container-deployment-runbook.md, packages/auth/src/sso.ts, docs/06-delivery/m7-slices.md]
tests: []
---

# Connecting an identity provider

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Ensemus has its own accounts, with email and password, built into the web tier. No identity provider is needed. It can also use one provider over OIDC. **That is only partly finished today, so read the next section before you plan around it.**

## What works and what does not

| Thing | State |
|---|---|
| Local accounts | Work, and need nothing on this page |
| The OIDC sign-in flow, with PKCE | The code is there. A test does a full round trip against a mock provider, through the library, without going through the deployed stack |
| A button for it on the sign-in page | **Not there.** `Sign in to Ensemus` shows the email and password form only. Nothing a person can click starts OIDC |
| Compose passing the settings to `web` | **Not there.** `compose.yaml` does not name them, so setting them in your settings file does nothing. Step 3 adds them |
| More than one provider | Not possible. The code has one, named `company-sso` |
| SAML, multi-factor sign-in, one provider per organization | Not in this tree. These are being written on the M7 branches, and `m7-foundation` holds only the outline |
| Removing someone when your provider removes them | Not in this tree either |

So you can connect a provider today and check the flow, but people cannot use it from the page until a button exists. This has been reported to the project.

## How it behaves

- **Anyone your provider lets in gets an Ensemus account,** even with `ENSEMUS_ALLOW_SIGNUP=false`. That setting closes email and password sign-up only. So limit who can use this client at your provider.
- **An account gives access to nothing but itself.** Someone with a new account can see no organization until they are invited, and can create one of their own.
- **It asks for** the `openid`, `email` and `profile` scopes, using the authorization-code flow with PKCE.
- **Provider tokens** are encrypted using `auth_secret` before they are stored.
- **Sessions** last 7 days, and renew once a day while in use. This is set in the code, not by a setting.
- **Not tested:** what happens when a provider's address matches an existing password account. Try that on a test install before you rely on either answer.

## Step 1: Register a client at your provider

Use the authorization-code flow. The redirect address is your `ENSEMUS_PUBLIC_URL`, followed by a fixed path:

```text
https://ensemus.example.invalid:8443/api/auth/callback/company-sso
```

Have your provider send an email claim. Note the client ID, the client secret and the provider's discovery address, which normally ends in `/.well-known/openid-configuration`.

While the review in [Secrets and key rotation](secrets.md) is outstanding, use a test client on a test provider, and not a real one.

## Step 2: Put the client details in files

```sh
printf '%s' 'the client id' > .local/secrets/oidc_client_id
printf '%s' 'the client secret' > .local/secrets/oidc_client_secret
chmod 644 .local/secrets/oidc_client_id .local/secrets/oidc_client_secret
```

The first command leaves the value in your shell history if your shell keeps one, so clear that afterwards, or write the files with an editor.

## Step 3: Pass them to the web tier

`compose.yaml` does not carry these, so add a small file of your own at `.local/compose.oidc.yaml`. Paths in it are relative to `infrastructure/compose`, not to this file:

```yaml
services:
  web:
    environment:
      ENSEMUS_OIDC_DISCOVERY_URL: https://idp.example.invalid/.well-known/openid-configuration
      ENSEMUS_OIDC_CLIENT_ID_FILE: /run/secrets/oidc_client_id
      ENSEMUS_OIDC_CLIENT_SECRET_FILE: /run/secrets/oidc_client_secret
    secrets:
      - oidc_client_id
      - oidc_client_secret

secrets:
  oidc_client_id: { file: ../../.local/secrets/oidc_client_id }
  oidc_client_secret: { file: ../../.local/secrets/oidc_client_secret }
```

Then change your `compose` helper so that **every** command from now on uses it. Otherwise the next `up` removes the settings again:

```sh
compose() { docker compose --env-file .local/ensemus.env -f infrastructure/compose/compose.yaml -f .local/compose.oidc.yaml "$@"; }
compose up -d --no-deps --force-recreate --wait web
```

## Step 4: Check the flow starts

There is no button, so ask the sign-in route directly. Use your own public address for both the URL and the `origin`:

```sh
curl --cacert ensemus-root.crt -s -X POST https://localhost:8443/api/auth/sign-in/social \
  -H 'content-type: application/json' -H 'origin: https://localhost:8443' \
  -d '{"provider":"company-sso","callbackURL":"/"}'
```

**Success:** a JSON answer with a `url` at your provider, holding `code_challenge=`. Opening that address should take you to your provider's sign-in, and after that back to the path in Step 1.

This reads the provider's discovery address, so `web` has to be able to reach it.

## When it refuses

| What you see | What it means | What to do |
|---|---|---|
| Every page fails, and the `web` log has `errorCode` `ConfigError` | `ENSEMUS_OIDC_DISCOVERY_URL` is set, and a client ID or secret is missing or empty. The web tier builds everything together, so this stops all of it, **including password sign-in** | Fix the files, or remove the override |
| Status 403 from Step 4 | The `origin` is not your `ENSEMUS_PUBLIC_URL` | Make them match |
| An error about an unknown provider from Step 4 | `web` did not get the settings | Check Step 3, and run `compose exec -T web ls /run/secrets` |
| Your provider says the redirect address is wrong | The address registered in Step 1 is not exact | Compare them, including the port |
| An error after coming back from your provider | Look in the `web` log for `auth.error` and its `errorCode`. The log leaves out addresses and SQL on purpose | Check that your provider sends an email claim |

## An outside connection

An identity provider means the web tier connects to something outside the stack. The project's outbound gate runs with no provider configured, so that traffic is not part of what it counts. On a Sovereign site, the provider has to be on your own network, and your site's firewall decides what `web` can reach. See [Outbound traffic](outbound-traffic.md).

## Turning it off

Go back to the helper with no override, then recreate `web`. People who signed in through the provider keep their accounts and organizations, and have no password, so they cannot sign in until it is connected again or you give them another way in.

```sh
compose() { docker compose --env-file .local/ensemus.env -f infrastructure/compose/compose.yaml "$@"; }
compose up -d --no-deps --force-recreate --wait web
```

## For tests only

`compose.test.yaml` has an `oidc-mock` service under the `test-oidc` profile, with the client ID `ensemus` and a made-up user. It takes anyone, and is for the project's own tests. Never connect it to anything real.
