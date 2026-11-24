---
title: Secrets and key rotation
audience: operator
area: op-install
tickets: [FOUND-05]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [infrastructure/compose/compose.yaml, infrastructure/compose/postgres/10-provision.sh, infrastructure/compose/temporal/temporal-start.sh, infrastructure/scripts/generate-install-secrets.mjs, infrastructure/scripts/check-compose-secrets.mjs, infrastructure/scripts/generate-test-secrets.mjs, packages/config/src/index.ts, packages/secrets/src/broker.ts, packages/workflows/src/codec.ts, packages/auth/src/index.ts, apps/web/start.mjs, apps/web/src/server/runtime.ts, workers/workflow/src/connector-worker.ts, workers/workflow/src/main.ts, docs/00-foundation/adr/ADR-024-build-start-runtime-contracts.md, docs/00-foundation/adr/ADR-025-m1-implementation-decisions.md, docs/00-foundation/adr/ADR-026-tombstones-survive-restore.md, docs/specifications/implementation-backlog.csv, apps/web/src/server/api.ts]
tests: []
---

# Secrets and key rotation

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

This page covers the secret files used by the base stack and optional Compose profiles, including **which keys cannot be rotated safely today**.

## Do not store real provider credentials yet

The way Ensemus seals credentials is in ADR-024 D5. The backlog ticket for it, `FOUND-05`, is waiting on an outside security review, and its acceptance says that review must finish before any real credential is stored. Until then, use only generated test values for provider keys and mail passwords, against local test services.

The files on this page are the install's own keys and passwords, and you have to have them for the stack to run at all. Make them properly anyway, and treat them as secrets.

## Where they live

Every file sits in `.local/secrets`, in the repository's top folder. `compose.yaml` names these paths directly, and mounts each file at `/run/secrets` in only the containers listed for it. The `.local` folder is ignored by git, and `.dockerignore` keeps it out of the image builds.

**File permissions.** Compose mounts each file with its permissions from the host, and the containers do not run as root, so each file has to be readable by everyone (`644`), as the generator makes them. Protect the folder instead, so that only the account running Compose can open it:

```sh
chmod 700 .local/secrets
```

If a container reports that it cannot read a secret, check the mode on the mounted file.

Anyone who can run Docker on this host can read every one of these files, from the host or through a container. Limit who has that.

## Who gets what

| File | Given to | What it is | Form |
|---|---|---|---|
| `db_superuser_password` | `postgres` | The `postgres` superuser. Used only to create the database, on an empty data folder | Hex |
| `db_migrator_password`, `db_migrator_url` | `postgres`, `migrate` | Schema owner | Hex, and a URL |
| `db_app_password`, `db_app_url` | `postgres`, `web` | Tenant data through row-level security | Hex, and a URL |
| `db_agent_password`, `db_agent_url` | `postgres`, `provision-roles`, `agent-worker` | Agent worker's database login | Hex, and a URL |
| `db_worker_password`, `db_worker_url` | `postgres`, `provision-roles`, `worker`, `federation-worker` | Workflow worker's database login | Hex, and a URL |
| `db_connector_password`, `db_connector_url` | `postgres`, `provision-roles`, `connector-worker` | Connector worker's database login | Hex, and a URL |
| `db_knowledge_password`, `db_knowledge_url` | `postgres`, `provision-roles`, `knowledge-worker` | Knowledge worker's database login | Hex, and a URL |
| `db_mailer_password`, `db_mailer_url` | `provision-roles`, `mail-worker` | Mail worker's database login | Hex, and a URL |
| `db_federation_password`, `db_federation_url` | `provision-federation`, `federation-worker` | Federation worker's separate database login | Hex, and a URL |
| `mail_relay_password` | `mail-worker` | Relay password supplied by its operator | Provider-supplied text |
| `db_auth_password`, `db_auth_url` | `postgres`, `web` | Sign-in tables | Hex, and a URL |
| `db_dispatcher_password`, `db_dispatcher_url` | `postgres`, `dispatcher` | Outbox | Hex, and a URL |
| `db_secrets_password`, `db_secrets_url` | `postgres`, `worker`, `agent-worker`, `connector-worker` | The `secrets` schema | Hex, and a URL |
| `db_temporal_password` | `postgres`, `temporal`, `temporal-schema` | Temporal's database | Hex |
| `objects_access_key`, `objects_secret_key` | `migrate`, `web`, workflow and processing workers | The store's main identity, which is an administrator of the whole store | Hex |
| `objects_ledger_access_key`, `objects_ledger_secret_key` | `dispatcher` | Reaches only the `tombstone-ledger/` prefix. See [After a restore](after-a-restore.md) | Hex |
| `objects_backup_access_key`, `objects_backup_secret_key` | `pg-backup-offsite` | Can read, write and list only the backup bucket | Hex |
| `objects_identity.json` | `objects` | Lists the object-store identities and what each may do | JSON |
| `auth_secret` | `web` | Signs session cookies, and encrypts provider tokens from sign-in | 32 bytes, base64 |
| `next_server_actions_key` | `web` | Encrypts Server Action data for this deployment, in place of the key built into the image | 32 bytes, base64 |
| `temporal_codec_key` | Temporal workers and `dispatcher` | Encrypts what Temporal stores | 32 bytes, base64. Anything else stops the process |
| `sealing_public_key.pem` | `web` | Seals credentials people submit | RSA 3072, SPKI PEM |
| `sealing_private_key.pem` | `worker`, `agent-worker`, `connector-worker`, `mail-worker` | Unseals credentials | RSA 3072, PKCS8 PEM |

