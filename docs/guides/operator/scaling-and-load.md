---
title: Scaling and load
audience: operator
area: op-run
tickets: [PLAT-17, OPS-01, SEC-12]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [infrastructure/compose/compose.yaml, infrastructure/compose/compose.test.yaml, infrastructure/compose/proxy/Caddyfile, packages/database/src/connection.ts, packages/database/src/dispatcher.ts, packages/database/src/auth.ts, packages/database/src/secrets.ts, packages/auth/src/index.ts, apps/web/src/server/tenant.ts, workers/workflow/src/main.ts, tests/stack/replicas.test.ts, docs/05-operations/04-cost-and-capacity.md, docs/05-operations/05-container-deployment-runbook.md, docs/05-operations/06-performance-and-load-plan.md, m3-verified-actions:apps/web/src/lib/webhook-limiter.ts, m3-verified-actions:packages/domain/src/webhook.ts, m3-verified-actions:workers/workflow/src/egress-gateway.ts, m3-verified-actions:infrastructure/compose/compose.yaml, m8-foundation:docs/06-delivery/m8-slices.md]
tests: []
---

# Scaling and load

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**Nothing has been measured.** No load test has run. There is no number for how many people, tenants, runs or requests a stack can carry, and this page gives none. The load harness (`OPS-01`) and the autoscaling manifests (`PLAT-17`) are not on any branch yet. The numbers below are limits set in the code or in `compose.yaml`, which were chosen as starting values. None of them is a measured capacity.

In the commands below, `compose` means `docker compose -f infrastructure/compose/compose.yaml`.

## The limits that exist

| What | Where it is set | Value |
|---|---|---|
| Memory for `web` | `compose.yaml` | 1G |
| Memory for `worker` | `compose.yaml` | 2G |
| Memory for `dispatcher` | `compose.yaml` | 512M |
| Memory for `connector-worker`, `egress-gateway` | `compose.yaml`, with the profile | 1G, 128M |
| Database connections per process, by default | `packages/database/src/connection.ts` | 10 |
| Database connections for the dispatcher, sign-in, and secrets | Their own files | 2, 5, 3 |
| Sign-in attempts | `packages/auth/src/index.ts` | 10 a minute for each client address |
| Sign-up attempts | `packages/auth/src/index.ts` | 5 a minute for each client address |
| Other authentication routes | `packages/auth/src/index.ts` | 100 a minute for each client address |
| Webhook calls with a token nobody issued | The webhook limiter | 300 a minute from one address |
| Webhook calls on one replica | The webhook limiter | 3000 a minute, and 32 at once |
| Connections through the gateway | The gateway | Refused above 64 sockets, which is 32 connections |
| Temporal worker concurrency | Not set | The Temporal library's own defaults |

To change a memory limit, you change the file. No setting reads it from the environment.

## Scaling the web tier

**`compose up --scale web=2` does not work on the shipped file.** `web` has a fixed address, so the second container asks for the address the first holds, and fails to start. To add a replica:

1. Define it as a service of its own, with its own address on the `edge` network.
2. Pin its name in the `proxy` service's `extra_hosts`.
3. Add it to the upstreams in `proxy/Caddyfile`. The shipped file knows one upstream, so a replica you add gets no traffic until you change it.

`web-2` in `compose.test.yaml` is a working example of the service and its pin, for tests only.

**What replicas share is PostgreSQL.** Valkey runs in the stack, and no code connects to it. Sign-in limits are stored in the database, so they hold across replicas. The webhook limiter is in memory, so each replica has its own.

**Revoked access holds across replicas (`SEC-12`).** Who someone is in a tenant is read from PostgreSQL on each request, and kept for that one request only. No replica has a cache of permissions that could go stale. `tests/stack/replicas.test.ts` checks this by asking the replica that did not make the change. That test needs a running stack, and it was not run for this page.

## Scaling workers

Nothing in `compose.yaml` fixes the address of `worker` or `dispatcher`, so Compose should accept `--scale` for them. **No test runs more than one of either, so this has not been shown.**

- **More `worker` containers** poll the same queue, and Temporal shares tasks between them.
- **More `dispatcher` containers** claim events with row locks that skip what another has claimed. The stack ships with one. Check a backlog here against a Temporal or store outage first, because more dispatchers do not help with those.
- **`connector-worker`** has one job, which is holding credentials. Each send opens one connection through the gateway.

A worker's work and the web's load are in separate containers, so a busy worker takes no web process's memory. They do share PostgreSQL, and that shared pressure has not been measured.

## What overload looks like

| What you see | What it means | What to do |
|---|---|---|
| People get a refusal at sign-in, all at once | Behind your own proxy, everyone may share one address, and so one allowance | Set `ENSEMUS_TRUSTED_PROXIES`, as in [configuration](configuration.md) |
| A webhook sender gets 429 | A limit was reached. It is told to come back later, and retries | Check who is calling. See [the connector worker](connector-worker.md) |
| `egress_gateway.at_capacity` | The gateway refused a connection | Look for a stalled relay before raising anything |
| `health.not_ready` | `web` could not reach PostgreSQL | See [incident runbooks](incidents.md) |
| A task queue's backlog keeps growing | Its workers are behind or absent | See [workers and workflows](workers-and-workflows.md) |
| A container restarts and its log stops mid-work | It may be the memory limit. `docker inspect` says whether it was killed for memory | Raise the limit in the file, and write down what you changed and why |

Raising a limit moves a problem as often as it solves one. More web replicas with the default pool means more connections to the same PostgreSQL.

## What cannot be said yet

- **Whether an agent burst starves ordinary reads.** That is what `PLAT-17` asks. No agent worker runs in this stack yet.
- **How big a host you need.** The planning documents name company sizes as test personas, and they are not capacity tiers. Do not quote them as what a stack can do.
- **What it costs per verified outcome.** Nothing records this yet.

If you run your own load test, write down the release, the hardware, the data and the traffic, and say the result holds for those. Use generated accounts, and never real credentials. Do not point one at a deployment you do not own.
