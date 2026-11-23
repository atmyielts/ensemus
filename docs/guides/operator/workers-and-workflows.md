---
title: Workers and durable workflows
audience: operator
area: op-run
tickets: []
modes: [cloud, byom, sovereign]
status: written_untested
sources: [workers/workflow/src/main.ts, workers/workflow/src/redrive.ts, workers/workflow/src/ledger-backlog.ts, workers/workflow/src/healthcheck.ts, workers/workflow/src/migrate.ts, workers/workflow/src/dispatch-errors.ts, packages/database/src/dispatcher.ts, packages/workflows/src/workflows.ts, packages/workflows/src/constants.ts, packages/workflows/src/codec.ts, packages/workflows/src/activities.ts, infrastructure/containers/Dockerfile.worker, infrastructure/compose/temporal/setup-namespace.sh, tests/stack/platform.test.ts, tests/replay/replay.test.ts, docs/05-operations/05-container-deployment-runbook.md, workers/workflow/src/dispatcher.ts, workers/workflow/src/connector-worker.ts, packages/workflows/src/external-action-workflow.ts, packages/workflows/src/external-action-step.ts, packages/workflows/src/webhook-workflow.ts, packages/workflows/src/connector-sync-workflow.ts, infrastructure/compose/compose.yaml]
tests: []
---

# Workers and durable workflows

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Work that outlives a web request runs in separate processes, under Temporal. This page says what each process does, what happens when one stops, and the commands you have.

In the commands below, `compose` means `docker compose -f infrastructure/compose/compose.yaml`. Add `--profile connectors` if you run the connector services.

## What runs

| Service | What it runs | What it reaches | Starts with |
|---|---|---|---|
| `worker` | `dist/main.js`. Runs every workflow, and the Activities that only need PostgreSQL and the object store | PostgreSQL, Temporal, object store | Always |
| `dispatcher` | `dist/dispatcher.js`. Reads committed events and starts or signals workflows | PostgreSQL, Temporal, and the tombstone ledger prefix of the object store | Always |
| `connector-worker` | `dist/connector-worker.js`. Runs the Activities that hold a credential or read what strangers send | PostgreSQL, Temporal, the egress gateway | Only with the `connectors` profile. See [the connector worker](connector-worker.md) |
| `migrate` | `dist/migrate.js`, once, and then it exits | PostgreSQL, object store | Before the services above |

There are two task queues:

| Queue | Who polls it | What it carries |
|---|---|---|
| `ensemus-platform` | `worker` only | All workflow code, and Activities with no credential |
| `ensemus-connectors` | `connector-worker` only | Activities with no route except the gateway. They wait here if that worker is not running |

## How work reaches a worker

1. A person's action commits a row and an event, in one transaction, in PostgreSQL.
2. The dispatcher finds the event and starts or signals the workflow. It is the only path from committed business state to Temporal.
3. The worker runs the workflow. Business state stays in PostgreSQL. A workflow holds the order of steps, the waits and IDs.

The web tier cannot start, stop or read a workflow. It shares no network with Temporal, and `tests/stack/platform.test.ts` checks that it cannot reach it. Temporal's port is not published either: the proxy has the only published port in `compose.yaml`, and the stack includes no Temporal web interface.

Delivery is at least once, so a crash in the dispatcher repeats an action, and each action is safe to repeat. What crosses into Temporal is encrypted as well, with `TEMPORAL_CODEC_KEY`, so reading a history directly shows `binary/encrypted` payloads.

## The workflows

| Workflow | Started by | What it does |
|---|---|---|
| `workUnitWorkflow` | The event `work.execution_requested` | Takes a planned Work Unit through its steps, waits for an approval if one is needed, and verifies completion. A finished run may run again after an authorized retry. A live one may not |
| `tenantRemindersWorkflow` | A Temporal schedule for each organization, every 15 minutes | The tenant's upkeep: reminders, overdue approvals, unfinished byte deletions, stranded runs |
| `externalActionWorkflow` | The event for an approved action | Takes one action to sent, failed, unknown or cancelled. It never retries a send blindly. Its workflow ID can only ever run once |
| `webhookDeliveryWorkflow` | The event for a stored webhook | Gives one delivery a durable place to be verified, in the connector worker |
| `connectorSyncWorkflow` | A sync request, or a revoked connection | Runs passes of a connection's sync, with the cursor kept in PostgreSQL |
| `platformProbeWorkflow` | Nothing in the product | The smoke test for a deployment. It carries no business data |

The dispatcher creates a tenant's reminder schedule when the organization is created, and checks every tenant's schedule each time it starts. You should see `dispatcher.schedules_reconciled` with a `count` in its log.

## What happens when something stops

