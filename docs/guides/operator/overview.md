---
title: What you are running
audience: operator
area: op-install
tickets: [PLAT-12]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [infrastructure/compose/compose.yaml, infrastructure/compose/postgres/provision.sql, infrastructure/compose/proxy/Caddyfile, infrastructure/containers/Dockerfile.web, infrastructure/containers/Dockerfile.worker, apps/web/src/server/runtime.ts, apps/web/src/app/page.tsx, apps/web/start.mjs, workers/workflow/src/main.ts, workers/workflow/src/dispatcher.ts, workers/workflow/src/connector-worker.ts, tests/stack/platform.test.ts, docs/00-foundation/adr/ADR-024-build-start-runtime-contracts.md, docs/00-foundation/adr/ADR-025-m1-implementation-decisions.md, docs/00-foundation/adr/ADR-026-tombstones-survive-restore.md, docs/05-operations/05-container-deployment-runbook.md, m3-verified-actions:infrastructure/compose/compose.yaml]
tests: []
---

# What you are running

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Ensemus runs as a set of containers. The same two images, `web` and `worker`, run in all three commercial modes. The mode is a setting, not a different build. This page says what each part does and which boundaries you are relying on, so you can tell when one has been broken.

## Before you store anything real

ADR-024 says the database roles and the secret-sealing design need an outside security review before any real credential is stored. That review has not happened. Until it has, use generated test values and local test services, and do not put a real provider key, mail password or customer data into a deployment.

Nothing here has had an outside audit or penetration test. The boundaries below are what the code and the stack tests intend. Check them yourself on your own install, using the commands at the end of this page.

## The parts

These are the services in `infrastructure/compose/compose.yaml`.

| Service | What it does | Runs |
|---|---|---|
| `proxy` | Caddy. Ends TLS and passes requests to `web`. It holds the only published port | All the time |
| `web` | The Next.js server: every page, the public API and sign-in | All the time |
| `worker` | Polls Temporal, and runs workflow steps and upkeep | All the time |
| `dispatcher` | Takes events from the outbox in PostgreSQL and hands them to Temporal. Also writes the tombstone ledger | All the time |
| `migrate` | Applies database migrations and creates the storage bucket, then exits | Once per `up` |
| `postgres` | PostgreSQL with pgvector. Holds Ensemus and, in separate databases, Temporal | All the time |
| `temporal-schema` | Creates or updates Temporal's own tables, then exits | Once per `up` |
| `temporal` | The Temporal server, which owns durable workflow state | All the time |
| `temporal-namespace` | Creates the `default` namespace if it is not there, then exits | Once per `up` |
| `valkey` | A cache with nothing saved to disk. It runs and is health-checked, and no code connects to it yet | All the time |
| `objects` | SeaweedFS, as S3-compatible file storage | All the time |

The `connectors` profile adds `connector-worker` and `egress-gateway`. That profile is on the branch `m3-verified-actions` and is off unless you turn it on. See [The connector worker](connector-worker.md).

## The networks

| Network | Who is on it | Why |
|---|---|---|
| `edge` | `proxy`, `web` | Requests reach the web tier |
| `data` | `web`, `worker`, `dispatcher`, `migrate`, `postgres`, `valkey`, `objects` | PostgreSQL and file storage |
| `temporal` | `worker`, `dispatcher`, `temporal`, `temporal-namespace` | Workflows. **`web` is not on it** |
| `temporal-db` | `postgres`, `temporal`, `temporal-schema` | Temporal's own database |

Internal names are pinned to fixed addresses under `ENSEMUS_NETWORK_PREFIX`, which is `172.30` unless you change it. Without the pins, Docker would send the name of a stopped container to your site's resolver, and internal names would leave the network during an outage.

## What the web tier cannot do

The web tier is the largest thing exposed to the outside, so it is built to hold as little as possible.

**It has no path to Temporal.** It shares no network with Temporal, has no pinned name for it, and its image holds no Temporal code. When someone starts or approves work, the web tier writes to PostgreSQL in one transaction, and the dispatcher passes that on. If Temporal is down, people can still save work, and the events wait in the outbox.

**It cannot unseal secrets.** It holds only the public half of the sealing key, so it can lock a credential that someone submits and cannot open one. It has no private key, no database login for the `secrets` schema and no Temporal codec key. Only the connector worker holds the private key.

**What it does hold.** A compromised web process would have the `ensemus_app` and `ensemus_auth` database logins, `auth_secret`, the Server Action key and the main file storage key, which can reach the whole bucket. ADR-025 is plain about this: the split between the two database logins protects against a query bug, and not against code running inside the web tier.

## Database roles are narrow

