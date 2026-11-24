# Ensemus

An AI-native company operating system, in which people and permissioned agents coordinate, carry out, verify and remember company work.

**Status: pre-release integration.** The core platform is implemented, with newer provider, Knowledge, mail, checkout and operations work being qualified together on `codex/release-candidate`. Preserved department-pack, meeting, skill, sandbox and federation foundations are also being developed; their presence is not completed functionality. See the [current release-candidate record](docs/06-delivery/release-candidate-2026-11-21.md) and [delivery plan](docs/06-delivery/06-end-to-end-delivery-plan.md). Independent security review, real-provider acceptance and launch approval remain open. Use generated test data and credentials during qualification.

## Layout

| Path               | What it holds                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `apps/web`         | The only customer-facing server (Next.js)                                                                     |
| `workers/workflow` | Temporal worker and the migration job; serves no HTTP                                                         |
| `packages/*`       | Shared domain, application, database, auth, secrets, storage, workflows, telemetry, contracts and config code |
| `infrastructure`   | Dockerfiles, Compose stack and gate scripts                                                                   |
| `tests`            | Integration tests against real PostgreSQL, and stack tests against built images                               |
| `docs`             | The full specification, ADRs and backlog                                                                      |

Coding agents must follow [`docs/AGENTS.md`](docs/AGENTS.md).

## Prerequisites

Node 24, pnpm (through Corepack) and Docker.

## Run it

```bash
corepack enable
```

```bash
pnpm install
```

```bash
pnpm stack:secrets
```

```bash
pnpm stack:up
```

Then open https://localhost:8443. It uses a local test certificate, so your browser will warn you the first time. Sign-up is on only in this test setup.

```bash
pnpm stack:down
```

## Check it

Run `pnpm stack:secrets --federation` before running the full air-gap gate directly.

| Command                                         | What it proves                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm lint`                                     | Code quality and architecture boundaries, such as no Temporal in the web tier  |
| `pnpm typecheck`                                | Strict types across the workspace                                              |
| `pnpm test:unit`                                | Unit tests, including crypto and redaction                                     |
| `pnpm test:integration`                         | Tenant isolation, roles, auth and secrets on real PostgreSQL                   |
| `pnpm test:stack`                               | Durability, isolation and confidentiality against a running stack              |
| `pnpm test:browser`                             | Accessibility, keyboard, live status and forms in Chromium, on a running stack |
| `node infrastructure/scripts/air-gap-gate.mjs`  | The stack passes its tests with outbound traffic blocked, with zero attempts   |
| `node infrastructure/scripts/build-release.mjs` | SBOMs and a signed manifest, verified with no network                          |
| `pnpm test:upgrade`                             | A paused approval is decided after a real release upgrade                      |
| `pnpm check:backlog`                            | The backlog and traceability matrix are consistent                             |
| `pnpm check:licenses`                           | No production dependency has an unreviewed license                             |
| `pnpm check:proxy`                              | The deployed proxy discards forged addresses and honours its two settings      |

`infrastructure/scripts/run-all-gates.sh` runs every gate on one machine, each from a clean stack. CI runs the same list.

Secrets generated here are throwaway test values, kept in `.local/` and ignored by git. Never use them for anything real.

Browser tests need Chromium once, with `pnpm --filter @ensemus/browser-tests exec playwright install chromium`. They save a screenshot of every page and state under `.local/screenshots`. They stop web and rename tables on purpose, so run them on a test stack and nothing else.
