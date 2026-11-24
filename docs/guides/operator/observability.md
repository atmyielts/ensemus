---
title: Dashboards, alerts and logs
audience: operator
area: op-run
tickets: [OPS-04]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [packages/telemetry/src/index.ts, packages/telemetry/src/console-guard.ts, packages/workflows/src/safe-logger.ts, packages/workflows/src/activities.ts, packages/database/src/dispatcher.ts, apps/web/src/app/api/health/live/route.ts, apps/web/src/app/api/health/ready/route.ts, apps/web/src/instrumentation.ts, apps/web/healthcheck.mjs, apps/web/src/server/runtime.ts, workers/workflow/src/main.ts, workers/workflow/src/healthcheck.ts, workers/workflow/src/reapply-command.ts, infrastructure/containers/Dockerfile.web, infrastructure/containers/Dockerfile.worker, infrastructure/compose/compose.yaml, docs/05-operations/01-slos-and-reliability.md, workers/workflow/src/dispatcher.ts, workers/workflow/src/connector-worker.ts, workers/workflow/src/egress-gateway.ts, docs/06-delivery/m8-slices.md]
tests: []
---

# Dashboards, alerts and logs

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**What exists today is structured logs, health checks and a few queries.** There are no dashboards, no alert rules, no metrics endpoint and no traces in this code, and nothing pages anyone. So nobody is told when something goes wrong unless you set that up from what is below. The monitoring product is the owner's decision.

This page sets no target and no threshold, because none has been measured or agreed. No service level is stated here. <!-- not-a-claim -->

In the commands below, `compose` means `docker compose -f infrastructure/compose/compose.yaml`.

## Logs

Every Ensemus process writes one JSON object per line to standard output. Nothing sends them anywhere, and there is no hosted telemetry.

```sh
compose logs --tail 200 web worker dispatcher
compose logs --since 10m dispatcher
```

A line looks like this:

```json
{"ts":"2026-01-01T00:00:00.000Z","level":"warn","service":"dispatcher","event":"dispatcher.delivery_failed","errorCode":"ECONNREFUSED"}
```

**What a log line can hold.** The fields are an allowlist in `packages/telemetry/src/index.ts`: identifiers, counts and codes. Anything else is dropped, and the line says how many fields were, as `droppedFields`. A value in a safe field has to be short and machine-shaped, so free text is refused there too. An error is reduced to its code, and its message is never logged, because database and provider errors can quote what they were given.

**So you will not find content in a log,** such as a work title, a file name or a person's address. That is why a line tells you what kind of thing broke, and a person then looks at the row. `organizationId` and `userId` can appear, so treat your log store as holding identifiers.

A line with a non-zero `droppedFields` means code tried to log something the allowlist does not hold. That is worth a report, and it is not itself an incident.

**Log rotation.** `compose.yaml` sets none, so the Docker daemon's own settings apply. Set rotation there, or the logs can fill the disk.

## Events worth knowing

| Event | Service | What it means |
|---|---|---|
| `worker.started`, `dispatcher.started`, `connector_worker.started`, `egress_gateway.started` | Each | The process came up |
| `worker.crashed`, `dispatcher.crashed`, `connector_worker.crashed`, `egress_gateway.crashed` | Each | It stopped, with an `errorCode`, and Docker restarts it |
| `migrate.done`, `migrate.failed` | `migrate` | The one setup job. If it failed, the services that wait for it do not start |
| `health.not_ready` | `web` | The readiness check could not reach PostgreSQL |
| `dispatcher.delivery_failed` | `dispatcher` | One event could not be delivered, with a code |
| `dispatcher.delivery_problem` | `dispatcher` | A batch had failures, deferrals or dead events, with a `count` |
| `dispatcher.poll_failed` | `dispatcher` | It could not read the outbox |
| `dispatcher.reconcile_failed` | `dispatcher` | It could not check the reminder schedules, and tries again |
| `tombstone_ledger.backlog` | `dispatcher` | Deletions are waiting for the ledger. It repeats each minute while any are |
| `tombstone_ledger.entry_unconfirmed`, `tombstone_ledger.entry_failed` | Re-apply command | See [after a restore](after-a-restore.md) |
| `restore_gate.closed` | `web` | A tenant is refused because its database is behind the ledger. With no restore behind it, treat it as in [incident runbooks](incidents.md) |
| `restore_gate.check_failed` | `web` | The gate could not ask the object store |
| `blobs.purge_failed` | `worker` | Byte deletions the store refused. They are tried again later |
| `work.failed`, `work.run_stranded` | `worker` | Work failed, or its run closed under it |
| `reminders.failed` | `worker` | One tenant's reminders could not be raised |
| `audit.refusal_failed` | `web` | A refusal could not be recorded. The refusal itself still held |
| `auth.error`, `auth.warning` | `web` | The sign-in library reported a problem, by code |
| `egress_gateway.target_unreachable`, `egress_gateway.at_capacity` | `egress-gateway` | See [the connector worker](connector-worker.md) |
| `temporal.<component>` | Workers | The Temporal library, with a code. Its own messages are not kept |