## Creating secrets for a new installation

From the repository root, run this with Node.js 24:

```sh
node infrastructure/scripts/generate-install-secrets.mjs
```

The command requires a new `.local/secrets` directory. It generates the database passwords and matching connection URLs, three runtime keys, the RSA sealing pair, and credentials for the main object store, tombstone ledger and optional backup bucket. It creates the directory with mode `700` and sets each file to `644` so the containers can read their own mounts. An existing directory is preserved. Keep its keys to retain access to existing encrypted data.

If you enable the optional mail profile, set `ENSEMUS_MAIL_PASSWORD_FILE` in the Compose settings to the absolute path of the relay password file. The generator supplies the mailer database credentials. The relay password comes from your relay operator.

Before starting the stack, check the mounts for the Compose files and profiles you intend to use. The same `compose` helper is defined in [Installing with Docker Compose](install-compose.md).

```sh
compose config --format json | node infrastructure/scripts/check-compose-secrets.mjs
```

For disposable trials and CI fixtures, use `node infrastructure/scripts/generate-test-secrets.mjs`. That command can fill missing fixture files and rewrites the object-store identity file.

**Use hex for your own passwords.** Percent-encode any characters that have meaning in a URL. The raw password in the password file and the decoded password in the URL must match.

## Keep a copy, away from this host

A database backup does not hold these. Losing some of them costs more than losing others:

| If you lose | What happens |
|---|---|
| `sealing_private_key.pem` | Every sealed credential can never be opened again, and has to be entered again |
| `temporal_codec_key` | Running and paused workflows can no longer be decoded |
| `auth_secret` | Everyone is signed out. Provider tokens stored from sign-in cannot be read until the next sign-in |
| Any database password | Reset it. See below |
| `objects_*` | Make new ones. See below |

Keep the copy encrypted, in a different place from your database backups. Whoever has both has everything.

## Changing them

Replacing a file does not change a running container, so each change ends by recreating what uses it. Where a change has a cost to people, the table says so.

Nothing in this section has been run. No test in this project changes any of these on a running stack, so try it on a copy first.

| File | Can you change it today | What it costs |
|---|---|---|
| Database passwords and URLs | Yes, in two places | Services restart |
| `objects_*` and the identity file | Yes | File access stops briefly |
| `auth_secret` | Yes, there is one value at a time | Everyone is signed out |
| `next_server_actions_key` | Yes, there is one value at a time | Pages already open have to be reloaded |
| `temporal_codec_key` | **No safe way today** | See below |
| Sealing key pair | **No way today** | See below |

### Database passwords

The password files are only read on an empty data folder, so changing the file does not change the database. Change the role first, then both files. `\password` prompts for the value, which keeps it out of your shell history and the process list:

```sh
compose exec postgres psql -U postgres -d postgres
```

```text
\password ensemus_app
\q
```

Then put the same value in `.local/secrets/db_app_password`, change the password in `.local/secrets/db_app_url`, and recreate what uses it:

```sh
compose up -d --no-deps --force-recreate --wait web
```

