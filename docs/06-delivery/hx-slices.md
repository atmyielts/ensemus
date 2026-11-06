# HX slices

Nine builders work in parallel from the foundation commit, and a tenth writes the documents once they have merged. **No file has two owners.** Everything they must agree on is already decided in [ADR-037](../00-foundation/adr/ADR-037-hardening-backlog.md) and already typed in the code. Read that ADR first, because it holds the reasons.

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

## This is code-only work

Nobody on this milestone has Docker. **Write it, typecheck it, and say it did not run.**

| Rule | Detail |
|---|---|
| Never run | `docker`, `docker compose`, `pnpm test:integration`, `test:stack`, `test:browser`, `test:upgrade`, or any gate that needs a container |
| Do not edit | Dockerfiles, `compose*.yaml`, `.dockerignore`. Report what they need under `docker_later`. `infrastructure/compose/temporal/setup-namespace.sh` is a script, not a Compose file, and the retention slice owns it |
| Allowed checks | `pnpm exec prettier`, `eslint`, `typecheck`, `pnpm --filter @ensemus/web exec next typegen`, `vitest run --project unit <paths>`, `pnpm test:replay` |
| Memory | Run every install, typecheck, eslint, typegen and vitest through the slot wrapper you were given, with a 600000 ms timeout. Exit 75 means no slot yet, so run it again. No dev server, no watch mode |
| Disk | Below 3 GB free on C:, stop and report. Delete nothing outside your worktree |
| Reporting | Integration, stack and browser tests you wrote are **unverified**. Say so, and never report them as passing |
| Commit | With several `-m` flags, the last being `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`. Do not push |

## Fixed: nobody changes these

| What | Where |
|---|---|
| Decisions | ADR-037, this file, `docs/05-operations/07-image-size-and-rebuild-guidance.md`, `docs/00-foundation/03-decisions-and-adrs.md` |
| Migrations. **There are none (D10), and no builder adds one** | `packages/database/migrations/`, `meta/` |
| Tenant binding | `withMemberTenantTx`, `tenantBindings`, `applyBindings` and `readMembership` in `packages/database/src/tenant.ts`, `packages/database/src/index.ts` |
| Tracing API and config | `packages/telemetry/src/tracing.ts`, `tracing.test.ts`, `isSafeValue`, `sanitize` and `SAFE_FIELDS` in `packages/telemetry/src/index.ts`, `loadTracingConfig` in `packages/config/src/index.ts` |
| Tool images | `infrastructure/scripts/tool-images.mjs` |
| Gate lists | `.github/workflows/ci.yml`, `infrastructure/scripts/run-all-gates.sh`, `tests/unit/gates.test.ts`. They already call what you will write, under these exact names: `pnpm check:pins`, `node infrastructure/scripts/scan-images.mjs`, `node infrastructure/scripts/reproducible-gate.mjs --report-only`. The names of `.local/release/scan-*.json` and `.local/reproducible/report.json` are fixed too |
| Import rules | `eslint.config.mjs` |
| Dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package** | every `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.pnpmfile.cjs` |
| Build ID | `generateBuildId` in `apps/web/next.config.ts` |

A bug in any of these is reported, not fixed in passing.

## Every slice

- Denied and fault tests first, then the code. If it touches tenant data, two tenants with the same names, and real roles.
- Generated test values only: `@example.invalid` addresses, `203.0.113.x` and `198.51.100.x` addresses, random keys, a canary like `sk-CANARY-...`. No real address, credential or provider, and do not claim anything you did not prove.
- Doubles live in tests and never ship as a default code path.
- Log codes and counts through `createLogger`, never text. A field the logger's allowlist drops is a bug in your call, not a reason to change the list.
- A decision made by a script goes in a `*-rules.mjs` file beside it, with a unit test, as `infrastructure/scripts/air-gap-rules.mjs` does, so that a gate that needs Docker can still be shown to fail. A gate that cannot fail is worse than no gate.
- Scripts run on plain Node with no dependencies. Tests importing a `.mjs` from `tests/unit` follow `tests/unit/air-gap-rules.test.ts`.
- Follow the house comment style: say why, in plain sentences.

---

# Wave 1: all nine can start at once

