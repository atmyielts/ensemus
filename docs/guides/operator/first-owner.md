---
title: The first owner and setup token
audience: operator
area: op-install
tickets: [ID-01]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [workers/workflow/src/setup-token.ts, workers/workflow/src/migrate.ts, packages/database/src/setup-token.ts, packages/database/src/deployment.ts, packages/database/src/organizations.ts, packages/auth/src/index.ts, apps/web/src/app/setup/page.tsx, apps/web/src/app/sign-in/page.tsx, apps/web/src/app/page.tsx, apps/web/src/app/invite/[token]/page.tsx, packages/application/src/people.ts, packages/config/src/index.ts, tests/stack/first-owner.test.ts, docs/05-operations/05-container-deployment-runbook.md]
tests: []
---

# The first owner and setup token

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Sign-up is off by default (`ENSEMUS_ALLOW_SIGNUP` is `false`), so a new install has no way for anyone to get an account until you make one possible. You do that by issuing a setup code. The page calls it a setup code, and the database calls it a setup token.

## Step 1: Issue a code

The stack has to be up and migrated. `compose` is the helper from [Installing with Docker Compose](install-compose.md).

```sh
compose run --rm --no-deps -T migrate node dist/setup-token.js
```

**Success looks like this,** with a real code and date in place of these:

```text
Setup code, for one new account, until 2026-01-01T00:00:00.000Z:

AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

Give it to the person setting up, by a private route. They open /setup on this deployment and
enter it there with their name, email and a password. This code is not stored and cannot be
shown again. Run this command again if it is lost or runs out.
```

The code is 43 characters. It goes to this terminal and nowhere else. Only a hash of it is stored, and it is never logged, so if you lose it, run the command again.

**If it fails,** it prints a line holding `setup_token.failed` with an `errorCode` and exits 1. It usually means `postgres` is not running, or a database login is wrong.

## Step 2: Hand it over

Give the code to the first owner by a private route. It works **once**, for **one** account, for **24 hours**. The time is set in the code, not by a setting.

## Step 3: They set up their account

They open `/setup` on your deployment, such as `https://localhost:8443/setup`. They can also get there from the sign-in page, through `Given a setup code? Use it here`. The page asks for `Setup code`, `Name`, `Email` and `Password`, and the button says `Create account`. The password has to be at least 12 characters.

The code goes in the form, and never in an address, so it stays out of browser history and proxy logs.

## Step 4: They create the organization

They are signed in and land on `Set up your organization`. Under `Who is responsible for your data`, the page states who is responsible in this deployment's mode, and it comes from `ENSEMUS_MODE`:

| Mode | The page says this deployment is |
|---|---|
| `cloud` | `Ensemus Cloud` |
| `byom` | `Ensemus with your own models` |
| `sovereign` | `Ensemus Sovereign` |

**Check this says what you intend.** If it names the wrong mode, stop and fix `ENSEMUS_MODE`, because the organization records the mode it was created in.

They enter a name and choose `Create organization`. They become its `Owner`, and can invite people.

For a fresh dedicated installation, set `ENSEMUS_TENANCY_TIER=dedicated` and `ENSEMUS_DEDICATED_ORGANIZATION_ID` to the chosen UUID in the Compose settings before running migrations. Keep public sign-up off while you set it up. The first owner creates the organization with that UUID. Give later coworkers an invitation to join it.

## How to tell it worked

- They reach their organization's home page.
- This prints how many codes are still usable, and no codes:

```sh
compose exec -T postgres psql -U postgres -d ensemus -c "select count(*) from identity.setup_tokens where used_at is null and expires_at > now()"
```

## When it refuses

| What they see | What it means | What to do |
|---|---|---|
| `That setup code does not work. It may have been used already, or run out. Ask whoever runs this deployment for a new one.` | The code was wrong, used or out of time. The message is the same for all three, on purpose, so that nobody can test whether a guess was close | Issue a new one |
| `We could not create that account, and your setup code still works. Check your details, and use a password of at least 12 characters.` | The password was too short or too long, or that email already has an account. The code was given back | Try again with the same code |
| `/sign-up` answers 404 | Sign-up is off. This is the default | Use a code |
| The API answers 400 with `EMAIL_PASSWORD_SIGN_UP_DISABLED` | Someone tried to sign up directly while it is off. No account was made | Nothing |

## What a code does not do

- **It makes an account and nothing more.** It gives no access to any existing organization. Someone with a new account sees only what they create. Another organization on this deployment answers them with 404, the same as one that does not exist.
- **It cannot be withdrawn.** There is no command to cancel a code before its time is up. If one leaks, the cost is an unwanted, empty account. Anyone who could reach `/setup` could use it during those 24 hours.
- **It is not a way to reset a password or recover an account.** It always makes a new account.

## Letting more people in

**Share a workspace invitation.** Create the invitation on the organization's People and teams page, then share the link privately. The recipient can create an account and accept the invitation from that link while public sign-up is off. They still enter the address you invited. If their address is unverified, an owner or admin confirms them and they can then choose **Check access** from the invitation page. See [Inviting people](../user/members-and-invitations.md).

**Connect an identity provider.** See [Connecting an identity provider](identity-providers.md), which also says what is not finished.

## Turning sign-up on

Set `ENSEMUS_ALLOW_SIGNUP=true` only if anyone who can reach this deployment should be able to create an account and an organization of their own. Their organizations are isolated from yours, and joining yours still takes an invitation. The limit is 5 sign-ups a minute for each client address, which relies on the setting in [Configuration reference](configuration.md) for `ENSEMUS_TRUSTED_PROXIES`.

Then recreate the web tier, and the sign-in page shows `New here? Create an account`:

```sh
compose up -d --no-deps --force-recreate --wait web
```

## Modes

The steps are the same in all three. Who runs them differs: in Sovereign, the customer's operator. For the hosted services, see [Provisioning and suspension](provisioning-and-suspension.md).
