---
title: Incident runbooks
audience: operator
area: op-run
tickets: [OPS-06, OPS-23]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [docs/05-operations/01-slos-and-reliability.md, docs/05-operations/02-deployment-and-recovery.md, docs/05-operations/05-container-deployment-runbook.md, workers/workflow/src/redrive.ts, workers/workflow/src/ledger-backlog.ts, workers/workflow/src/reapply-command.ts, workers/workflow/src/dispatch-errors.ts, packages/database/src/dispatcher.ts, packages/workflows/src/codec.ts, packages/workflows/src/workflows.ts, packages/secrets/src/broker.ts, packages/auth/src/index.ts, apps/web/src/server/runtime.ts, apps/web/src/server/tenant.ts, infrastructure/compose/compose.yaml, infrastructure/compose/temporal/setup-namespace.sh, docs/05-operations/05-container-deployment-runbook.md, workers/workflow/src/connector-worker.ts, workers/workflow/src/egress-gateway.ts, packages/workflows/src/external-action-step.ts, workers/workflow/src/ops-incident.ts, docs/06-delivery/m8-slices.md]
tests: []
---

# Incident runbooks

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

These are the steps the code supports today. **No drill has been run from them.** This page makes no statement about response times, who is on call, or how long anything takes. Those are the owner's to decide, and no service level is stated here. <!-- not-a-claim -->

The incident commands, the public status page and the named incident roles are stubs on a branch, so none of them can be used yet. So write down who is doing what yourself, in whatever you use.

In the commands below, `compose` means `docker compose -f infrastructure/compose/compose.yaml`, with `--profile connectors` added if you run the connector services.

## First five things

1. See what is up: `compose ps`.
2. Read what stopped: `compose logs --since 15m web worker dispatcher`. Logs hold codes and IDs, and no content. See [observability](observability.md) for what each event means.
3. Ask whether the web tier can reach its database: `curl -k https://localhost:8443/api/health/ready`.
4. **If you do not trust what is being sent, stop the connector worker now.** It is reversible, and it stops anything further leaving: `compose stop connector-worker`. A send under way when it stops may have gone, and that action ends `unknown`, for a person to resolve. An action no worker picks up within an hour ends failed, having reached nobody.
5. Write down the time, and what you did. Keep what you take from logs out of public places, because it holds IDs.

## PostgreSQL down or under pressure

**You will see:** `/api/health/ready` answering 503, `health.not_ready`, `web` unhealthy, `dispatcher.poll_failed`.

```sh
compose ps postgres
compose logs --tail 50 postgres
compose exec postgres pg_isready -h 127.0.0.1 -U postgres -d ensemus
compose exec postgres psql -U postgres -d ensemus -c \
  "select usename, state, count(*) from pg_stat_activity group by 1, 2 order by 3 desc"
compose exec postgres psql -U postgres -d ensemus -c \
  "select pid, usename, state, now() - xact_start as open_for from pg_stat_activity
   where xact_start is not null order by xact_start limit 10"
```

Those two show roles and states. They leave out the query text on purpose, because a query can hold customer data.

- **Reversible step:** stop what adds load, starting with `worker`, with `compose stop worker`. Temporal holds its runs, and nothing is lost. The web tier stays up.
- **Fallback:** if the database cannot be saved, see [backup and restore](backup-and-restore.md). Do not start a restore without reading it, because the order matters.
- **What waits:** work Activities retry through an outage shorter than a day. Past that, runs report failure honestly.
- **Afterwards:** `/api/health/ready` says `ready`, and no `dead` events are left, as below.

## Temporal down, or a backlog

**You will see:** `dispatcher.delivery_failed` with an outage code, plans not moving, while people can still use pages.

```sh
compose ps temporal
compose logs --tail 50 temporal
compose run --rm --no-deps --entrypoint temporal -e TEMPORAL_ADDRESS=passthrough:///temporal:7233 \
  temporal-namespace operator cluster health
compose run --rm --no-deps --entrypoint temporal -e TEMPORAL_ADDRESS=passthrough:///temporal:7233 \
  temporal-namespace task-queue describe --task-queue ensemus-platform --namespace default
```

- **No pollers:** the worker for that queue is down. `compose up -d worker`.
- **Temporal itself is down:** `compose up -d temporal`. Events wait and lose no attempts, and they go out when it returns. Do nothing to the outbox.
- **Fallback:** ordinary reading and editing keep working. Do not delete Temporal's data to make it start: paused approvals live in those runs.
- **Afterwards:** events are moving, and a plan run moves when you open one.

## Dead events in the outbox

**You will see:** `dispatcher.delivery_problem`, and a `dead` row here:

```sh
compose exec postgres psql -U postgres -d ensemus -c \
  "select state, count(*) from platform.outbox_events group by 1"
```

An event goes dead when it is at fault itself, or after about a day of gRPC `UNKNOWN` or `INTERNAL`. Work out why from the `errorCode` values first. Then put them back:

```sh
compose exec dispatcher node dist/redrive.js [organization-id]
```

**Success:** `outbox.redriven` with a `count`, and the dead count goes to zero and stays there. If it comes back, the cause is still there, so stop redriving.

## Object store down

**You will see:** uploads and downloads failing, `tombstone_ledger.backlog` growing, `restore_gate.check_failed`, `blobs.purge_failed`.

```sh
compose ps objects
compose logs --tail 50 objects
compose run --rm --no-deps dispatcher node dist/ledger-backlog.js
```