## reproducible: `FOUND-01`, ADR-037 D1

The static pin check, which blocks now, and the two-build comparison, which reports.

**Owns (all new):**

- `infrastructure/scripts/check-pins.mjs`, `pin-rules.mjs`, `reproducible-gate.mjs`, `reproducible-rules.mjs`
- `tests/unit/pin-rules.test.ts`, `tests/unit/reproducible-rules.test.ts`

**Implements:**

```js
// pin-rules.mjs. Each answers a list of problems, each naming the file and the offending reference.
dockerfileProblems(name, text)   // every FROM by @sha256, or naming an earlier stage
composeProblems(name, text)      // every image: by @sha256
workflowProblems(name, text)     // every uses: by a 40-hex commit; every pnpm install is --frozen-lockfile
manifestProblems(name, json)     // every dependency an exact version or workspace:*, no ^ ~ * or latest
scriptImageProblems(name, text)  // an image name in a script either has @sha256, is a built ensemus/*:local, or comes from tool-images.mjs
toolImageProblems(images)        // every entry in tool-images.mjs by @sha256
versionFileProblems({ nvmrc, packageManager }) // .nvmrc is x.y.z; packageManager carries +sha512. or +sha256.

// reproducible-rules.mjs. Pure, over parsed OCI index and manifest JSON and over file listings.
compareImages(a, b)              // { same, differentLayers: [{ index, a, b }] }, comparing manifest digests first
filesThatDiffer(listingA, listingB) // sorted paths, [{ path, sizeA, hashA, sizeB, hashB }] in, names only out
exitCodeFor(report, { reportOnly }) // 0 if same; 0 if different and reportOnly; 1 if different; 1 if any build failed, whatever reportOnly says
```

`check-pins.mjs` walks the real files and prints `Pins: OK, <n> checked`, or each problem and exits 1. `reproducible-gate.mjs [--report-only]` needs Docker and only runs in CI:

- Creates its own `docker-container` buildx builder under a unique name, and removes it in `finally`. Use Context7 for the current buildx flags.
- `docker buildx build --no-cache --file infrastructure/containers/Dockerfile.<web|worker> --build-arg SOURCE_DATE_EPOCH=<git log -1 --format=%ct> --output type=oci,dest=<path>,rewrite-timestamp=true .`, twice each, with `--build-arg ENSEMUS_RELEASE=reproducible` for web.
- Writes `.local/reproducible/report.json` with names, digests and differing paths, **no file contents**. Deletes the tarballs in `finally`, whatever happens, because the owner's disk is small. It never prunes anything.
- Prints `Reproducible: yes` or `Reproducible: NO (report only)` or `Reproducible: NO`.

**Tests owned, unit, must run:**

- Each `*Problems` against something that must fail and something that must pass, including: a tag with no digest, a stage reference, a `FROM` with `--platform`, a short commit SHA, a `^` range, and a floating `.nvmrc`.
- `tests/unit/pin-rules.test.ts` also runs the rules over the real repository and expects no problems. **If the repository fails, report what it found.** Do not loosen the rule to pass.
- `exitCodeFor` across all three outcomes and both modes. A failed build must fail in report-only mode.
- `compareImages` on identical, one layer changed, and a different layer count. `filesThatDiffer` on an added file, a removed file and changed contents.

**Faults:** a build fails, the second tarball is missing, a report has no images. Each is a failure and never reads as "same".

**Unverified, say so:** `reproducible-gate.mjs` has never run. Report the expected result: web differs, on the Server Action key, until the Dockerfile change.

## image-scan: `FOUND-01`, ADR-037 D2

**Owns (all new):**

- `infrastructure/scripts/scan-images.mjs`, `scan-rules.mjs`
- `infrastructure/security/image-scan-exceptions.json`, starting as `{ "exceptions": [] }`
- `tests/unit/scan-rules.test.ts`, and a small hand-written Grype report in `tests/unit/fixtures/grype-report.json`, using made-up IDs like `CVE-0000-0001`

**Implements:**

