# ADR-037: Closing the hardening backlog from M1 and M2

**Status:** Proposed. D3, D4 and D5 need outside security review. No real credential has been stored or used: every test uses generated values. The foundation is in the code, and the behaviour described below is being built in the slices in [`hx-slices.md`](../../06-delivery/hx-slices.md).
**Date:** 2026-11-06
**Deciders:** Project owner; security owner for D3, D4 and D5.
**Backlog:** no new tickets. This closes follow-ups on `FOUND-01`, `FOUND-04`, `FOUND-07` and `API-13`, and reviews the retention value ADR-025 D4 left open. `OPS-04` itself stays in M8. It gets the trace wiring it depends on from here, and not its dashboards or alerts.

## Context

The [M1 report](../../06-delivery/evidence/M1-report.md) and the [M2 measurements](../../06-delivery/evidence/M2-measurements.json) named gaps that M2 and M3 did not close. Each is small, and each gets more expensive once a release exists or a real customer's traces flow. The delivery plan has no HX section. The list came with the task that started this work, and this ADR is where it is written down.

This work is written and unit tested on a machine without Docker. **Nothing here has run in a container.** Integration, stack and browser tests are written and typecheck, and they count as unverified until someone runs them. Every decision below says what is left for that run.

## Decisions

| # | Decision |
|---|---|
| **D1** | A gate builds each image twice and compares them. It reports until the Dockerfile changes are made, and then it blocks. A static check blocks now on anything unpinned. |
| **D2** | CI scans the SBOMs that `build-release.mjs` makes, with Grype, by digest. A critical finding fails it, as does a high with a fix. An exception names a person's reason and an expiry. |
| **D3** | Traces go only to a collector an operator names, and only through an allowlist at the exporter. Nothing crosses Temporal, the connector worker stays dark, and a default install does not even load the SDK. |
| **D4** | A release verifies only against a key from outside its folder. A test key can never produce a plain OK. A real signer plugs in as a command, so this code never holds the private key. |
| **D5** | One live status poll is one transaction, through `withMemberTenantTx`. |
| **D6** | 72 hours stays the default Temporal retention, and becomes a setting that can change on an existing namespace. No safety property may depend on it. |
| **D7** | Worker image size and rebuild growth are addressed by written Dockerfile guidance, and no Dockerfile changes here. |
| **D8** | The esbuild advisory goes with one scoped override. |
| **D9** | The web tier warns when many people appear to arrive from one private address, and a preflight script warns before starting. Neither refuses anything. |
| **D10** | This milestone adds no table, role, policy, outbox event, public API or domain type. |

### D1. Reproducible builds (`FOUND-01`)

**Two parts, because they fail for different reasons.**

`pnpm check:pins` is a static check, runs anywhere and blocks now. Every `FROM` and Compose image is by digest, every action is by commit, every workspace dependency is an exact version, every install in CI is `--frozen-lockfile`, and every tool container comes from `infrastructure/scripts/tool-images.mjs`. This foundation already fixed what it would have found: Syft was by tag alone, pnpm had no hash, and `.nvmrc` said `24` while the base image held 24.22.2, so CI could have tested on a different Node from the one that ships.

`reproducible-gate.mjs` builds each image twice with no cache, with `SOURCE_DATE_EPOCH` from the commit and `rewrite-timestamp=true`, and compares the manifests, then names the files that differ.

**It cannot pass today, and we know why.** The Next.js build writes a random Server Action key into the web image when it finds none, and that alone makes every web build different. The fix belongs in the Dockerfile, and it touches what ADR-025 D7 reviewed. So the gate runs with `--report-only`: it fails if a build fails, and passes when the images differ, while saying so in the log and in `report.json`. `FOUND-01` stays `partial` meanwhile. Drop the flag in `ci.yml` and `run-all-gates.sh` once it reports no difference, in the same commit as the Dockerfile change.

**Rejected: `continue-on-error`.** It hides a failed build as well, and `tests/unit/gates.test.ts` now refuses it anywhere in CI. **Rejected: a failing job until the Dockerfile changes.** It would turn every push red for a reason everyone already knows, and people stop reading a red that means nothing.

`generateBuildId` in `apps/web/next.config.ts` is now fixed by the release, since the default is random. It is a config change needing no Dockerfile.

### D2. Image scanning (`FOUND-01`)

