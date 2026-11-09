# CI replay corpus repair: 2026-11-09

The first Linux PR run exposed 23 missing required history files. They are now captured from a real
Temporal server using the pinned 1.25 SDK and the existing scripted Activity-boundary capture tests.
Five capture files and six capture cases passed in 134.29 seconds. This proves recorded workflow
control flow; it does not establish database, model/provider, physical-erasure or production acceptance.

## Actual capture commands

```powershell
$env:COMPOSE_PROJECT_NAME = 'ensemus-ci-replay-20261109'
$env:ENSEMUS_NETWORK_PREFIX = '10.234'
$env:ENSEMUS_TEST_TEMPORAL_PORT = '57339'
$env:ENSEMUS_TEST_PG_PORT = '55439'
docker compose -p ensemus-ci-replay-20261109 -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.test.yaml -f infrastructure/compose/compose.capture.yaml up -d --wait --wait-timeout 150 --no-build --pull never temporal-test-port
$env:ENSEMUS_CAPTURE_REPLAY = '1'
pnpm exec vitest run --project replay tests/replay/capture-client-onboarding.test.ts tests/replay/capture-knowledge-answer.test.ts tests/replay/capture-knowledge-ingest.test.ts tests/replay/capture-knowledge-purge.test.ts tests/replay/capture-object-migration.test.ts --maxWorkers=1 --no-file-parallelism
```

All four pinned images were already cached; no image build, pull or package install was needed.
Startup was limited to five named prerequisite services, five private project networks and one
exclusive PostgreSQL volume. Published ports were loopback-only 55439/57339. The active CI database
on 55437 and all product workers were untouched. Disk preflight passed at 18.32 GiB free.

## Captured and audited evidence

The 23 histories cover onboarding (3), Knowledge answers (5), ingest/sweep (8), purge (3) and object migration (4).
Every terminal result was decoded with the public synthetic corpus key and matched its expected
scenario. The store-retry history contains two transcript fences and two purge attempts; the
unconfirmed-transcript history contains no projection purge; the interrupted migration records a
real Activity retry. All 180 application input/result payloads were encrypted and contained only
explicit synthetic identifiers, enums, booleans and counts. No real customer content or key was used.

All 71 pre-existing histories remained byte-identical. Prettier was applied only to the 23 new JSON
files; parsed native event-data hashes were identical before/after formatting. Capture and audit
logs are `.local-ci-replay-capture-20261109.log` and
`.local-ci-replay-content-audit-formatted-20261109.log`; the owned-resource and content receipts are
`.local/ci-replay-owned-resources.json` and `.local/ci-replay-capture-content-proof.json`.

At this frozen fixture checkpoint, scoped Docker cleanup and the new full replay rerun are pending.
The earlier replay run passed 158 cases and failed these 23 missing-file checks; it is not a passing
replay result for the repaired corpus. The next check is `pnpm test:replay` with capture mode unset.