```js
// scan-rules.mjs. `report` is parsed Grype JSON. `exceptions` is the parsed file.
evaluateScan(report, exceptions, now /* Date */)
// { failing: Finding[], listed: Finding[], problems: string[] }
// Finding: { id, severity, package, version, fixedIn: string[] }
exceptionProblems(exceptions, now) // entry missing id, package, reason or expires; an expired entry
```

**Policy:** a `Critical` always fails. A `High` fails when its fix state is `fixed`. Everything else is `listed`. An exception matches on `id` and `package`, moves a finding from `failing` to `listed`, and is a `problem` if it has expired or if it matched nothing. A report that does not parse as Grype's shape, or has no `descriptor`, is a `problem`: **an empty result must never read as clean because the tool did not run properly.**

`scan-images.mjs` needs Docker and only runs in CI and `run-all-gates.sh`. For `web` and `worker`, it requires `.local/release/sbom-<name>.spdx.json` and fails if either is missing, then runs `GRYPE.image` from `tool-images.mjs` against `sbom:/sbom/sbom-<name>.spdx.json` with `-o json`, `--network` left on for the database, and `GRYPE_CHECK_FOR_APP_UPDATE=false`. It decides from the JSON, and not from `--fail-on`, so the policy stays in one tested place. It writes `.local/release/scan-<name>.json` and prints `Image scan: <n> failing, <m> listed`, and exits 1 on anything failing or a problem. Use Context7 (`/anchore/grype`) for the JSON shape and the current flags.

**Tests owned, unit, must run:** a critical with no fix fails; a high with a fix fails; a high with no fix is listed; a medium is listed; an exception moves one finding only and not the same CVE in another package; an expired exception is a problem; an unused exception is a problem; missing fields; a report with no `descriptor`; a report with no `matches` and a valid `descriptor` is clean.

**Unverified, say so:** the scan has never run. Its first run may find real issues, and those are findings to report, not failures of the work.

## release-signing: `FOUND-07`, ADR-037 D4

**Owns:**

- `infrastructure/scripts/build-release.mjs`, `infrastructure/scripts/verify-release.mjs`
- new `infrastructure/scripts/release-signing.mjs`
- new `tests/unit/release-signing.test.ts`, new `tests/unit/fixtures/fake-signer.mjs` (reads standard input and signs with a key from a path in an environment variable the test sets)

**Implements:**

```js
// release-signing.mjs
export const THROWAWAY_MARKER = 'THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION';
keyIdOf(publicKeyPem)           // sha256 hex of the SPKI DER bytes
createThrowawaySigner()         // { marker, publicKeyPem, keyId, sign(bytes) }. The private key never leaves the closure
createCommandSigner({ command, publicKeyPem }) // same shape. spawnSync(command, [], { input: bytes }) with NO shell and a timeout. Reads base64 from stdout. Fails on non-zero, and does not repeat stderr
signerFromEnv(env)              // ENSEMUS_RELEASE_SIGNER_COMMAND with ENSEMUS_RELEASE_PUBLIC_KEY_FILE, both or neither. One alone throws
signManifest(manifest, signer)  // adds signing and signing_key_id, serializes, signs, verifies the signature against signer.publicKeyPem, and throws if it does not verify. Returns { bytes, signature }
```

`verify-release.mjs` ships alone in the release folder, so it **must import nothing but `node:` modules**, and it repeats the marker text. Its command line is `node verify-release.mjs <folder> [public-key.pem] [--allow-test-key]`. Its behaviour:

| Situation | Result |
|---|---|
| No key named | Fails, saying a key from outside the release is needed. It never falls back to the one in the folder |
| Good signature, good key, not a test release | `OK: this release verified with no network access.` |
| `signing_key_id` missing, or not matching the key given | Fails |
| Test-marked, without `--allow-test-key` | Fails, saying it is a test release |
| Test-marked, with `--allow-test-key` | `OK (test key, not a release)` |
| Not test-marked, with `--allow-test-key` | Fails. The flag cannot be used to get around anything |
| Bad signature, changed SBOM | Fails, as now |

`build-release.mjs` uses `signerFromEnv`, and `createThrowawaySigner` when neither is set. It keeps its `Control,` lines and adds two: a test release with no flag is rejected, and a real-marked manifest with the flag is rejected. It passes `--allow-test-key` only for the throwaway. `SYFT` already comes from `tool-images.mjs`. Only the public key goes in the folder.