- **What waits:** deletions wait for the ledger, and lose no attempts. Byte deletions are tried again, and wait longer each time.
- **The risk:** a deletion not yet in the ledger is one a restore could not put back. So do not restore a database during this if you can avoid it.
- **Afterwards:** `queued` and `dead` go to zero.

## A tenant refused with no restore behind it

**You will see:** `restore_gate.closed` with an `organizationId`, a page saying the organization is being restored, and the API answering 503 `RESTORE_PENDING`.

If nobody restored anything, this is what a forged ledger entry looks like from outside. **Do not confirm the entry, because that destroys a live file.** Run the re-apply with no options, with `compose run --rm --no-deps worker node dist/reapply-ledger.js`. It logs what it will not act on as `tombstone_ledger.entry_unconfirmed`. Then follow [after a restore](after-a-restore.md) for `--quarantine`. Then treat `objects_ledger_*` as stolen, as below, and tell whoever owns security at your site.

## Mail relay unreachable, or many `unknown` actions

**You will see:** `egress_gateway.target_unreachable`, and actions failing or going `unknown`. This one is the relay and not Ensemus, so say so when you tell people.

- Stop the worker if you want nothing further attempted: `compose stop connector-worker`.
- Check the relay, and the route to it.
- Do not change an `unknown` action's row by hand. People resolve those on the page, from the relay's log. See [the connector worker](connector-worker.md).

**Afterwards:** check that each `unknown` action has someone looking at it, because nothing tells an operator.

## Webhook poison events and rate storms

The delivery row says what happened, and the table in [the connector worker](connector-worker.md) says what to do. A poison event ends as `MALFORMED_PAYLOAD`, and is not retried, so it cannot loop. For a leaked endpoint address, make a new endpoint, move the sender, and disable the old one.

For sign-in refusals across everyone, the usual cause is your own proxy in front, with `ENSEMUS_TRUSTED_PROXIES` empty, so that everyone shares one allowance. See [configuration](configuration.md). Any allowance clears within its minute.

## Sign-in broken by identity settings

**You will see:** `auth.error` or `auth.warning` with a code, and people unable to sign in with their company account.

- Check `ENSEMUS_OIDC_DISCOVERY_URL`, the client ID and the client secret against [identity providers](identity-providers.md). `ENSEMUS_PUBLIC_URL` has to be what people use, with no trailing slash.
- A missing client ID or secret is a config error, which shows in the log as `ConfigError`, without saying which.
- **Fallback:** if the provider is the problem, a setup code makes a local account: `compose run --rm --no-deps migrate node dist/setup-token.js`. It creates an account and gives no access to any organization by itself.

## A credential you think is stolen

There is no rotate command, and these steps have not been exercised. Work out what it reaches first:

| Secret | Held by | What it opens |
|---|---|---|
| `db_app_url` | `web`, `worker`, `connector-worker` | Tenant data, one tenant at a time, as the application role |
| `db_auth_url` | `web` | Identity tables |
| `db_dispatcher_url` | `dispatcher` | The outbox, with no content |
| `db_secrets_url` | `worker`, `connector-worker` | Sealed secrets, which still need the private key |
| `sealing_private_key.pem` | `worker`, `connector-worker` | Opens what the secrets role reads |
| `temporal_codec_key` | `worker`, `dispatcher`, `connector-worker` | Temporal payloads |
| `objects_*` | `web`, `worker`, `migrate` | Customer bytes |
| `objects_ledger_*` | `dispatcher` | The tombstone ledger prefix |
| `objects_identity` | `objects` | Every object store identity |
| `db_migrator_url` | `migrate` | Owns every table |
| `db_superuser_password` | `postgres` | Everything in the database |
| `auth_secret`, `next_server_actions_key` | `web` | Sessions and action encryption |

1. Stop sends: `compose stop connector-worker`.
2. For a database password, change the role's password with `ALTER ROLE` as the superuser, update the matching `*_url` secret file, and restart the services that hold it.
3. For an object store key, change its identity in `objects_identity`, update the secret files, and restart.
4. **Do not simply replace `temporal_codec_key` or `sealing_private_key.pem`.** The codec takes one key, so open runs could no longer read their history. The connector worker is given one sealing key, so secrets sealed under the old one could no longer be opened, and webhooks show `SECRET_UNAVAILABLE`. Neither has a working rotation path yet, so stop, and take it to whoever owns security at your site.
5. Then read the audit trail and the logs for what the credential did.

See [secrets](secrets.md). A connector credential is a customer's, so tell its owner.

## Model provider outage

No model calls happen in this stack yet, so there is nothing to run here.

## Telling people

Nothing in the product does this today. There is no status page, and no notification reaches people about an incident. Say what is affected, what still works, and what you do not know yet. Say plainly when the cause is a relay or provider, not Ensemus. Anything promised about timing is for the agreement. Sovereign sites run this themselves, and the vendor is not told unless they choose to.

## After any incident

- `compose ps` shows everything `healthy`.
- `dead` is zero in `platform.outbox_events`, and `ledger-backlog.js` is back to zero.
- Each `unknown` action has someone on it.
- A person can create work, approve it and see it finish.
- If you stopped the connector worker, decide on purpose whether to start it again.
- If you restored anything, you followed [after a restore](after-a-restore.md).

## When these steps will not help

- **A suspected cross-tenant exposure or forged data.** Stop sends and keep the logs. Do not try to clean it up. Tell whoever owns security at your site, because the evidence matters.
- **Anything sent already.** A backup cannot call an email back. Reconcile with the relay's log.
- **Anything that needs a person's decision about their own data.** The commands here print IDs and counts on purpose. Ask the person, and do not go reading their content to judge it.
