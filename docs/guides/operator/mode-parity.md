---
title: Checking parity across modes
audience: operator
area: op-run
tickets: [COMM-06]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [docs/00-foundation/adr/ADR-036-release-readiness.md, infrastructure/scripts/parity-gate.mjs, infrastructure/scripts/run-all-gates.sh, infrastructure/scripts/generate-test-secrets.mjs, infrastructure/compose/compose.yaml, infrastructure/compose/compose.test.yaml, infrastructure/compose/compose.airgap.yaml, tests/parity/rules.ts, tests/parity/catalog.ts, tests/parity/contract.ts, tests/parity/seams.ts, tests/parity/harness.ts, tests/parity/wiring.ts, tests/unit/gates.test.ts, .github/workflows/ci.yml, vitest.config.ts]
tests: []
---

# Checking parity across modes

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**The parity gate has not run yet.** It has never started a container, so it has shown nothing about any mode. Nobody can say today that Cloud, BYOM and Sovereign behave alike. This page explains how to run it, and how to read what it says.

The gate runs one release in all three modes and compares what each one did. The mode is configuration, so the same images run every round.

## Before you run it

**Run it on a machine you can wipe, never on a deployment.** The gate uses the Compose project `ensemus`, and it runs `docker compose down -v --remove-orphans` before each round and at the end. That deletes the volumes of any stack of that name on the host, with its database and files.

It needs Docker, a clean commit and the time for one build and three full stacks. CI gives the job up to an hour.

```sh
pnpm install --frozen-lockfile
pnpm stack:secrets
```

`pnpm stack:secrets` writes generated test values to `.local/secrets`, and keeps any file already there. These are test values only.

## Running it

```sh
node infrastructure/scripts/parity-gate.mjs
```

Run the gate, and not the parity test project by itself. The project reads `ENSEMUS_PARITY_MODE`, and it needs a stack the gate started in that mode, so on its own it stops with a message saying so.

For launch sign-off, add `--release`:

```sh
node infrastructure/scripts/parity-gate.mjs --release
```

The gate takes these steps:

1. It records the commit, and whether the tree has uncommitted changes.
2. It builds the images once.
3. For each of `cloud`, `byom` and `sovereign`, it starts the stack with that `ENSEMUS_MODE`, records the image IDs that really ran for `web` and `worker`, and runs the parity scenarios.
4. It compares the three reports and prints a verdict.
5. It takes the stack down.

Before believing anything, each scenario file signs a new person up, and reads who the deployment says it is on the setup page. If that is not the mode under test, the file stops.

## Reading the result

There are three verdicts:

| Verdict | Printed as | Means |
|---|---|---|
| `proven` | `PROVEN` | Every scenario ran and passed in every mode it applies to, shared scenarios behaved alike, on one commit and one set of images, with a clean tree, and Sovereign ran with outside names unreachable |
| `not_proven` | `NOT PROVEN` | Nothing contradicts parity, and it has not been shown. Something did not run, or ran somewhere that does not count |
| `failed` | `FAILED` | Something ran and contradicts parity, or the evidence cannot be trusted |

**`not_proven` is not a pass.** It says nobody knows. A scenario waiting on a part of the product that is not wired in is `blocked`, with what it is waiting for. It is never skipped into a pass, and no stand-in can make it pass.

The findings under the verdict say why:

| Finding | Leads to | What it means |
|---|---|---|
| `scenario_blocked` | `not_proven` | The scenario needs something not plugged in yet. Its reason names the owning tickets |
| `missing_result` | `not_proven` | A scenario in the catalog did not run in a mode it applies to |
| `missing_report` | `not_proven` | A whole mode has no report |
| `uncommitted_changes` | `not_proven` | The results do not describe the commit they name. Commit, and run it again |
| `open_network` | `not_proven` | The Sovereign round ran with outside names reachable, so it does not count |
| `scenario_failed` | `failed` | An assertion failed |
| `behaviour_differs` | `failed` | Two modes passed and saw different things. The finding shows what each one saw |
| `no_observation` | `failed` | A scenario passed without saying what it saw |
| `identifier_in_observation` | `failed` | An observation held an ID, an address, a timestamp, a long hexadecimal value or a URL |
| `different_images`, `different_commit` | `failed` | The modes did not run one release |
| `wrong_mode`, `unknown_scenario`, `duplicate_result`, `duplicate_report`, `empty_catalog` | `failed` | The run itself cannot be trusted |