**Tests owned, unit, must run** (they run `verify-release.mjs` with `spawnSync` on a temporary folder, with a generated key and the fake signer): every row of the table; a key swapped in the folder alongside a changed manifest is rejected when the real key is named; a signer that exits non-zero, that returns garbage, that signs with the wrong key, and that writes a secret to stderr which must not reappear in what is thrown; one environment variable set without the other; `keyIdOf` is stable and differs between keys; `verify-release.mjs` imports only `node:` modules.

**Unverified, say so:** the end-to-end in `build-release.mjs` needs built images and Docker. **M6 adds `build-bundle.mjs`, which follows `build-release.mjs` on throwaway signing.** Keep the marker text exactly as it is now, and keep your changes small.

## otel-core: `FOUND-04`, ADR-037 D3

**Owns:** `packages/telemetry/src/tracing-sdk.ts` (a stub now), new `packages/telemetry/src/tracing-sdk.test.ts`.

**Implements, with these exact signatures** (stubbed already):

```ts
export const SPAN_ONLY_ATTRIBUTES: readonly string[]; // fixed by the stub
export function redactSpan(span: ReadableSpan): ReadableSpan;
export function createRedactingExporter(inner: SpanExporter): SpanExporter;
export async function startTracing(
  service: string,
  config: TracingConfig,
  options?: { release?: string; exporter?: SpanExporter },
): Promise<TracingHandle>;
```

`redactSpan` follows ADR-037 D3 exactly, and returns a copy with:

- Attributes: only `sanitize` from `./index`, plus `SPAN_ONLY_ATTRIBUTES` where the value passes `isSafeValue`, or for `next.route` this route shape: `/^\/[A-Za-z0-9._\/\[\]()-]{0,200}$/`. Numbers and booleans only for `http.response.status_code`.
- Name: kept if it passes `isSafeValue`, or if it is exactly `<GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS> <next.route>` with a route that passed the shape above. Otherwise `next.internal`.
- Status: code only, with no message. `events`: empty. `links`: span context only, no attributes. `resource`, `instrumentationScope`, the IDs and the times: unchanged. Do not call `Object.assign` on the input: `ReadableSpan` is shared with other processors.

`startTracing`, with `{ enabled: false }`, does nothing and loads nothing, and answers a handle whose `shutdown` resolves. With it enabled: `NodeTracerProvider` from `@opentelemetry/sdk-trace-node` with `resourceFromAttributes` (`service.name`, plus the release if it is given, nothing else), `ParentBasedSampler` over `TraceIdRatioBasedSampler(config.sampleRatio)`, and one `BatchSpanProcessor` over `createRedactingExporter(options.exporter ?? new OTLPTraceExporter({ url: config.endpoint }))`. Register with `{ propagator: null }` so that no propagator is set, and keep the async-hooks context manager. A second call in a process returns the first handle. Check the 2.12.0 API in `node_modules` as well as Context7, because Context7's current docs are for 3.x, and the `@opentelemetry/sdk-trace` it names is not the package here.

**Tests owned, unit, must run:**

- **A canary cannot get out.** Put `sk-CANARY-...` in: an attribute under a bad name; a safe name with a free-text value; `http.target` and `http.url`, with an `/invite/<token>` path; a span name; a status message; `recordException`, with the canary as the message and in the stack; a link attribute; and an event. Serialize everything the inner exporter received, and assert the canary is absent from it. **Use `InMemorySpanExporter`, then again through the real `OTLPTraceExporter` to a throwaway `node:http` server on loopback that the test starts,** and read what it received.
- What is kept survives: the IDs, `errorCode`, `http.request.method`, `next.route`, and a `GET /o/[organizationId]/work` name. A name with a raw ID in it does not survive.
- `redactSpan` leaves its input unchanged.
- With `{ enabled: false }`, `withSpan` runs, no server receives anything, and no global provider is set.
- A `traceparent` is not believed: `propagation.extract` with such a carrier yields no remote span after `startTracing`.
- A second `startTracing` keeps the first. `shutdown` flushes. An exporter that fails does not make `withSpan` fail or slow the work down. A collector that is down does not throw.
- Use `trace.disable()` between tests, because the provider is global.