| What stops | What you see | What happens to the work |
|---|---|---|
| `worker` | Plan runs stop moving | Nothing is lost. Temporal holds the runs, and they carry on when it returns. A paused approval is still paused |
| `dispatcher` | New work does not start, and decisions do not wake their run | Events stay in the outbox and go out when it returns |
| Temporal | `dispatcher.delivery_failed` with an error code | Events wait, and an outage costs them no attempts. The web tier keeps working |
| PostgreSQL | `/api/health/ready` answers 503. Activities fail and retry | Work Activities retry through an outage shorter than a day. After that the run reports the failure honestly, and the work is marked failed |
| `connector-worker` | Actions stay in `sending` or `ready` | An action no worker picks up within an hour ends failed with `CONNECTOR_UNAVAILABLE`, which reached nobody. A delivery no worker verifies within 24 hours ends `NOT_PROCESSED_IN_TIME` |

An event that is at fault itself goes `dead` after 12 attempts. One that keeps getting gRPC `UNKNOWN` or `INTERNAL` could be an outage or a bad event, so it gets 288 attempts, about a day, before it goes `dead` the same way.

## Commands

### See what is running

```sh
compose ps
compose logs --tail 50 worker dispatcher
```

**Success:** `worker` and `dispatcher` say `healthy`, and their logs hold `worker.started` and `dispatcher.started`. **Failure:** a container restarting, with `worker.crashed` or `dispatcher.crashed` and an `errorCode`.

Each process rewrites `/tmp/worker-alive` every 5 seconds, and its health check fails if the file is more than 30 seconds old. So a crash cannot look healthy for long. A process that is alive but doing nothing useful can, so also look at the queue.

### See whether anyone is polling a queue

The stack's admin tools image holds the Temporal command line. It goes through the same internal address as the namespace job does:

```sh
compose run --rm --no-deps --entrypoint temporal \
  -e TEMPORAL_ADDRESS=passthrough:///temporal:7233 \
  temporal-namespace task-queue describe --task-queue ensemus-platform --namespace default
```

**Success:** a poller is listed, and the backlog is not growing between two runs. **Failure:** no pollers means the worker for that queue is not connected. The image is pinned by digest, so if a flag differs, read `temporal task-queue describe --help` from the same image.

To see what is open, which prints IDs, types and times and no content:

```sh
compose run --rm --no-deps --entrypoint temporal \
  -e TEMPORAL_ADDRESS=passthrough:///temporal:7233 \
  temporal-namespace workflow list --namespace default --query "ExecutionStatus='Running'" --limit 20
```

### See and put back dead events

This counts them, with no content:

```sh
compose exec postgres psql -U postgres -d ensemus -c \
  "select state, count(*) from platform.outbox_events group by 1"
```

Fix whatever killed them first, then put them back, for one organization or for all:

```sh
compose exec dispatcher node dist/redrive.js [organization-id]
```

**Success:** exit status 0, and an `outbox.redriven` log line with a `count`. **Failure:** `outbox.redrive_failed` with an `errorCode`, and exit status 1. Its database role cannot read event content, so it cannot print any.

### See deletions waiting for the ledger

```sh
compose run --rm --no-deps dispatcher node dist/ledger-backlog.js
```

It logs `queued`, `dead` and `oldestSeconds`. Normally the first two are zero. These are the deletions a restore could not put back. See [backup and restore](backup-and-restore.md).

## Upgrading

Workflow code is replayed from history, so a change to the order of its steps can break work already in flight. `pnpm test:replay` replays recorded histories against the current code, and it needs no server. A release with a failing replay should not ship. For the upgrade itself, see [upgrade](upgrade.md).

The namespace keeps a closed run's history for 72 hours. That is set when `temporal-namespace` first creates it, in `setup-namespace.sh`, and running the job again does not change it.

## When it refuses

- **`worker.crashed` or `dispatcher.crashed` with `errorCode` `ConfigError`, and the process exits.** A secret or setting is missing or empty. The log holds only the code, and not which one, so go through the secrets that service has in `compose.yaml`, and check that each file is mounted and not empty.
- **`Temporal codec key must be 32 bytes`.** `TEMPORAL_CODEC_KEY` is not a base64 value of 32 bytes. All of `worker`, `dispatcher` and `connector-worker` have to hold the same one. This codec takes one key, so changing it while runs are open leaves them unable to read their own history.
- **`worker.probe_failed`.** The worker could not ask Temporal whether a run is open. It treats the answer as open, and asks again at the next sweep, so nobody's work is failed because of it.
- **`work.run_stranded` or `work.failed`.** The upkeep found work whose run has closed, and marked it. People see it on the work's page.
- **A second start of the same action.** The dispatcher treats "already started" as success. It does not start a second run, and that is what stops a redelivered event sending twice.

## What is not here yet

No agent worker or knowledge worker runs in this stack. `compose.yaml` has no service for them, so nothing on this page covers model calls or document ingestion. Worker concurrency has no setting of its own, and no load has been measured. See [scaling and load](scaling-and-load.md).