| Role | Files to change | Recreate |
|---|---|---|
| `ensemus_app` | `db_app_password`, `db_app_url` | `web` |
| `ensemus_agent` | `db_agent_password`, `db_agent_url` | `agent-worker` |
| `ensemus_worker` | `db_worker_password`, `db_worker_url` | `worker`, and `federation-worker` if enabled |
| `ensemus_connector` | `db_connector_password`, `db_connector_url` | `connector-worker` if enabled |
| `ensemus_knowledge` | `db_knowledge_password`, `db_knowledge_url` | `knowledge-worker` |
| `ensemus_mailer` | `db_mailer_password`, `db_mailer_url` | `mail-worker` if enabled |
| `ensemus_federation` | `db_federation_password`, `db_federation_url` | `federation-worker` if enabled |
| `ensemus_auth` | `db_auth_password`, `db_auth_url` | `web` |
| `ensemus_dispatcher` | `db_dispatcher_password`, `db_dispatcher_url` | `dispatcher` |
| `ensemus_secrets` | `db_secrets_password`, `db_secrets_url` | `worker`, `agent-worker`, and `connector-worker` if enabled |
| `ensemus_migrator` | `db_migrator_password`, `db_migrator_url` | Nothing. `migrate` reads it on its next run |
| `temporal` | `db_temporal_password` | `temporal`, then `worker` and `dispatcher` |
| `postgres` | `db_superuser_password` | Nothing. It is only read on an empty data folder |

**How to tell it worked:** `compose ps` shows each one healthy. A wrong value shows as `errorCode` `28P01` in that service's log.

### File storage keys

`objects` reads its identities when it starts. To change a pair, write the new values to its two key files and update the matching identity's `credentials` in `objects_identity.json`. Keep the other identities and the existing `actions`. Recreate the store first and the services that use the key after it. For example, to rotate the ledger pair:

```sh
compose up -d --no-deps --force-recreate --wait objects
compose up -d --no-deps --force-recreate --wait dispatcher
```

**How to tell it worked:** `https://localhost:8443/api/health/ready` does not cover the store, so upload a file to a work item, then download it. For the ledger pair, delete a test file, then see that the backlog stays at zero:

```sh
compose run --rm --no-deps dispatcher node dist/ledger-backlog.js
```

**Rotate the ledger pair whenever you find a forged entry,** because the same key can write another. See [After a restore](after-a-restore.md).

### `auth_secret`

The code reads one value, and there is no setting for an old one. Everyone is signed out when `web` is recreated, and has to sign in again. Their data is not touched.

```sh
openssl rand -base64 32 | tr -d '\r\n' > .local/secrets/auth_secret
compose up -d --no-deps --force-recreate --wait web
```

### `next_server_actions_key`

The same, with its own file. A page already open in a browser holds data encrypted with the old key, so its forms stop working until it is reloaded.

### `temporal_codec_key`: no safe way today

The codec holds one key and has no way to try an older one. Everything Temporal has stored under the old key, including open workflows, paused approvals and each organization's reminder schedule, becomes unreadable to the worker. **Do not replace it on a running install.** There is no re-encryption command.

If you believe it has leaked, tell your security owner. What it protects is a second layer over payloads that should hold only IDs, so a leak needs someone who can also read Temporal's database, and that database is not published.

### The sealing key pair: no way today

`SecretBroker` can hold several keys and rewrap a tenant's data keys under a new one, but nothing lets you use that. The worker is given exactly one private key, there is no setting for a second, and no command calls `rotateTenant`.

If you replace the pair, every existing sealed credential stops opening. The code answers `SECRET_UNAVAILABLE`, and each one has to be entered again. Since real credentials must not be stored yet, there should be none to lose.

This gap is listed for the project to close before the outside review.

## When something refuses

| What you see | What it means |
|---|---|
| `Refusing to start: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY_FILE is not set.` | The key file is missing or empty. It will not fall back to the key built into the image |
| `errorCode` `ConfigError` in a log | A required secret is missing, or its file is empty. The original message says which, as `Missing required secret NAME or NAME_FILE` or `NAME_FILE points to an empty file`. The web tier's logs keep only the code |
| `errorCode` `EACCES` | A container could not read a file. Check that it is `644` |
| `errorCode` `Error` as the worker starts | Often `temporal_codec_key` not decoding to 32 bytes |
| `errorCode` `28P01` | A database password is wrong. The URL and the role disagree |
| A file in the store refused with status 403 | The identity does not reach it. This is what the ledger identity should get for a customer's file |

## If a secret leaks

- **What a compromised web tier holds** is in [What you are running](overview.md). It does not hold the private key or the codec key.
- **`objects_ledger_*`:** whoever has it can refuse any tenant by writing one object, and can write entries naming files. It cannot read or delete a customer's file. Rotate it, and read [After a restore](after-a-restore.md).
- **`objects_access_key`:** it reaches every file in the store. Rotate it and tell your security owner.
- **`auth_secret`:** rotate it, which signs everyone out.
- **A database login:** change the password as above. Row-level security limits `ensemus_app` to a bound tenant, but whoever holds the login can bind any tenant.

A leak of customer data can carry duties of its own, which are for your organization to work out.