**Faults:** an exporter that throws, and a server that answers 500 or hangs.

## otel-web: `FOUND-04`, ADR-037 D3

**Owns:**

- `apps/web/src/instrumentation.ts`
- new `tests/unit/web-instrumentation.test.ts`
- new `tests/stack/tracing.test.ts`, new `tests/helpers/otlp-sink.ts`

**Implements.** In `register()`, for the Node.js runtime only, after the console guard goes in, because a failure here must be logged safely: read `loadTracingConfig()` from `@ensemus/config`. If it is on, `await import('@ensemus/telemetry/tracing-sdk')` and `startTracing('web', config, { release: process.env.ENSEMUS_RELEASE })`. If it is off, **do not import the SDK at all**, so that a default install never loads it. A `ConfigError` propagates: a bad setting stops the process, and that is loud on purpose. Add no signal handler: one could change how the server stops, and the last batch of spans may be lost, which is acceptable for tracing.

`NEXT_OTEL_FETCH_DISABLED` is not needed, because `redactSpan` handles what a fetch span carries. Say so in a comment if you think someone will wonder.

**Tests owned, unit, must run** (`tests/unit/web-instrumentation.test.ts`, with `vi.mock` on the SDK module): off means the SDK module is never loaded; on starts it with the endpoint; `NEXT_RUNTIME` other than `nodejs` does nothing; a bad endpoint rejects, with no value in the error.

**Written, unverified:** `tests/stack/tracing.test.ts`, skipped with a clear message unless `ENSEMUS_TEST_OTLP_SINK_FILE` is set, because it needs a Compose overlay nobody can add here. `tests/helpers/otlp-sink.ts` reads what a sink wrote. It signs in, opens a page, and asks for an `/invite/<token>` URL with a canary as the token. It asserts that spans arrived from the web tier, and that neither the canary nor any address, email or organization name is in them. List the overlay under `docker_later`: a small `node:http` sink service in `compose.test.yaml`, on the web tier's network, and `ENSEMUS_OTEL_ENDPOINT` set on `web`.

**Unverified, say so:** that the web image really contains these packages after output tracing, and starts with tracing on.

## otel-worker: `FOUND-04`, ADR-037 D3

**Owns:**

- `workers/workflow/src/main.ts`, `workers/workflow/src/dispatcher.ts`
- new `workers/workflow/src/activity-tracing.ts`, `activity-tracing.test.ts`
- new `tests/unit/tracing-boundaries.test.ts`

**Implements:**

```ts
// activity-tracing.ts
import type { ActivityInterceptorsFactory } from '@temporalio/worker';
/** A span around each Activity, with IDs and the attempt, and never its arguments or result. */
export function activityTracing(): ActivityInterceptorsFactory;
```

It uses `withSpan('activity.execute', { activityType, workflowId, taskQueue, attempt }, ...)` with values from the context's `info`, in the `execute` inbound call.

- `main.ts`: `interceptors: { activity: [activityTracing()] }` on `Worker.create`. At the top of `main()`, after `Runtime.install`, the same dynamic start as otel-web, with the service `worker`, and `await handle.shutdown()` after the worker has stopped.
- `dispatcher.ts`: start the same way with the service `dispatcher`. Wrap `handle` in `withSpan('dispatcher.deliver', { eventType: event.eventType, organizationId: event.organizationId }, ...)`. Do not change what happens to an error. **Change nothing else about delivery.**
- **Leave `connector-worker.ts` and `egress-gateway.ts` alone, and no workflow file imports any of this.** A new `workflowsPath` or bundle option is not part of this.

**Tests owned, unit, must run:**

- `activity-tracing.test.ts`, with a fake `next` and a local exporter through `startTracing`, or a stub: the span has the four fields and no canary from the arguments or the result; a failing Activity passes on the same error, with an `errorCode` and no message; `next` is called with the same input.
- `tests/unit/tracing-boundaries.test.ts`, reading sources like `tests/unit/web-events.test.ts`: `connector-worker.ts` and `egress-gateway.ts` name no tracing; no file under `packages/workflows/src` imports `@opentelemetry/*`, or anything from `@ensemus/telemetry/tracing`; `tracing-sdk` is imported only dynamically.
- `pnpm test:replay` still passes, and `git diff` shows no change in `tests/replay/histories/`.