| Choice | Reason |
|---|---|
| Grype, on the SBOM | `build-release.mjs` already makes SPDX SBOMs with Syft, from the same vendor. Scanning them means the thing scanned is the thing listed in the signed manifest. A scan cannot pass on an image that did not reach the release, because the step runs after it and fails if there is no SBOM to read |
| By digest, from `tool-images.mjs` | A scanner that changes under us changes what the gate means. Grype and Syft are Apache-2.0 and run only in CI, so they ship nowhere. `check-licenses.mjs` covers only production npm packages, and that is the right scope for them |
| Outside the air-gap gate | Grype has to fetch its vulnerability database. The shipped stack still makes zero outbound attempts, and a Sovereign operator can run the same scan from an imported database |

**The default policy** fails on any critical, and any high with a fix available. Other highs and everything below are listed in `.local/release/scan-*.json` and counted in the log, and do not fail. A Debian base image usually has highs with no fix, and failing on those would mean a permanent exception list that nobody reads. **This is a risk decision and it is the owner's** (see below). `infrastructure/security/image-scan-exceptions.json` holds exceptions: vulnerability, package, a reason and an expiry. One that has expired fails the gate, and so does one that no longer matches anything, so the list cannot rot.

### D3. OpenTelemetry (`FOUND-04`, ahead of `OPS-04`)

The docs ask for OpenTelemetry behind an internal adapter (`03-intelligence/07-evaluation-and-observability.md`), with "policy-safe attributes" (`05-operations/01-slos-and-reliability.md`), and absolute rules forbid raw content in telemetry and any hosted Ensemus telemetry.

**Off unless asked.** `loadTracingConfig` in `@ensemus/config` is off unless `ENSEMUS_OTEL_ENDPOINT` is set. A default install does not load the SDK, because `@ensemus/telemetry/tracing-sdk` is imported dynamically and only when on. `@ensemus/telemetry/tracing` needs only the API, which does nothing with no provider, so `withSpan` costs a call. The endpoint refuses credentials, a query and a fragment. There is no setting for headers, because the only thing to put there is a secret.

**Allowlist at the exporter, not at the call site.** Next.js creates its own spans once a provider exists, and those carry `http.target` and `http.url`, and an invitation link has its token in its path. Next.js also records exceptions on spans, and an exception event carries the message. So `createRedactingExporter` wraps the real exporter, and `redactSpan` keeps only:

- the logger's `SAFE_FIELDS`, under the same value check, plus `http.request.method`, `http.response.status_code` and `next.route`;
- a span name that either passes `isSafeValue`, or is exactly `<method> <next.route>`. Anything else becomes `next.internal`;
- the status code, never its message;
- no events, and no link attributes.

A route pattern comes from our source tree, so it holds `[organizationId]`, and never an ID. The resource holds `service.name` and the release, and no host or process details.

**Rejected: `@temporalio/interceptors-opentelemetry`.** Its workflow interceptors run inside the workflow and put trace context in its headers, and the docs for its OpenTelemetry v2 package warn that its histories are incompatible with the v1 package's, and can fail to replay. Replay is a gate, and ADR-024 lets only IDs cross Temporal. So **no trace context crosses Temporal**. An Activity's span comes from a plain activity interceptor, and it carries the same IDs as the logs. Tiers are joined by those IDs, not by a shared trace. Workflow code may not import any of this, and lint enforces it.

**No propagator is registered.** A client's `traceparent` is not believed, so a client cannot choose a trace ID or claim a sampling decision.

**The connector worker and the egress gateway stay dark.** ADR-027 D5 gives them a network with no route out, and a collector on it would be a route out. Their logs are unaffected. Whether that is ever worth changing is a question for the outside reviewer.

**Versions.** `@opentelemetry/*` 2.12.0, API 1.9.1 and the OTLP exporter 0.223.0, all Apache-2.0. The 3.x line came out 17 days ago, so it has had little time in use, and nothing here needs it. `check-licenses.mjs` already allows Apache-2.0 and BSD-3-Clause for what they bring in. Only metrics are not wired: nothing yet says which ones `OPS-04` needs.

**What this costs.** A new way out of the web tier and the main worker, when an operator asks for one. Their networks must reach the collector, and Compose does not provide one. That is left for the Docker run.

### D4. Release trust (`FOUND-07`)

The gap the M1 report names is a throwaway key, and swapping in a real key alone would not close it. Today `verify-release.mjs` defaults to the public key sitting in the release folder, so whoever can change a manifest can also change the key beside it and get a pass. And a release signed with a test key prints `OK`.