The count line, such as `0 of 115 results passed.`, is results passed out of results asked for. The catalog holds 43 scenarios, which makes 115 results across the modes they apply to. Of the 43, 34 are shared, and must look the same everywhere. The other 9 test a difference the contract allows, each against its own expected answer in that mode.

## The two bars

| How it runs | Fails on `failed` | Fails on `not_proven` | Where |
|---|---|---|---|
| Plainly | Yes | No | The `parity` job in CI, and `run-all-gates.sh` |
| With `--release` | Yes | Yes | Launch sign-off |

There are two on purpose. A gate that stayed red until everything was built would teach people to ignore it. A gate that went green with most scenarios blocked would be worse. So a plain run exits 0 and prints `NOT PROVEN`, and **an exit of 0 from a plain run says nothing contradicted parity, and no more.** Read the verdict, not the exit status.

A plain run also exits 1 if the suite broke before it could report, or if a stack would not start.

## What to expect today

The scenarios come from their own slices, and the seams that connect them to the product are empty (`tests/parity/wiring.ts`) until the milestones are merged. So the first honest result is expected to be `NOT PROVEN`, with most scenarios `blocked` or `missing_result`. That is the gate working. Do not read it as a fault to quieten, and do not read a small `FAILED` list as the only work left.

## What a mode is allowed to differ on

Modes may differ only along a named dimension in `tests/parity/contract.ts`. Each one names which allowed difference it is (hosting, local provider availability, external integrations, licensing and billing, or support) and the row of the commercial documents it came from. It says who does what, and holds no price, allowance or service level. A difference that fits none of those is a parity failure, and not a new row. <!-- not-a-claim -->

## The evidence

```text
.local/parity/report-cloud.json      what one mode did, with its commit and image IDs
.local/parity/report-byom.json
.local/parity/report-sovereign.json
.local/parity/outcome.json           the verdict and the findings
.local/parity/<mode>/*.json          results from each scenario file
```

The gate removes `.local/parity` when it starts, so keep what you need. CI keeps it as the `parity-reports` artifact. A report holds statuses, codes, counts and sequences, and refuses IDs and addresses, so it is meant to be kept as release evidence. These are files, and no part of the product shows them.

## When it refuses

| What you see | What it means | What to do |
|---|---|---|
| `Set ENSEMUS_PARITY_MODE to cloud, byom or sovereign` | The test project ran without the gate | Run the gate |
| `Told to test <mode>, but the deployment says it is ...` | The running stack is not the mode under test. The file stops, and the gate says the suite did not finish | Check for another stack, and for `ENSEMUS_MODE` set in your shell or in a Compose file |
| `FAILED: the parity suite did not finish in <mode>.` | The suite broke before a scenario reported, and exit status is 1 | Read the suite's output above it |
| `FAILED: a release needs parity shown, and it has not been.` | `--release` with `not_proven` | There is no flag for this. A mode that has not shown parity waits, unless the owner names an exception in the launch record |
| `An observation must not hold ...` | A scenario tried to record an identifier | Fix the scenario. It is reported as failed |
| `... is not in tests/parity/catalog.ts` or `... belongs to ...` | A scenario file names an ID that is not its own | Fix the file |

## What this does not show

- **That Sovereign is isolated.** Its round makes outside names unreachable. It does not count packets, and `air-gap-gate.mjs` is still the gate for that. Nothing here replaces it, and no claim about offline use rests on this page. <!-- not-a-claim -->
- **That a real provider, relay or payment processor works.** Whatever sits on the far side of a seam is a local fake.
- **That the product is right.** Three modes can agree and all be wrong. It shows they behave alike on these scenarios.
- **Anything about a stack with the connectors profile on,** unless a seam starts one. The gate itself starts the default stack.