**Unverified, say so:** that `esbuild` bundles this into a worker that starts. Report the worker image build under `docker_later`.

## sse-merge: `API-13`, ADR-037 D5

**Owns:**

- `apps/web/src/app/api/v1/organizations/[organizationId]/work-units/[workUnitId]/events/route.ts`
- `packages/application/src/work.ts`, only `getWorkFollowState` and what you add beside it
- `tests/unit/web-events.test.ts`
- new `tests/integration/member-tenant-tx.test.ts`

**Implements:**

```ts
// packages/application/src/work.ts
export type WorkFollowState = { version: number; evidence: string | null };
/** One transaction: is this person still a member, and what is the state. */
export function getWorkFollowStateAsMember(
  database: AppDatabase,
  userId: string,
  organizationId: string,
  id: string,
  options?: { evidence?: boolean },
): Promise<{ context: TenantContext; state: WorkFollowState }>;
```

It uses `withMemberTenantTx` from `@ensemus/database`, and shares its body with `getWorkFollowState`, which stays as it is for the stream's first read. In the route, `currentState()` becomes:

```ts
const { context: fresh, state } = await getWorkFollowStateAsMember(database, userId, organizationId, workUnitId, asked);
// Outside the transaction, because a check can wait on the object store. Nothing has been written yet.
await getRestoreGate().assertServing(fresh);
return state;
```

`sessionStillValid`, the lifetime, the heartbeat and the errors that end a stream do not change. **Nothing else may call `withMemberTenantTx` in this milestone.**

**The existing test in `tests/unit/web-events.test.ts` must not get weaker.** Widen its pattern to `getWorkFollowState(?:AsMember)?`, keep the two reads and the `, asked` assertion, and add: the poll calls `assertServing` after the read and passes it the fresh context; the route no longer calls `resolveTenantContext`.

**Tests owned:**

- Unit, must run: the above.
- **Integration, written, unverified, real roles** (`tests/integration/member-tenant-tx.test.ts`). `QA-003`. A member sees their state, with exactly one call to `AppDatabase.transaction`, by a spy. A non-member, a removed member and a suspended member: `TenantAccessDenied` and `fn` never ran. A person in two tenants, with the same names and the same work title in each: only the asked-for tenant's rows are visible inside `fn`, in `memberships` too. **Regression for ADR-025 D3:** inside `fn`, `memberships` does not show their other membership. **The bindings inside `fn` equal those inside `withTenantTx` for the same context,** by reading `current_setting` for each `app.*` name in `tenantBindings`, so that M5's additions are covered at the merge. Capitals in the organization ID give the context the row's own spelling. A malformed ID is denied without opening a transaction. Work in another tenant answers `NOT_FOUND` for a member of this one. A rejected `fn` rolls back: the binding does not leak onto the pooled connection, and a following `withUserTx` sees no tenant.

**Faults:** the database refuses midway through the transaction; the gate closes on a poll after the read, so the stream ends and writes nothing. Both as stack or integration tests, unverified, if they cannot run in unit.

**Unverified, say so:** `tests/stack/tenant-streams.test.ts` has to pass unchanged, and `tests/measure/m2.measure.ts` has to run again to show the saving. List both under `docker_later`.

## temporal-retention: ADR-037 D6

**Owns:**

- `infrastructure/compose/temporal/setup-namespace.sh`
- new `tests/unit/temporal-retention.test.ts`
- new `tests/stack/temporal-retention.test.ts`
- new `tests/integration/retention-independence.test.ts`

**Implements.** `setup-namespace.sh` reads `ENSEMUS_TEMPORAL_RETENTION`, defaulting to `72h`. It accepts only whole hours of at least 24 (`<n>h`), and otherwise exits non-zero before touching Temporal, printing the setting's name and not its value. If the namespace is there, it runs `temporal operator namespace update --namespace default --retention "$retention"`. If not, it creates it as now. **Keep `set -eu`, the passthrough address and the wait for health as they are.** A failed update fails the job.