- **A trusted key comes from outside the folder.** `verify-release.mjs <folder> <public-key.pem>` still works. With no key named, it fails.
- **A test key never gives a plain OK.** A manifest marked with the throwaway marker fails unless the caller passes `--allow-test-key`, and then it prints `OK (test key, not a release)`. A manifest that is not so marked fails with that flag, so it cannot be used to skip the key check.
- **The manifest names its key.** `signing_key_id`, the SHA-256 of the public key's SPKI bytes, is what `05-environment-and-ci-cd.md` asks for, and the verifier compares it with the key it was given.
- **A real signer is a command.** With `ENSEMUS_RELEASE_SIGNER_COMMAND` and `ENSEMUS_RELEASE_PUBLIC_KEY_FILE` set, `build-release.mjs` passes the manifest on standard input and reads a base64 signature back. So the private key never enters this script, whatever holds it. Hardware, a KMS or a person are all possible, and that is why custody can stay undecided. It checks the signature before it writes anything, and refuses if it does not verify.
- **Unset still means a throwaway key,** marked as such, so CI keeps working and cannot be mistaken for a release.

**The tests use a generated key and a local fake signer that lives with the tests.** This does not close `FOUND-07`: custody is the owner's, and the M1 report's second holder or escrow is still open. ADR-025 D8's other limit stands too. The verifier does not check loaded images against the manifest, and `COMM-04` in M6 brings that. M6's `build-bundle.mjs` signs its own manifest, and it says it follows `build-release.mjs` on the throwaway key, so the final merge has to check the two agree on the marker and the verifier's refusals.

### D5. One transaction per live status poll (`API-13`)

The M2 measurements show about 9.9 statements a second for each open stream. Each poll opens two transactions: one with only the user bound, to re-check the membership, and one with the tenant bound, to read the version.

**`withMemberTenantTx(database, userId, organizationId, fn)` does both in one.** It binds the user, reads the membership under the self-only policy (ADR-025 D3), binds the tenant from that row, and runs `fn`. Both use one list, `tenantBindings`, so `fn` sees just what `withTenantTx` would show, and a binding added later reaches both. **M5 adds two bindings to `withTenantTx`, so the final merge has to put them in that list.** The tenant comes from the membership row and not from the request, which is the pattern `withWebhookEndpointTx` already uses (ADR-027 D4). It adds a second way to bind a tenant to the rule that all tenant access goes through `withTenantTx`, so **it needs outside review**.

**The restore gate stays outside the transaction, and after it.** A gate check can wait on the object store, and a transaction must not. It runs on the fresh context this returns, so a removed member still fails before the gate, and what the transaction read is thrown away if the gate closes. Nothing is written to the stream until both have passed.

**Only the poll changes.** Everything else uses `resolveTenantContext` as before: a page does many things in many transactions, and a shared context is what it wants. By reading the code, this should save three statements and one transaction a poll (a `COMMIT`, a `BEGIN` and a second binding of the user). That is not yet measured: `tests/measure/m2.measure.ts` has to run again in a container.

### D6. Temporal retention

ADR-025 D4 called 72 hours a starting value that needed review. Here is that review.

| What depends on a closed run being kept | What happens when it has gone | Verdict |
|---|---|---|
| `REJECT_DUPLICATE` for external actions and webhooks | An outbox event redriven after retention can start a second run | **Must be harmless.** ADR-027 says the trigger holds regardless. The retention slice proves it at the attempt level, for a finished intent and a finished delivery |
| `probeWorkflow` in upkeep | `NotFound` reads as closed, and upkeep marks the work failed | The same answer as a closed run. The sweep runs every 15 minutes, so this needs nothing like 72 hours |
| An operator reading a failed run | History is gone | Acceptable. Durable state and audit are in PostgreSQL, and history holds IDs and sealed payloads, so little can be learned from it. **72 hours means a long weekend can lose it** |
| Replay tests | None: the corpus is checked in | No dependency |
| An open run waiting on approval | Retention applies only after a run closes | No dependency |
| Deleting a tenant (`LIFE-01`) | IDs stay in Temporal's database for up to the retention period | A limit that erasure wording has to allow for. M8 |

**Decision.** No safety property may depend on retention, so it can be set from an operator's needs. `05-data-lifecycle.md` says numeric retention defaults need legal and customer sign-off, so 72 hours stays as the technical default, and it does not become a promise. It is now `ENSEMUS_TEMPORAL_RETENTION`, in whole hours, at least 24, which is Temporal's own usual minimum. The setup script used to apply it only when it created a namespace, so a value could never change. It now updates an existing one. This needs a Compose passthrough to be settable, which is left for the Docker run. Until then, the default holds.