No role has `SUPERUSER`, `CREATEROLE` or `BYPASSRLS`, and that is set in `infrastructure/compose/postgres/provision.sql`. Tenant tables use row-level security, so a query that is not bound to an organization sees no tenant rows.

| Role | Used by | Reaches |
|---|---|---|
| `ensemus_migrator` | `migrate`, and the setup code command | Owns the schema. Nothing that stays running uses it |
| `ensemus_app` | `web`, `worker`, the re-apply command, the connector worker | Tenant tables through row-level security. Not the `secrets` schema |
| `ensemus_auth` | `web`, for sign-in | The `identity` schema only |
| `ensemus_dispatcher` | `dispatcher`, the redrive and backlog commands | Outbox state and event metadata across tenants. No event payloads, and no work tables |
| `ensemus_secrets` | The connector worker | The `secrets` schema only |
| `temporal` | `temporal`, `temporal-schema` | Temporal's two databases only |

The `postgres` superuser is for provisioning, and for the backup and restore commands you run yourself. Never give it to a service. Other milestones add roles, and [Upgrading a release](upgrade.md) says what that asks of you.

## Other things to rely on, and to keep true

- **Only the proxy publishes a port.** Publishing a container port makes Docker accept traffic to it from other networks, which quietly undoes the network separation above. Do not publish PostgreSQL, Temporal or the store.
- **Do not use `compose.test.yaml` on a real install.** It publishes those ports, turns sign-up on and adds a test identity provider.
- **Only IDs cross Temporal.** Workflow inputs and results hold identifiers, outcomes and counters. Content stays in PostgreSQL and file storage. A codec also encrypts what Temporal stores, as a second layer.
- **`web` and `worker` run as a non-root user on a read-only filesystem.** `web` also refuses to start without a Server Action key for this deployment.
- **Secrets arrive at runtime as mounted files.** The image builds use none. See [Secrets and key rotation](secrets.md).
- **Logs hold codes and identifiers, not content.** That also means an error can be just a code. A bad setting shows up in the `web` log as `ConfigError`, with no name attached.

## What the mode changes

Set `ENSEMUS_MODE` to `cloud`, `byom` or `sovereign`. The setup page tells each new organization owner who is responsible, under the heading `Who is responsible for your data`, and the organization records the mode it was created in.

| Mode | The page calls it | Who runs it |
|---|---|---|
| `cloud` | `Ensemus Cloud` | Ensemus hosts it and supplies the approved model providers |
| `byom` | `Ensemus with your own models` | Ensemus hosts it, and the customer brings providers and keys. The page says this does not keep data from Ensemus |
| `sovereign` | `Ensemus Sovereign` | The customer runs it on infrastructure they control, and is responsible for operating, securing and backing it up |

If you leave `ENSEMUS_MODE` unset, `compose.yaml` uses `sovereign`. Choose before the first owner signs in, because the statement they read is the one in force at that moment.

## Check these on your own install

Run these after installing. `compose` is the helper from [Installing with Docker Compose](install-compose.md).

The web tier holds the public key and no private key. This lists `sealing_public_key.pem`, and nothing with `private` in its name, no `temporal_codec_key` and no `db_secrets_url`:

```sh
compose exec -T web ls /run/secrets
```

The web tier cannot connect to Temporal. This prints `blocked`. If you changed `ENSEMUS_NETWORK_PREFIX`, change the address to match:

```sh
compose exec -T web node -e "const s=require('net').connect({host:'172.30.3.10',port:7233,timeout:3000});s.on('connect',()=>{console.log('connected');s.destroy()});s.on('timeout',()=>{console.log('blocked');s.destroy()});s.on('error',()=>console.log('blocked'))"
```

The same command against `worker` prints `connected`. That is the control: without it, `blocked` could only mean the address was wrong.

The web tier's database login cannot read sealed secrets. This prints `42501`, PostgreSQL's code for permission denied:

```sh
compose exec -T web node -e "const {Client}=require('/app/node_modules/.pnpm/node_modules/pg');const c=new Client({connectionString:require('fs').readFileSync('/run/secrets/db_app_url','utf8').trim()});c.connect().then(()=>c.query('select * from secrets.sealed_secrets')).then(()=>console.log('read'),e=>console.log(e.code)).finally(()=>c.end())"
```

Only the proxy publishes a port. This lists `proxy` and nothing else:

```sh
compose ps --format '{{.Service}} {{.Publishers}}'
```

If any of these answers differently, stop and treat it as a security problem, not a setup problem. Find out what changed the configuration before you let anyone in. `tests/stack/platform.test.ts` holds the same checks, for the project's own test runs.

## Where to go next

- [Installing with Docker Compose](install-compose.md)
- [Configuration reference](configuration.md)
- [Backup and restore](backup-and-restore.md)
- [Upgrading a release](upgrade.md)