**Tests owned, unit, must run** (`tests/unit/temporal-retention.test.ts`, which runs the real script with `sh`, and a fake `temporal` on `PATH` in a temp directory that records its arguments, and is skipped with a clear message where `sh` is absent): nothing set creates with `72h`; a set value creates with that value; an existing namespace is updated; each of `1h`, `23h`, `0h`, `72`, `3d`, `72h; rm -rf /`, and an empty string fails before any `temporal` call that changes anything; a failing update exits non-zero; a failing create exits non-zero.

**Written, unverified:**

- `tests/stack/temporal-retention.test.ts`: `temporal operator namespace describe`, through the same sidecar other stack tests use, reports the default in a fresh stack.
- `tests/integration/retention-independence.test.ts`: **the review's one safety claim.** What `REJECT_DUPLICATE` protects has to hold with no Temporal record at all, so this drives the application services directly, in two tenants. A finished external action, sent and also failed, gets `beginAttempt` again and no attempt row and no effect result, and the same for one that is `unknown`. A finished webhook delivery run a second time changes nothing, and calls no effect handler. Use `tests/helpers/integrations.ts`. Cross-tenant: the other tenant's IDs do nothing.

**Report, do not fix:** if `retention-independence` shows a path where a second run could cause a second effect, that is a finding against ADR-027, and it goes to the owner at once.

**Unverified, say so:** `ENSEMUS_TEMPORAL_RETENTION` needs a Compose passthrough on `temporal-namespace` to be settable. List it under `docker_later`.

## proxy-warning: ADR-037 D9

**Owns:**

- `packages/telemetry/src/client-address-watch.ts` (a stub now), new `client-address-watch.test.ts`
- new `apps/web/src/server/client-address.ts`
- `apps/web/src/server/api.ts`, `apps/web/src/server/tenant.ts`: one added call each
- new `infrastructure/scripts/proxy-preflight.mjs`, `proxy-preflight-rules.mjs`
- new `tests/unit/proxy-preflight-rules.test.ts`
- new `tests/stack/client-address-warning.test.ts`

**Implements, with these exact signatures** (stubbed already):

```ts
// @ensemus/telemetry/client-address-watch
export function isNonPublicAddress(address: string): boolean;
export function createClientAddressWatch(options: ClientAddressWatchOptions): ClientAddressWatch;

// apps/web/src/server/client-address.ts, server-only
export function noteClientAddress(forwardedFor: string | null, userId: string): void;
// infrastructure/scripts/proxy-preflight-rules.mjs
export function proxyFindings(env): { code: string; setting: string }[];
```

**The watch.** Defaults: `windowMs` 10 minutes, `minIdentities` 5, `repeatEveryMs` 1 hour. Within a window, it remembers at most `minIdentities` identities, and whether it has seen one address or more. It fires when `minIdentities` different identities have come from **exactly one** address and that address is non-public. A second address in the window clears the suspicion for that window. A `null` address is ignored. Memory stays bounded, however many people arrive, and is cleared at the end of each window.

`isNonPublicAddress` must be correct, not approximate: IPv4 `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `100.64/10`; IPv6 `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped `::ffff:` forms of all those. **Anything it cannot parse is not non-public,** so that junk cannot raise a warning.

**The web tier.** `noteClientAddress` takes the first value before any comma, trimmed, with one watch per process, and logs `proxy.client_addresses_look_shared` with `{ count: identities }`, through `createLogger`. `apiRoute` calls it right after it has a session, with `request.headers.get('x-forwarded-for')`. `requireTenant` calls it after `requireActor`, using `headers()` from `next/headers`. **A failure in here must never fail the request.** It observes only people with a session, so nobody without one can raise the warning.

**The preflight.** `node infrastructure/scripts/proxy-preflight.mjs [env-file]`, defaulting to `.env`. It prints each finding, and always exits 0 unless the file cannot be read. `proxyFindings` raises:

- `PUBLIC_NAME_ON_LOOPBACK_WITH_NO_PROXY_LISTED`: `ENSEMUS_PUBLIC_URL`'s host is not `localhost` or a loopback address, `ENSEMUS_BIND_ADDRESS` is loopback or unset, and `ENSEMUS_TRUSTED_PROXIES` is empty or unset.
- `PROXY_LIST_TRUSTS_TOO_MUCH`: the list has `private_ranges`, `0.0.0.0/0`, `::/0`, or a prefix wider than `/8`.