### D7. Image size and rebuild disk growth

The owner's machine is short of disk, and this work may not change a Dockerfile. So [the guidance](../../05-operations/07-image-size-and-rebuild-guidance.md) says what to change, and why, for when someone can build and measure. Two things came from reading the installed code. `@temporalio/worker` requires `webpack` at load, so deleting it breaks the worker, although the bundle is prebuilt. And `COPY . .` before `pnpm install`, in both Dockerfiles, is why every source change rewrites the dependency tree. No saving is claimed, because none has been measured.

### D8. The esbuild advisory

`drizzle-kit` reaches esbuild 0.18 through `@esbuild-kit`, which is under GHSA-67mh-4wv8-2f99 for its development server. An override in `pnpm-workspace.yaml` moves only that path, and only to the 0.25.12 `drizzle-kit` itself already uses, so the lockfile loses a version and gains none. `drizzle-kit --version` still runs, and `pnpm audit` no longer lists it. It affected developers only, and M1 confirmed esbuild is not in the web image.

**Another advisory has appeared since:** `minimatch` through `eslint` (GHSA-g3hv-75wg-m249), moderate, dev only. Its fix is a major version away from what eslint asks for, so this was left alone and reported, and the audit gate at `--prod --audit-level high` does not see it.

### D9. A proxy that looks unnamed

The runbook says this about a host-level proxy with `ENSEMUS_TRUSTED_PROXIES` empty: "Ten wrong passwords from anyone refuse sign-in for everyone for up to a minute. Nothing warns you when this happens." Two checks, and neither refuses anything:

**At runtime.** The web tier never sees the setting, and it should not have to, because a setting naming the wrong address is as bad as an empty one. It looks at the result. `createClientAddressWatch` is fed each authenticated request. When enough different people appear within a window, all from exactly one address, and that address is not public, it logs `proxy.client_addresses_look_shared` with a count. Only a non-public address counts, because many people behind one public address is an ordinary office. Direct clients on a LAN have many addresses, so they do not match. The defaults are 5 people in 10 minutes, repeated at most hourly. Those are starting values, chosen by reasoning about the two cases above and not from data. **A deployment with 4 people and a proxy in front gets no warning,** and sign-ins can still be refused. The runbook has to say so.

It holds no address or ID after its window, and logs neither. Each replica watches alone.

**Before starting.** `proxy-preflight.mjs` reads an env file and warns about what cannot be right: a public name in `ENSEMUS_PUBLIC_URL` with the port bound to loopback, which is the default, means something else must be forwarding to it, and the list is empty. It also warns about a list that trusts too much, such as `0.0.0.0/0` or `private_ranges`. The runbook already calls that risky.

**Rejected: refusing to start.** A warning about a guess must not take a running deployment down. **Rejected: passing the setting to the web tier and comparing.** That cannot catch a wrong address, which the runtime check does.

### D10. No schema

D5 uses existing tables and policies, and nothing else here touches the database. So there are **no migrations**, and the `0800` range this milestone was given stays unused. There are no outbox events, no OpenAPI changes and no domain types either.

## Consequences

**Good.** Four named gaps in `FOUND-01`, `FOUND-04` and `FOUND-07` get code, tests and a gate, and each one that remains has a stated reason. A status poll costs less, and a person gets told about a misconfiguration that used to be silent.

**Bad.** New production dependencies in a security-relevant package, although they load only when asked for. A gate that reports for now, which only helps if someone reads it. Two more CI costs: a scan, and a job with two no-cache builds of each image. **The reproducible gate is heavy on disk,** so `run-all-gates.sh` on the owner's machine pays for it. A heuristic warning can be wrong in both directions.

## What needs outside review

1. **D3:** the allowlist in `redactSpan` and the rule that the connector worker stays dark. Traces are a new way out of the web tier.
2. **D4:** the verifier's refusals, and the signer command's contract, before any custody choice relies on them.
3. **D5:** `withMemberTenantTx`, as a second way to bind a tenant.
4. **The Server Action key in D1.** The fixed placeholder for the build stage changes what ADR-025 D7 reviewed. It is written as guidance, not applied.

## Approvals

| Role | Name | Decision | Date |
|---|---|---|---|
| Project owner | | | |
| Security owner (D3, D4, D5) | | | |
