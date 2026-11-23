---
title: Support access and break-glass
audience: operator
area: op-run
tickets: [OPS-24]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [infrastructure/compose/postgres/provision.sql, infrastructure/compose/compose.yaml, docs/00-foundation/adr/ADR-032-saas-operations-and-billing.md, infrastructure/compose/postgres/provision.sql, infrastructure/compose/postgres/upgrade-roles-m8.sql, packages/database/migrations/0501_saas_security.sql, packages/saas/src/support.ts, packages/application/src/saas/break-glass.ts, packages/application/src/saas/support-desk.ts, packages/config/src/index.ts, workers/workflow/src/ops.ts, workers/workflow/src/ops-desk.ts, tests/integration/saas-schema.test.ts]
tests: []
---

# Support access and break-glass

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**The default is no support access to customer content.** No role, command or page gives a support person a way to read a customer's work, files, connections or secrets.

**Break-glass cannot be used.** There is a design and a record for it. Nothing reads content because of one, and nothing built here changes that.

## What holds this default

It comes from what exists, not from a promise about behaviour.

- **Today's stack has no support role, desk or console.** A support person has nothing to sign in to.
- **The M8 foundation adds a role, `ensemus_support`, and it starts unable to log in.** `provision.sql` creates it `NOLOGIN`, so no credential for it exists in a default install.
- **Its table grants reach only the `support` schema**, which holds tickets, their messages, coverage hours and break-glass records. It has no grant on `work`, `integrations`, `secrets`, `org`, `identity` or `billing`. A ticket holds what a customer chose to write, and nothing else.
- **`tests/integration/saas-schema.test.ts` checks the role's reach from the database catalog.** That test needs PostgreSQL, and it was not run for this page.

The M8 work is on a foundation branch, and has not been merged. The role and its grants are written. Everything that would use them is a stub.

## What this does not limit

This default is a limit on the support role. **It is not a limit on whoever runs the deployment.** Be plain about this with your own people and your customers:

- Anyone with the database superuser password can read every table.
- Anyone with the shell on the host can read the secret files that the services read, and so can act as those services.
- Anyone with `db_app_url` can act as the application role. It still has to name a tenant, and it can name any.

So keep those to named people, and keep a record of who has them. In the hosted modes, that is the service's operators. In Sovereign, the customer runs the deployment, and the vendor has no access unless the customer gives it. Any access rule above this is for the agreement, and this page does not state one.

## Break-glass: what is built

On the M8 foundation branch, these exist and are enforced by the database:

| What | How it holds |
|---|---|
| A request is a row in `support.break_glass_requests`, and cannot be deleted | A trigger refuses it |
| Its states are `requested`, `authorized`, `denied`, `revoked` and `expired`. `denied`, `revoked` and `expired` are final | A trigger refuses any other move (`BREAK_GLASS_INVALID_TRANSITION`) |
| `authorized` needs an operator's signature and a customer owner's signature | A trigger refuses it with one (`BREAK_GLASS_NEEDS_TWO_AUTHORIZERS`) |
| The operator cannot be the person who asked | The same trigger |
| `authorized` needs a start and an end, no longer than what was asked for | A trigger refuses it (`BREAK_GLASS_NEEDS_TIME_LIMIT`) |
| Signatures cannot change once it has left `requested` | A trigger refuses it (`BREAK_GLASS_IMMUTABLE`) |
| `support.break_glass_log` is append-only | A trigger refuses a change or a delete |

## Break-glass: what is not built

- **No code reads content because of a request.** No role gets a grant from one, and no path checks one. An `authorized` row opens nothing.
- **No working way to file or sign one.** `signBreakGlass`, `requestBreakGlass`, `decideBreakGlass`, `revokeBreakGlass` and `authorizeBreakGlassAsOperator` throw `NOT_IMPLEMENTED`.
- **No desk.** `node dist/ops.js desk` throws `NOT_IMPLEMENTED`, and ends with `ops.failed` and exit status 1.
- **No page for an owner** to see, agree to or refuse a request.

Do not write to these tables by hand to make a record look as if the process ran. It would read as a control that was exercised, and it was not.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `ENSEMUS_BREAK_GLASS_ENABLED` | `false` | Off is the launch default. Turning it on grants nothing, since nothing uses it |
| `ENSEMUS_BREAK_GLASS_MAX_MINUTES` | None, and there is no default number | The longest a grant could run. With break-glass on and this unset, the configuration refuses to load |

Leave both alone. Whether to ever enable this is for the owner, counsel and an outside review, and reading content through it would need a separate reviewed change.

## When it refuses

| What you see | What it means | What to do |
|---|---|---|
| A support role cannot log in | It is `NOLOGIN`, by design | Do not change this. Nothing uses the role yet |
| `permission denied` for `ensemus_support` on any other schema | The role's reach ends at `support` | That is the control working |
| `ops.failed` from `node dist/ops.js desk` | The desk is a stub | There is no desk yet |
| `ops.refused` with `NOT_AN_AREA` | That is not one of the operator's command areas | Check the name. It exits with status 2 |
| A person asks you to look at their content to help | There is no supported way | Ask them to write what you need in the ticket or send it, and not to paste secrets |

Sovereign refuses nothing extra here, and nothing built gives the vendor a path into one.

## What needs a person

The break-glass design needs an outside security review before anyone proposes a way to read through it. Support hours, staffing and how people reach support are the owner's, and this page does not state them.