It parses env files without any library, handling comments and quotes, and repeats no values.

**Tests owned, unit, must run:**

- The watch: 4 people then nothing; 5 people from a private address fire once; another 5 within the hour do not fire again; after an hour it can fire again; 5 people from a public address do not fire; a second address clears it; the window passing clears it; one person seen 100 times does not fire; a `null` address; 10,000 identities leave memory bounded; `onSuspected` gets only the count, and a canary address and ID appear in nothing it receives.
- `isNonPublicAddress` across every range edge, both sides: `172.15.255.255` and `172.32.0.0` are public, `100.63.255.255` is public, IPv4-mapped forms, and junk like `not-an-address`, an empty string, `1.2.3`, and `999.1.1.1`.
- `proxyFindings` for each code with a passing case on each side, and a value that must not appear in a finding.

**Written, unverified:** `tests/stack/client-address-warning.test.ts`. `proxy/Caddyfile.test` lets a test choose the address with `X-Ensemus-Test-Client`. Five people from `10.1.2.3` raise the log line in `web`'s output, and the address is not in it. Sign-in still works, and nothing is refused.

---

# Wave 2: after all of wave 1 has merged

## docs: ADR-037, all

The documents have to describe what exists, so this comes last. **Check each claim against the merged code, and leave out what did not land.**

**Owns:**

- `docs/05-operations/05-container-deployment-runbook.md`
- `docs/specifications/deployment/environment.example`
- `docs/06-delivery/05-environment-and-ci-cd.md`
- `docs/06-delivery/evidence/M1-report.md`: add a dated section only, and do not change what was reported then
- `docs/specifications/implementation-backlog.csv`: notes only, if the format has a place for them. `FOUND-01`, `FOUND-04` and `FOUND-07` **stay `partial`**, because nothing here has run in a container
- `docs/MANIFEST.json`, regenerated with `node docs/specifications/tools/regenerate-manifest.mjs`

**Writes:**

- **M6 also edits the runbook** (`docs/05-operations/05-container-deployment-runbook.md`). Add sections of your own, and change only the sentence below in the existing text, so the merge stays small.
- **Runbook, hostname and client addresses:** replace "Nothing warns you when this happens" with what now warns, what it cannot see (fewer than 5 people, or a single public address), and how to run the preflight. Keep the warning itself.
- **Runbook, a new section on traces:** off by default, `ENSEMUS_OTEL_ENDPOINT` and `ENSEMUS_OTEL_SAMPLE_RATIO`, what is in a span and what never is, that the connector worker is not traced, that no collector ships and the operator runs their own, and that Compose has no passthrough yet.
- **Runbook, a new section on Temporal retention:** what `ENSEMUS_TEMPORAL_RETENTION` does and its floor, that the setting is the authority on every start, so a change made by hand gets overwritten, that a long weekend can outlast a failed run's history at the default, and that the number is not a legal retention period.
- **Runbook, a new section on verifying a release:** the key comes from outside the folder, and what `--allow-test-key` means. **A release signed with the throwaway key is not a release.**
- **`environment.example`:** the new settings, each off or at its default.
- **`05-environment-and-ci-cd.md`:** the pin check, the scan policy and its exceptions file, and the reproducibility report and when it stops being report only.
- **M1 report, a section "After M1":** for each gap in its list, closed here, partly closed, or still open, with the commit, and an honest note that the container gates have not run on it. Still open from that list: Valkey has no user, the footprint is one reading, Temporal database backups have no recovery test (`OPS-02`), and signing-key custody.

**Tests:** `pnpm exec prettier --check` on what you touched, `pnpm check:backlog`, and the manifest regeneration.

---

# Not in a slice

**Owner-led, with no builder:** signing-key custody, including a second holder or escrow. Engaging the outside security reviewer. Legal sign-off on numeric retention (`LIFE-02`, `05-data-lifecycle.md`).

**Decisions a person must take:** see "owner decisions" in the foundation's report and "What needs outside review" in ADR-037.