## Health checks

| Check | What it says | How to read it |
|---|---|---|
| `/api/health/live` | The web process is answering | `{"status":"ok"}` |
| `/api/health/ready` | The web process can reach PostgreSQL | `{"status":"ready"}`, or 503 and `{"status":"not_ready"}` |
| The worker image's health check | `/tmp/worker-alive` was written in the last 30 seconds | `healthy` in `compose ps` |
| PostgreSQL, Valkey, object store, Temporal | Each has a check in `compose.yaml` | `healthy` in `compose ps` |

Both web routes need no sign-in, so they name no dependency or version. The container's own check uses `/api/health/ready`. So a database outage marks `web` unhealthy, even though the process is fine.

```sh
compose ps
curl -k https://localhost:8443/api/health/ready
```

`-k` is only for this local check, because the certificate comes from the proxy's own authority. A health check here shows a process is alive. It does not show that work is moving: Temporal's check only looks for a listening port.

## Queries for what logs cannot say

Each prints counts and IDs, with no content. They use the database superuser, so run them from the host, and do not hand them to anyone as a report without looking first.

Events that are stuck or dead:

```sh
compose exec postgres psql -U postgres -d ensemus -c \
  "select state, count(*), min(next_attempt_at) from platform.outbox_events group by 1"
```

Deletions not yet in the ledger:

```sh
compose run --rm --no-deps dispatcher node dist/ledger-backlog.js
```

Whether a queue has a worker and a backlog is in [workers and workflows](workers-and-workflows.md). The `unknown` queue and webhook deliveries are in [the connector worker](connector-worker.md).

## What to watch, if you set up your own

These are the signals the code gives you. How much of each is too much has not been measured, so the numbers are yours to set from your own baseline.

- A service restarting, or `*.crashed` at all.
- `health.not_ready` for longer than a blip.
- `dead` in `platform.outbox_events` above zero.
- `queued` from `ledger-backlog.js` that keeps growing, or `oldestSeconds` that keeps rising.
- `restore_gate.closed` when nobody is restoring anything.
- Actions in `unknown`, and how old the oldest is. Nothing tells an operator about these.
- `egress_gateway.target_unreachable`, which is the relay and not Ensemus.
- A queue with no pollers.

## When it refuses

- **A line's field is missing.** It was not on the allowlist, or its value was not machine-shaped. It is dropped by design, and adding a field is a code change someone reviews.
- **`invalid_event_name`.** An event name held something other than safe characters, so it was replaced.
- **`/api/health/ready` says only `not_ready`.** It will not say why, because anyone can call it. The reason is in the `web` log, as `health.not_ready` with an `errorCode`.
- **No line for one tenant's content problem.** Content never reaches a log, so go to the row, with the IDs from the log.

## Not built

Dashboards and alert rules are planned as portable files, and none exists on any branch. The same is true of the public status page. Cost and usage reporting is not in this stack yet. Trace IDs are not carried through a request, so `requestId` in an API error is how a person can quote one call to you, and logs are matched by IDs and time.
