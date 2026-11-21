# M11B slices

Twelve builders, in two waves, and **no file has two owners**. Eleven start at once from the foundation commit. The twelfth starts once they are merged. Everything they must agree on is already decided in [ADR-034](../00-foundation/adr/ADR-034-skills-sandbox-marketplace.md) and already typed in the code. Read that ADR first, because it holds the reasons.

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

## Fixed: nobody changes these

| What | Where |
|---|---|
| Migrations, RLS, roles and triggers. **No builder adds a migration, and nobody edits `migrations/meta`.** The final merge stitches the journal | `packages/database/migrations/0650_*`, `0651_*`, `packages/database/src/schema-skills.ts`, `infrastructure/compose/postgres/provision-marketplace.sql` |
| States, transitions, codes and pure rules | `packages/domain/src/skill.ts`, `marketplace.ts`, `skill-events.ts`, `sandbox.ts` (the sandbox-policy slice fills in `compileSandboxPolicy` there, and changes nothing else) |
| Permissions, error codes and wording | `packages/domain/src/policy.ts`, `packages/application/src/errors.ts`, `apps/web/src/lib/messages.ts` |
| The manifest and bundle format, requests | `packages/contracts/src/skills.ts` |
| Runner protocol | `packages/sandbox/src/protocol.ts` |
| Ports and shared dependency types | `packages/application/src/skill-ports.ts`, `packages/workflows/src/skill-deps.ts` |
| Temporal input shapes and queue names | `packages/workflows/src/schemas.ts`, `constants.ts`, `workflows.ts` (re-exports) |
| Dispatcher and worker wiring | `workers/workflow/src/dispatcher.ts`, `main.ts`, `sandbox-worker.ts`, `sandbox-runner.ts`, `marketplace-operator.ts`, `scripts/build.mjs` |
| Settings | `packages/config/src/index.ts`, `apps/web/src/server/skill-runtime.ts` |
| Import rules | `eslint.config.mjs` |
| Exports and dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package.** Nothing in this milestone needs one | every `package.json`, `packages/application/src/index.ts`, `packages/database/src/index.ts`, `apps/web/next.config.ts` |
| Shared test helpers and rule tests | `tests/helpers/skills.ts`, `tests/unit/skill-rules.test.ts`, `tests/integration/skills-schema.test.ts`, `packages/domain/src/skill-rules.test.ts`, `packages/config/src/skills.test.ts` |
| Decisions | ADR-034, this file |

A bug in any of these is reported, not fixed in passing.

## What runs where

This milestone is **code only**. The owner decides later when to dockerize and test.

| Rule | Detail |
|---|---|
| **Never** | `docker` or `docker compose` in any form. `pnpm test:integration`, `test:stack`, `test:browser`, `test:upgrade`. Any gate that needs a container. Editing a Dockerfile or a compose file |
| **Allowed** | `pnpm exec prettier`, `eslint`, typecheck, `pnpm --filter @ensemus/web exec next typegen`, unit and replay tests (`pnpm exec vitest run --project unit <paths>`, `pnpm test:replay`). Check only what you changed |
| **Memory** | 16 GB shared with many agents. Every heavy command goes through the slot wrapper you were told about. Exit 75 means no slot yet, so run it again. Never start a dev server or a watch mode |
| **Still write them** | Integration, stack and browser tests for what you build, and make them typecheck. They count as **unverified**: say so, and never report them as passing |
| **Disk** | Below 3 GB free on C:, stop and report. Delete nothing outside your worktree |
| **Time** | The owner stops at 22:00 local. Past 21:15, commit what typechecks and list the rest as not done |
| **Migrations** | 0650 and 0651 are not in the journal yet, so nothing can apply them before the final merge. That is expected. Do not edit the journal, and do not try to work around it |
| **Replay** | Capturing a history needs Temporal, so no history is captured here. Write the capture test and the corpus test that lists the files, keep the corpus test green with `skipIf` on a missing file, and report the histories as owed |

## Build order inside the tree

Stubs throw `NOT_IMPLEMENTED`, and each slice can be tested without the others.

- `tests/helpers/skills.ts` walks a version to any state through the real triggers (`seedVersion`), and seeds signers, packages and runs. `provisionMarketplaceRole()` creates the operator role for a test. Publishing a seeded version takes a second person's context.
- Where your code calls another slice's stub at runtime, your unit tests use `vi.mock` for that module, or inject a double. Wave 2's acceptance slice proves the real parts together.
- `@ensemus/skills/testing` and `@ensemus/sandbox/testing` are stubs until their slices land. In your own unit tests, mock them or build what you need inline.

## Every slice

- Denied and cross-tenant tests first, then the code. Two tenants, same names, real roles. **Every feature has denied and cross-tenant tests**, and security-sensitive code gets the same care as if it were being run today.
- All tenant access goes through `withTenantTx`. A worker uses `createServiceContext(organizationId)`, with the ID from the workflow input, and re-loads rows by `(organization_id, id)`.
- Only IDs, enums and counters cross Temporal. Workflow files import only `@temporalio/workflow` and types, and their decisions live in a small pure module (as `review-wait.ts` does), so a unit test can reach them. New histories join `tests/replay/histories/`.
- The web tier has no path to Temporal, a runner or a review key. Commit to the outbox.
- A service that takes a `SkillFeatureGate` asks it first, and answers `FEATURE_NOT_ENABLED`.
- Check permission in the service with `can(context.role, capability)`. Answer `FORBIDDEN` for a person without it, and `NOT_FOUND` for anything in another tenant or that does not exist, the same way, so no ID can be probed. Turn SQLSTATEs in `SKILL_SQLSTATE` into the right `AppError` with `pgCode`.
- Stored reasons are codes from the fixed lists. **Never store or log text from a bundle, a job, a reviewer or a provider.** Log IDs and enums.
- Generated test values only: keys made on the spot, `@example.invalid` addresses. No real credential. A fake lives with its test and is never a default code path.
- **Never describe the sandbox as isolated, secure or safe,** in code, copy, docs or a test name. Say what was checked.
- No prices, SLAs, RTO/RPO numbers, certifications or legal terms. Nothing here takes a payment.
- Follow the house comment style: say why, in plain sentences.
- Commit early, with several `-m` flags, the last being `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`. Do not push. Finish with `git checkout --detach`.

---

# Wave 1: all eleven start at once

## skill-format: `EXP-04`

The package format, signatures, attestations and supply-chain checks. Pure code over bytes, and the first thing that touches what a stranger wrote. `SKL-TS-01`, `SKL-TS-02`, `MKT-TS-03`.

**Owns:** `packages/skills/src/bundle.ts`, `signature.ts`, `sign.ts`, `review.ts`, `supply-chain.ts`, `testing/index.ts`, new `packages/skills/src/*.test.ts`, new `packages/skills/scripts/skill-tool.ts`.

**Implements, with these exact signatures** (all stubbed):

```ts
// @ensemus/skills/bundle
SKILL_DIGEST_DOMAIN = 'ensemus.skill.digest.v1\0'
manifestDigest(manifest: SkillManifest): string
parseSkillBundle(bytes: Buffer): BundleCheck
matchesSkillSchema(schema: unknown, value: unknown): boolean
readFixtures(parsed: ParsedSkillBundle): ReadonlyArray<{ position; input; expectedOutput }> | null
runContractTests(parsed: ParsedSkillBundle): { total; passed; firstFailed: number | null }
// @ensemus/skills/signature
keyIdOf(publicKey: Buffer): string
isValidPublicKey(publicKey: Buffer): boolean
signingPayload(digest: string): Buffer
verifySkillSignature({ digest, signature, publicKey }): boolean
checkTenantSignature({ digest, keyId, signature, lookup }): 'ok' | 'SIGNER_UNTRUSTED' | 'SIGNER_REVOKED' | 'SIGNATURE_INVALID'
// @ensemus/skills/sign (never imported by anything that ships)
signSkillDigest({ digest, privateKeyPem }): Buffer
signAttestation({ attestation, privateKeyPem }): Buffer
// @ensemus/skills/review
attestationPayload(attestation: ReviewAttestation): Buffer
parseApprovedAttestation(value: unknown): ReviewAttestation | null
verifyApprovedAttestation({ attestation, signature, reviewKeys, facts }): boolean
// @ensemus/skills/supply-chain
checkManifestSupplyChain(manifest): 'ok' | 'LICENSE_NOT_ALLOWED' | 'DEPENDENCY_NOT_ALLOWED'
policyForManifest(manifest, ceilings): { ok: true; policy; policyHash } | { ok: true; policy: null } | { ok: false; code }
// @ensemus/skills/testing
generateTestKey(): TestKeyPair
buildTestBundle(options: TestBundleOptions): { bundle; bytes; digest }
```

**Things to get right:**

- `digest = sha256(SKILL_DIGEST_DOMAIN + canonicalJson(manifest))`, with `canonicalJson` from `@ensemus/domain/approval`. Signature is Ed25519, from `node:crypto`, over `signingPayload(digest)`.
- `parseSkillBundle` order: `bytes.length > SKILL_BUNDLE_MAX_BYTES` → `BUNDLE_TOO_LARGE`; UTF-8 and `JSON.parse` → `BUNDLE_MALFORMED`; `skillBundleSchema` → `MANIFEST_INVALID`, or `SCHEMA_NOT_SUPPORTED` if that was the failing message; a `files` path that is not on the manifest → `FILE_UNDECLARED`, duplicates → `FILE_DUPLICATED`, a declared file with no content → `FILE_MISSING`; hash and size → `FILE_HASH_MISMATCH` / `FILE_SIZE_MISMATCH`; every manifest-named path (instructions, entry, fixtures) must be declared → `FILE_MISSING`. A file name with `__proto__` must be harmless: use `Map`, never an object keyed by what a stranger wrote. Sum declared sizes before decoding.
- `matchesSkillSchema` reads exactly `SKILL_SCHEMA_KEYWORDS`. No regular expressions and no recursion past 8. A keyword it does not know is a non-match. It is a small interpreter, and it must not throw on any input.
- `verify*` functions answer `false` on any failure and never throw. A signature that is not 64 bytes, a key that is not 32, or a mangled attestation is `false`.
- `checkTenantSignature`: `keyIdOf(publicKey)` must equal `keyId`, or it is `SIGNER_UNTRUSTED`, so a row cannot name someone else's key.
- `verifyApprovedAttestation` checks the reviewer's key is in `reviewKeys`, `keyIdOf` of it matches the attestation's `reviewerKeyId`, the verdict is `approved`, `reviewCanApprove` holds, the signature verifies over `attestationPayload`, and every field in `facts` matches.
- `skill-tool.ts` is a publisher's tool, run by hand with `node --experimental-strip-types`: `keygen <dir>`, `pack <dir> --key <file> --out <file>`, `verify <file> --public-key <base64>`. It reads a private key from a path it is given, and never prints it.

**Tests (unit, must run and pass):** a good bundle round-trips, and each of these is refused with its own code: every path shape in `tests/unit/skill-rules.test.ts`, a changed file byte, a changed manifest field after signing, a signature from another key, a signature over another digest, a package signature replayed as an attestation (domain prefixes differ), a revoked signer, an unknown signer, a declared file with no content, content with no declaration, a licence off the list, oversize at each stage, deep JSON, `__proto__` in JSON keys and file names, an attestation for another digest, with a reviewer not configured, and with verdict `rejected`.

## sandbox-policy: `EXP-05`

The compiled policy and the OCI spec. Pure and fully testable with no runtime. `SBX-TS-01` to `SBX-TS-05` at spec level. A test here proves what the spec says, and never that a runtime enforces it. Do not claim otherwise.

**Owns:** `compileSandboxPolicy` in `packages/domain/src/sandbox.ts` (that function's body only), new `packages/domain/src/sandbox-policy.test.ts`, `packages/sandbox/src/oci.ts`, new `packages/sandbox/src/oci.test.ts`, new `packages/sandbox/src/seccomp.ts`, `packages/sandbox/src/seccomp.test.ts`.

**Implements:**

```ts
// @ensemus/domain/sandbox
compileSandboxPolicy(request: SandboxPolicyRequest, ceilings: SandboxLimits): CompiledSandboxPolicy
// @ensemus/sandbox/oci
buildOciSpec(policy: SandboxPolicy, paths: OciJobPaths): OciSpec
SANDBOX_JOB_ENVIRONMENT
```

**Things to get right:**

- `compileSandboxPolicy` refuses, in this order: a runtime not on `SANDBOX_RUNTIMES` (`RUNTIME_NOT_SUPPORTED`), `network.mode` other than `none` (`NETWORK_NOT_ALLOWED`), and any limit over its ceiling or under `SANDBOX_MINIMUM_LIMITS` (`LIMITS_OVER_CEILING`). It never narrows. `policyHash` is `sandboxPolicyHash(policy)`.
- `buildOciSpec`: namespaces `pid`, `network` (no path, so empty), `ipc`, `uts`, `mount`, `user`, `cgroup`. Root read-only. Mounts: `proc`, a minimal `/dev` as tmpfs with `nosuid,noexec`, `/skill` bind read-only with `nosuid,nodev,noexec`, `/tmp` tmpfs sized to `tmpfsMb` with `nosuid,nodev,noexec`, and **nothing else**. Bind `rbind`, never from a path that is not `paths.skillDir`.
- `env` is exactly `SANDBOX_JOB_ENVIRONMENT`, whatever the process's own environment holds. All capability lists empty. `noNewPrivileges: true`. uid and gid non-zero. `memory.swap` equals `memory.limit`. `pids.limit` from the policy. `RLIMIT_CPU` from `cpuMs`, rounded up to whole seconds, `RLIMIT_NOFILE` small, `RLIMIT_CORE` zero. `maskedPaths` and `readonlyPaths` as a container runtime's defaults. `args` run `node <entry>` with `<entry>` under `/skill`, and never go through a shell.
- `seccomp.ts`: `defaultAction: SCMP_ACT_ERRNO` with an allowlist of what `node24` needs. It must not allow `ptrace`, `mount`, `umount2`, `setns`, `unshare`, `bpf`, `keyctl`, `add_key`, `request_key`, `init_module`, `finit_module`, `kexec_load`, `perf_event_open`, `userfaultfd`, `socket` with a network family if the argument filter allows it, `process_vm_readv`, `process_vm_writev`. Whether the list is enough for Node to start can only be proved on a real runtime. Say so, and list it as owed.

**Tests (unit, must run and pass):** refuses each over-ceiling limit and each under-minimum one, refuses a `network.mode` of `allowlist` and `host` and an unknown runtime, the hash changes with each field, and the spec has an empty network namespace, no writable mount but `/tmp`, an environment that ignores `process.env` (set a canary in it for the test), no capabilities, swap equal to memory, and no mount from anywhere else. An entry trying `../` or an absolute path is refused, even though the manifest contract already refuses it.

## sandbox-runner: `EXP-05`

The runner process, its client, and the probe. It starts jobs and holds nothing else. `SBX-TS-01` to `SBX-TS-07`, `SBX-TS-06` in full, and the rest at unit level with a scripted runtime, with real enforcement owed under docker_later.

**Owns:** `packages/sandbox/src/runner.ts`, `client.ts`, `probe.ts`, `testing/index.ts`, new `packages/sandbox/src/probe-jobs.ts`, `packages/sandbox/src/runner.test.ts`, `client.test.ts`, `probe.test.ts`.

**Implements:**

```ts
// @ensemus/sandbox/runner
createOciCliRuntime({ binary, stateDir }): ContainerRuntime
createSandboxRunnerServer(config: SandboxRunnerConfig): Server
// @ensemus/sandbox/client
createRunnerClient({ url, token, fetch? }): SandboxRunnerPort
// @ensemus/sandbox/probe
runIsolationProbe({ runtime, rootfs, workRoot, ceilings, now? }): Promise<IsolationProbeReport>
// @ensemus/sandbox/testing
createScriptedRunner(script), passingProbeReport(), createScriptedRuntime(script)
```

**Calls:** `buildOciSpec` (the sandbox-policy slice: mock it in your tests), `sandboxPolicyHash` and `probePassed` from `@ensemus/domain/sandbox`, everything in `./protocol`.

**Things to get right:**

- Before reading a body: bearer token in constant time (`crypto.timingSafeEqual` on hashes), and `content-length` against `RUNNER_MAX_REQUEST_BYTES`, then count as you read anyway. Wrong token is 401 with no body. No runtime configured is 503 on jobs and probe, and `/healthz` says only whether the process is up.
- A job: parse with `runnerJobRequestSchema`, refuse a policy over `config.ceilings` or whose `sandboxPolicyHash` is not `policyHash`, and hold at most `maxConcurrentJobs` (503 past that). Write files under `workRoot/<jobId>` after checking each path against `skillPathSchema`'s rule again, with `O_NOFOLLOW` and `O_EXCL`, directories `0700`. Write `config.json` from `buildOciSpec`. Run. Return `runnerJobResponseSchema`. Remove the directory in `finally`, and clear `workRoot` at start.
- The wall limit is enforced here, by killing the job, because nothing else stops a job that only sleeps. Output past `outputKb` is counted, and the job is killed with `output_limit`. Standard error is counted and dropped, never buffered.
- `createOciCliRuntime`: `execFile` with an array and never a shell. Sets the child's own `env` to `{}`. Reads `memory.peak` and `cpu.stat` where the runtime exposes them, and reports 0 rather than guessing where it does not. Maps an OOM kill to `memory_limit` and SIGXCPU or the CPU limit to `cpu_limit`. Aborting kills and removes the container, and a job can never outlive the request.
- A dropped connection aborts the job. A job finishes before the response is written.
- The client maps every failure to `SandboxRunnerUnavailable('RUNNER_UNREACHABLE')`, and 503 to `RUNNER_NOT_CONFIGURED`. An answer that does not fit the protocol counts as no answer, and its body is never quoted.
- The probe: one job per check, with payloads in `probe-jobs.ts`. A check passes only on seeing the forbidden thing fail: a job that crashes first fails it. Payload output is a JSON object of booleans and nothing else, and anything else fails the check. Never log what a job printed.
- Logs are job IDs and enums. Lint keeps the database, the store and every credential out of here.

**Tests (unit, must run and pass, with `createScriptedRuntime` and a real local HTTP server):** a wrong token, no token, an oversized declared and undeclared body, a malformed job, a policy over a ceiling, a hash mismatch, each path shape including symlink-following, concurrency over the limit, no runtime configured refusing everything (`SBX-TS-06`), the job directory gone after success, failure and abort, output over the limit, an abort reaching the runtime, the environment given to the runtime's spawn empty (assert with a canary), and probe checks failing on a crash, on a missing answer, on a forbidden thing succeeding and on extra output.

**Owed under docker_later, say so:** that any of this holds on a real runtime.

## skill-catalog: `EXP-04`

Signers, packages, uploads, publishing and the one answer to "may this be used". `SKL-TS-03`, `SKL-TS-04`, `SKL-TS-05`.

**Owns:** `packages/application/src/skills.ts`, new `packages/application/src/skills.test.ts`, new `tests/integration/skill-catalog.test.ts`.

**Implements, with these exact signatures** (all stubbed):

```ts
addTrustedSigner(database, context, gate, { displayName, publicKey }): Promise<SkillSignerView>
listTrustedSigners(database, context): Promise<readonly SkillSignerView[]>
revokeTrustedSigner(database, context, { signerId, expectedVersion }): Promise<void>
createSkillPackage(database, context, gate, { name, displayName, contentClassification? }): Promise<SkillPackageView>
listSkillPackages(database, context, { after?, limit? }): Promise<SkillPackagePage>
getSkillPackage(database, context, packageId): Promise<SkillPackageView>
updateSkillPackage(database, context, { packageId, expectedVersion, displayName?, state?, contentClassification? }): Promise<SkillPackageView>
uploadSkillBundle(database, store, context, gate, { packageId, bytes }): Promise<SkillVersionView>
listSkillVersions(database, context, packageId): Promise<readonly SkillVersionView[]>
getSkillVersion(database, context, skillVersionId): Promise<SkillVersionView>
publishSkillVersion(database, context, { skillVersionId, expectedVersion }): Promise<SkillVersionView>
yankSkillVersion(database, context, { skillVersionId, expectedVersion, code }): Promise<SkillVersionView>
resolveSkillVersionForUse(database, context, skillVersionId): Promise<UsableSkillVersion | { ok: false; denial: SkillUseDenial }>
```

**Calls:** `emit`, `appendAudit`, `ObjectStore`, `skillBundleObjectKey`, `skillUseDenial`, `can`. Event names from `@ensemus/domain/skill-events`.

**Things to get right:**

- Capabilities: `skill.manage` for signers, packages, uploads and yanks; `skill.publish` for publishing. Any member can read. Everything audited with `appendAudit`, codes and IDs only.
- A public key goes through a length check here (32 bytes, else `SKILL_SIGNER_KEY_INVALID`). The key's ID is SHA-256 of it. A key already on file, revoked or not, answers `SKILL_SIGNER_EXISTS`.
- `revokeTrustedSigner`, one transaction: the signer, then every tenant-origin `verified` or `published` version with that key to `yanked` with `SIGNER_REVOKED`, each with its event. A marketplace copy stays, because its trust comes through its listing.
- `uploadSkillBundle` follows `addArtifact`'s order, with the version's ID as the blob's: `blob_lifecycle` marker, then bytes, then the row, `skill_version.uploaded` and removing the marker in one transaction. A repeat of the same bytes (`bundleSha256`) returns the existing row. A disabled package or a marketplace-origin package refuses an upload.
- `publishSkillVersion` refuses a service context with `FORBIDDEN`, and the uploader with `SKILL_PUBLISH_SAME_PERSON`, before the table does. Map ES003 and the check violation to `SKILL_VERSION_NOT_PUBLISHABLE`. Emit `SKILL_VERSION_PUBLISHED`.
- `yankSkillVersion` only moves `verified` or `published`. Emit and notify the uploader.
- `updateSkillPackage` refuses a classification change on a marketplace copy, and a classification change that would lower it to `public` needs `skill.publish`, because that is what makes it submittable.
- `resolveSkillVersionForUse` reads everything in one transaction, and answers `NOT_PUBLISHED` for anything in another tenant or that does not exist. `listingDelistMode` is read from `marketplace.listings`, which this tenant can see once it has an installation.
- All views build `toolBoundaries` from the stored manifest, and treat a missing one as empty. Text from a manifest is shown, never interpreted.

**Denied and fault tests (integration, unverified):** another tenant's package, version and signer are `NOT_FOUND` for every function, a member without the capability gets `FORBIDDEN`, an uploader cannot publish, a service context cannot publish, a yank stops `resolveSkillVersionForUse` on the next call, a disabled package and a revoked signer each deny, a stale version answers `VERSION_CONFLICT`, oversize bytes store nothing, the same bytes twice make one row and one object, a crash between bytes and row leaves no version and a marker (`store.put` throwing, then a `insert` throwing).

**Unit tests that must run:** anything you can pull into a pure function, such as view mapping and input checks.

## skill-verification: `EXP-04`

The worker side: check a bundle, run its tests, and settle the version. `SKL-TS-01`, `SKL-TS-02`.

**Owns:** `packages/application/src/skill-verification.ts`, `packages/workflows/src/skill-verification-workflow.ts`, `skill-verification-activities.ts`, new `skill-verification-step.ts`, `skill-verification-step.test.ts`, `skill-verification-activities.test.ts`, new `tests/integration/skill-verification.test.ts`, `tests/replay/capture-skill-verification.test.ts`, `tests/replay/skill-verification-corpus.test.ts`.

**Implements:**

```ts
// @ensemus/application
beginSkillVerification(database, context, { skillVersionId }): Promise<VerificationSubject | null>
rejectSkillVersion(database, context, { skillVersionId, code }): Promise<void>
recordSkillTestRun(database, context, input: SkillTestRunInput): Promise<void>
markSkillVersionVerified(database, context, { skillVersionId, facts }): Promise<'verified' | 'rejected'>
createFixtureRuns(database, context, { skillVersionId, digest, policy, policyHash, fixtures }): Promise<readonly string[]>
loadFixtureRunResults(database, context, { skillVersionId }): Promise<ReadonlyArray<{ position; sandboxRunId; status; output }>>
// @ensemus/workflows
skillVerificationWorkflow(input: SkillVerificationInput): Promise<SkillVerificationOutcome>
createSkillVerificationActivities(deps: SkillActivityDeps) => { checkSkillBundle, finishSkillVerification }
```

**Calls:** `parseSkillBundle`, `runContractTests`, `readFixtures`, `matchesSkillSchema` (skill-format), `checkTenantSignature`, `verifySkillSignature`, `verifyApprovedAttestation`, `checkManifestSupplyChain`, `policyForManifest`. `sandboxRunWorkflow` as a child, by `sandboxRunWorkflowIdFor`. Mock what is stubbed.

**The flow:**

- `checkSkillBundle`, on the platform queue: `beginSkillVerification` (null means finished). Read the bytes, and a read failure of any kind rejects with `BUNDLE_UNAVAILABLE` only after Temporal's retries, so let it throw until then. Hash against `bundleSha256` (`BUNDLE_HASH_MISMATCH`). `parseSkillBundle`. Manifest name must equal the package's (`NAME_MISMATCH`). Supply chain. Then trust: a tenant package by `checkTenantSignature`; a marketplace copy by `verifySkillSignature` with the listing's key, digest equal to the listing's, not `revoke` (`LISTING_NOT_AVAILABLE`), and `verifyApprovedAttestation` (`ATTESTATION_INVALID`). A `semver` already taken is `VERSION_TAKEN`, from the unique index. Then `runContractTests`. Failing fixtures: `recordSkillTestRun` with `failed`, reject `TESTS_FAILED`.
- A declarative package: `recordSkillTestRun` as `contract`/`passed`, `markSkillVersionVerified`, answer `{ step: 'finished', outcome }`.
- A package with code: `policyForManifest` (a refusal rejects with its code), `createFixtureRuns`, and answer `{ step: 'run_fixtures', sandboxRunIds }`.
- The workflow runs each as a child, one at a time, in order, and stops at the first that does not succeed. Then `finishSkillVerification` compares each output with its fixture's `expectedOutput` by `canonicalJson`, records the test run in `sandbox` mode, and settles. A run ending `runner_unavailable` rejects with `SANDBOX_UNAVAILABLE`, which is honest: it means this deployment cannot test this package.
- Each fixture's expected output is read from the bundle again there, and the bundle is hashed again.

**Things to get right:** the Activities take IDs and answer enums and IDs, so a manifest or fixture never crosses. `skill-verification-step.ts` holds the decisions as a pure function. Never store a fixture's content in `skills.test_runs`. A rejected version notifies its uploader by a `platform.notifications` row. Time goes through `workflow` time in workflow code.

**Denied and fault tests (unit, must run, with doubles):** a tampered byte, a re-signed manifest with the wrong key, an unknown signer, a revoked signer, a licence off the list, a name mismatch, a failed fixture, a run that timed out, no runner, a retry of `checkSkillBundle` after a crash that finds it `verifying`, a retry after it is settled that does nothing. **Integration (unverified):** the trigger refuses `verified` without a test row, across tenants nothing is visible, and a worker in tenant A cannot read tenant B's version by ID. **Replay:** capture test and corpus test written, histories owed, for `declarative-verified`, `sandbox-verified`, `rejected-at-check` and `rejected-at-fixture`.

## sandbox-runs: `EXP-05`

The application service, workflow and Activities for one run. `SBX-TS-06`, `SBX-TS-07`, `SBX-TS-08`.

**Owns:** `packages/application/src/sandbox-runs.ts`, `packages/workflows/src/sandbox-run-workflow.ts`, `sandbox-run-activities.ts`, new `sandbox-run-step.ts`, `sandbox-run-step.test.ts`, `sandbox-run-activities.test.ts`, new `tests/integration/sandbox-runs.test.ts`, `tests/replay/capture-sandbox-run.test.ts`, `tests/replay/sandbox-run-corpus.test.ts`.

**Implements:**

```ts
// @ensemus/application
requestSandboxRunInTx(tx, context, { gate, agentGuard }, input: RequestSandboxRunInput): Promise<SandboxRunView>
requestSandboxRun(database, context, { gate, agentGuard }, input): Promise<SandboxRunView>
getSandboxRun(database, context, sandboxRunId): Promise<SandboxRunView>
cancelSandboxRun(database, context, sandboxRunId): Promise<void>
getSandboxStatus(database, context, { enabled, ceilings }): Promise<SandboxStatusView>
beginSandboxAttempt(database, context, { sandboxRunId, probe, runtime, maxConcurrentPerTenant }): Promise<BeginAttemptOutcome>
finishSandboxAttempt(database, context, input: FinishAttemptInput): Promise<SandboxRunStatus>
abandonSandboxAttempt(database, context, { sandboxRunId, code }): Promise<SandboxRunStatus>
// @ensemus/workflows
sandboxRunWorkflow(input: SandboxRunInput): Promise<SandboxRunResult>
createSandboxRunActivities(deps: SandboxActivityDeps) => { executeSandboxRun }
createSandboxRunPlatformActivities(deps: SkillActivityDeps) => { abandonSandboxRun, readSandboxRunOutcome }
```

**Calls:** `resolveSkillVersionForUse` (skill-catalog: mock it), `compileSandboxPolicy` (sandbox-policy: mock it), `matchesSkillSchema`, `manifestDigest`, `verifySkillSignature` (skill-format: mock them), `probePassed`, `sandboxPolicyHash`, `sandboxAcceptsClassification`, `isSettledSandboxRun`.

**The flow:**

- `requestSandboxRunInTx` checks, in order: gate, capability `sandbox.run` for a person, `resolveSkillVersionForUse`-equivalent inside `tx`, `executionKind === 'sandbox'`, `sandboxAcceptsClassification`, canonical input size against `SANDBOX_INPUT_MAX_BYTES` (`SANDBOX_INPUT_TOO_LARGE`), and for `agent_tool` a guard: none is `AGENT_LINK_UNAVAILABLE` and `stopped` is refused. Compile the policy from the manifest. Write the row and `SANDBOX_RUN_REQUESTED`. A `skill_test` run is created by `createFixtureRuns` instead, with no event, because the verification workflow runs it as a child.
- `executeSandboxRun`, on the sandbox queue, with a heartbeat and the Activity's cancellation wired to an `AbortController`:
  1. `runner.probe()`, cached in the worker for `probeMaxAgeMs` while passing. A failure or a non-passing report goes in as `probe: null`, and the run settles `ISOLATION_NOT_PROVED`, so nothing goes to a runner whose limits did not hold.
  2. `beginSandboxAttempt`. `busy` answers `{ step: 'busy', afterMs }`. `settled` answers it.
  3. Read the bytes, hash against the row, parse, recompute the digest, verify the signature. Any mismatch settles `SKILL_BYTES_CHANGED` and nothing runs. Rehash the stored policy too.
  4. `runner.execute`, with files from the bundle and the input on stdin. `SandboxRunnerUnavailable` goes to `abandonSandboxAttempt`, and answers `{ step: 'retry' }` or settled.
  5. Parse stdout as JSON, check the output schema, `finishSandboxAttempt`.
- The workflow's retry policy on the Activity is `maximumAttempts: 1`, with its own loop for `busy` and `retry`, bounded and with durable timers. `scheduleToStartTimeout` on the sandbox queue is short enough that a deployment with no worker settles soon, through `abandonSandboxRun` on the platform queue. Cancel uses a cancellation scope, with `readSandboxRunOutcome` non-cancellable after it. A pure `sandbox-run-step.ts` decides, as `review-wait.ts` does.
- `finishSandboxAttempt` maps endings to statuses: `exited` with 0 and output ok is `succeeded`, `EXITED_ZERO`; a non-zero exit is `failed`, `EXITED_NON_ZERO`; bad output is `failed`, with its code; `wall_limit` and `cpu_limit` are `timed_out`, with their codes; `memory_limit` is `memory_exceeded`; `output_limit` is `output_exceeded`; `cancelled` is `cancelled`. Emit `SANDBOX_RUN_SETTLED`. Output is stored only on `succeeded`, and only canonical JSON within 1 MiB.
- The tenant ceiling: `pg_advisory_xact_lock(hashtextextended('sandbox_concurrency:' || org, 0))`, then count `running`.
- `getSandboxStatus` reads only this tenant's newest `isolation_probe_passed_at`. Evidence is `probe_passed` if there is one and `none` otherwise. Never anything stronger.

**Denied and fault tests (unit, must run, with `vi.mock` and scripted doubles):** a job with stored bytes changed never reaches the runner, a non-passing probe never reaches it either, a missing guard refuses an agent, a stopped agent run refuses, restricted is refused, input over the limit is refused, a cancelled row never starts, a lost attempt retries up to `SANDBOX_MAX_ATTEMPTS` and ends `runner_unavailable`, a repeat finish does nothing, and a job's stderr canary appears nowhere in what is stored or logged. **Integration (unverified):** across tenants every function is `NOT_FOUND`, the concurrency ceiling holds under two transactions, and `running` is refused with no probe. **Replay:** capture and corpus tests written, histories owed, for `succeeded`, `timed-out`, `cancelled-queued`, `cancelled-running`, `busy-then-ran`, `lost-then-ran` and `no-worker`.

## marketplace-submissions: `EXP-06`

The publisher's side. `MKT-TS-04`, `MKT-TS-07`.

**Owns:** `packages/application/src/marketplace.ts`, new `packages/application/src/marketplace.test.ts`, new `tests/integration/marketplace-submissions.test.ts`.

**Implements:**

```ts
createPublisher(database, context, gate, { displayName }): Promise<PublisherView>
getPublisher(database, context): Promise<PublisherView | null>
submitToMarketplace(database, context, gate, { skillVersionId, confirmShareWithOtherOrganizations: true }): Promise<SubmissionView>
listSubmissions(database, context): Promise<readonly SubmissionView[]>
withdrawSubmission(database, context, { submissionId, expectedVersion }): Promise<SubmissionView>
requestDelisting(database, context, { submissionId, expectedVersion }): Promise<SubmissionView>
```

**Things to get right:**

- `marketplace.publish` for all writes, and a person, never a service context. Reading is `marketplace.publish` too: a submission's state is an owner's business.
- `submitToMarketplace` loads the version, package and signer. It answers `MARKETPLACE_PUBLISHER_REQUIRED` with no publisher or a suspended one, `MARKETPLACE_NOT_PUBLIC` for anything but `public`, and `MARKETPLACE_VERSION_NOT_SUBMITTABLE` for the rest. It refuses `LicenseRef-Proprietary-Tenant` too, since that says the package goes nowhere. It copies everything on to the row. Map ES004 and ES005. Emit `MARKETPLACE_SUBMITTED`.
- `findingCodes` come from `marketplace.security_reviews`, which this tenant can see for its own submissions. A reviewer's label and the attestation are not on this view.
- `withdrawSubmission`: ES005 becomes `MARKETPLACE_SUBMISSION_NOT_WITHDRAWABLE`. `requestDelisting` needs `approved`, and emits `MARKETPLACE_DELIST_REQUESTED`.

**Denied and fault tests (integration, unverified):** a package that is not public, a marketplace copy, a version in another tenant, a revoked signer, a member and an admin (owner only), a suspended publisher, a service context, withdrawing what is listed, requesting a delisting of what is not approved, tenant B reading tenant A's submissions and publisher, and a submission racing a withdrawal. **Unit tests that must run:** mapping, and that the confirmation has to be literally `true` at the contract.

## marketplace-operator: `EXP-06`

The one process that crosses tenants: review and listing. `MKT-TS-01`, `MKT-TS-02`, `MKT-TS-03`.

**Owns:** `packages/database/src/marketplace-operator.ts`, `workers/workflow/src/marketplace-command.ts`, new `workers/workflow/src/marketplace-command.test.ts`, new `tests/integration/marketplace-operator.test.ts`.

**Implements:**

```ts
// @ensemus/database/marketplace-operator
openMarketplaceOperatorDatabase(url)
listOperatorQueue(db): Promise<readonly MarketplaceSubmissionRow[]>
getSubmissionForReview(db, { organizationId, submissionId }): Promise<MarketplaceSubmissionRow | null>
markSubmissionInReview(db, { organizationId, submissionId, expectedVersion }): Promise<void>
recordReview(db, { organizationId, attestation, attestationSignature, reviewerLabel, expectedVersion }): Promise<MarketplaceReviewRow>
createListing(db, { organizationId, submissionId, reviewId, objectKey }): Promise<MarketplaceListingRow>
delistListing(db, { listingId, mode, code, expectedVersion }): Promise<MarketplaceListingRow>
setPublisherState(db, { publisherId, state, expectedVersion }): Promise<void>
// worker
marketplaceCommand(argv, deps: MarketplaceCommandDeps): Promise<number>
```

**Calls:** `attestationPayload`, `verifyApprovedAttestation`, `parseApprovedAttestation`, `verifySkillSignature`, `keyIdOf`, `parseSkillBundle`, `manifestDigest` (skill-format: mock them), `reviewCanApprove`, `listingObjectKey`.

**Things to get right:**

- **The server never sees a private key.** `review-payload` prints the exact bytes to sign. `record-review` takes the attestation and the signature from files, and refuses (exit 2, nothing written) unless the reviewer's key is in `deps.reviewKeys` and the signature verifies. A `rejected` verdict is signed too.
- `reviewCanApprove` before an approval, which adds the rule the trigger cannot hold: `not_applicable` only for code, and only on a package with no code.
- A rejection has `findingCodes` from the fixed list, and at least one.
- `list`, in order: submission is `approved`; the review verifies again from the row; read the bundle from the submission's key; hash it to the digest through `parseSkillBundle`; the publisher's signature verifies; `store.put(listingObjectKey(digest), bytes)`; then `createListing`. Bytes first, so no row names bytes that are not there. Repeating `list` finds the row by `reviewId` and does nothing.
- `delist` validates `mode` and `code` against the fixed lists, and `stop_new` can become `revoke` and not the reverse.
- `show` writes the bundle to a path you name, and prints the manifest. It treats both as untrusted, so no terminal escapes: print JSON with control characters escaped.
- Everything it prints is IDs, enums and that manifest. The audit record is the review row. Answers with exit 0, or 2 for a refusal, with the code on standard error.
- Never reachable from the web tier: lint holds it, and a test should assert the web's dependency list.

**Denied and fault tests (unit, must run, with a stubbed `db` and doubles):** a reviewer not configured, a signature by another key, an attestation for another digest, a check failed, a finding on an approval, a code skip on a package with code, changed bytes at `list`, a forged publisher signature at `list`, no second listing on a repeat, an unknown mode or code, malformed arguments, and terminal escapes in a manifest. **Integration (unverified), with `provisionMarketplaceRole()`:** the trigger refuses a listing with no review, a rejected review, a mismatched digest and a suspended publisher, and the role cannot reach any other schema.

## marketplace-install: `EXP-06`

A tenant's side of taking a listing, and revocation reaching a copy. `MKT-TS-03`, `MKT-TS-05`, `MKT-TS-06`, `MKT-TS-07`.

**Owns:** `packages/application/src/marketplace-install.ts`, `packages/workflows/src/marketplace-install-workflow.ts`, `marketplace-install-activities.ts`, new `marketplace-install-step.ts`, `marketplace-install-step.test.ts`, `marketplace-install-activities.test.ts`, new `tests/integration/marketplace-install.test.ts`, `tests/replay/capture-marketplace-install.test.ts`, `tests/replay/marketplace-install-corpus.test.ts`.

**Implements:**

```ts
// @ensemus/application
listListings(database, context, gate, { after?, limit? }): Promise<ListingPage>
getListing(database, context, gate, listingId): Promise<ListingView>
requestInstallation(database, context, gate, { listingId }): Promise<InstallationView>
listInstallations(database, context): Promise<readonly InstallationView[]>
removeInstallation(database, context, { installationId, expectedVersion }): Promise<void>
beginInstallation(database, context, { installationId }): Promise<InstallationSubject | null>
materializeInstallation(database, store, context, { installationId, subject, bytes }): Promise<{ ok: true; skillVersionId } | { ok: false; code }>
finishInstallation(database, context, { installationId, outcome }): Promise<void>
// @ensemus/workflows
marketplaceInstallWorkflow(input: MarketplaceInstallInput): Promise<MarketplaceInstallOutcome>
createMarketplaceInstallActivities(deps: SkillActivityDeps) => { materializeListing, finishListingInstall }
```

**Calls:** `verifyApprovedAttestation`, `verifySkillSignature`, `parseSkillBundle` (skill-format: mock them), `skillBundleObjectKey`, `skillVerificationWorkflow` as a child by its ID.

**Things to get right:**

- The listing rows on `ListingView` come from `marketplace.listings`, and read through RLS. With the gate off, `listListings` answers an empty page rather than a refusal, so the page can say the marketplace is not on.
- `requestInstallation`: `marketplace.install`, and a person. Anything not `listed` is `MARKETPLACE_LISTING_NOT_AVAILABLE`. An existing live installation is `MARKETPLACE_ALREADY_INSTALLED`, from the unique index. Emit `MARKETPLACE_INSTALL_REQUESTED`.
- `materializeListing`: `beginInstallation`, a listing no longer `listed` fails `LISTING_NOT_AVAILABLE`, `verifyApprovedAttestation` with `deps.reviewKeys` fails `ATTESTATION_INVALID`, read the bytes from `subject.objectKey` and check them through `parseSkillBundle` and the digest (`BUNDLE_HASH_MISMATCH`), `verifySkillSignature` (`SIGNATURE_INVALID`), then `materializeInstallation`. **No configured review keys means nothing can be installed,** and that is the correct answer.
- `materializeInstallation`: bytes to the tenant's own key first, with `blob_lifecycle` as `addArtifact` does. Then the package (`origin: 'marketplace'`, `listingId`, `contentClassification: 'public'`, no owner), and an `uploaded` version with no uploader, in one transaction, all idempotent by installation. A name already used here is `NAME_TAKEN`. No event: the child verifies it.
- The workflow runs `skillVerificationWorkflow` as a child, then `finishListingInstall`. A `rejected` child is `VERIFICATION_REJECTED`.
- Installing writes no tool grant, no agent version and no publication. A test asserts that nothing but these rows changed.
- `removeInstallation`: `marketplace.install`. To `removed`, disables the package, and yanks any live version with `WITHDRAWN_BY_OWNER`, in one transaction.

**Denied and fault tests (unit, must run, with doubles):** an unconfigured reviewer, a forged attestation, changed bytes in the listing's object, a forged publisher signature, a listing delisted between request and work, no review keys at all, a retry that finds the copy already made, a `rejected` child. **Integration (unverified):** tenant B cannot see tenant A's installation, an installed copy needs publishing by a person before `resolveSkillVersionForUse` allows it, a `revoke` denies it at next use and a `stop_new` does not, a delisted listing is hidden from a tenant that never installed it, and a member cannot install. **Replay:** capture and corpus tests written, histories owed, for `installed`, `failed-attestation`, `failed-verification`.

## skills-api: `EXP-04`, `EXP-05`, `EXP-06`

Route Handlers for every planned M11B operation. All go through `apiRoute`, and none reaches Temporal, a runner or a review key. `MKT-TS-02`, `MKT-TS-07`.

**Owns:**

- new `apps/web/src/app/api/v1/organizations/[organizationId]/skill-signers/**`, `skill-packages/**`, `skill-versions/**`, `sandbox-runs/**`, `sandbox/**`, `marketplace/**`
- new `apps/web/src/server/skill-api.ts`
- `docs/specifications/openapi.yaml` (only `x-ensemus-status` and fixes in the M11B group), `packages/contracts/generated/**`, `tests/unit/openapi-contract.test.ts` (the M11B lines)
- new `tests/stack/skills-api.test.ts`, `tests/unit/skill-api.test.ts`

**Calls:** every service named above, from `@ensemus/application`, as stubs until they land. `apiRoute`, `readJson`, `readIfMatch`, `etag`, `organizationParams` from `apps/web/src/server/api.ts`, `getStore` from `runtime.ts`, `getSkillFeatureGate`, `getSandboxCeilings` from `skill-runtime.ts`. Schemas from `@ensemus/contracts/skills`.

**Implements:** each path under `# M11B (ADR-034)` in `openapi.yaml`, exactly as written there, with these handlers' DTOs in `skill-api.ts`: `skillSignerDto`, `skillPackageDto`, `skillVersionDto`, `sandboxRunDto`, `publisherDto`, `submissionDto`, `listingDto`, `installationDto`, and `readSkillBundle(request): Promise<Buffer>`.

**Things to get right:**

- `POST .../versions` takes the media type `SKILL_BUNDLE_MEDIA_TYPE` and nothing else (415), counts as it reads against `SKILL_BUNDLE_MAX_BYTES`, and answers 413 with `SKILL_BUNDLE_TOO_LARGE`. It does not parse the body. The route must not hold the bytes longer than the service does. The `next.config` Server Action limit does not apply to a Route Handler, so this count is the limit.
- Writes with `IdempotencyKey` in the spec use `withIdempotency`. `IfMatch` uses `readIfMatch`.
- A DTO is the only way out, with snake_case fields and exactly the spec's. A manifest's free text in a DTO is `display_name` and `summary` from the listing, and nothing else. A signature, a public key's bytes, an object key and a bundle's bytes never leave.
- `sandbox/status` passes the gate's answer and `getSandboxCeilings()`. `isolation_evidence` is only ever what the service said.
- As each route lands, remove `x-ensemus-status: planned` and its line in `tests/unit/openapi-contract.test.ts`, then run `pnpm --filter @ensemus/contracts generate`.

**Denied tests (stack, unverified):** every route, for no session, a wrong origin on a write, another tenant's ID, a member without the capability, a malformed ID, an oversized body, the feature off, and a body that names a signature or a price where the spec has none. **Unit tests that must run:** DTOs drop what they must, and `tests/unit/openapi-contract.test.ts` stays green.

## skills-ui: `EXP-04`, `EXP-05`, `EXP-06`

Pages for the catalog, signers, a version's review, runs, publishing and the marketplace, on the existing design system, with empty, error and denied states. `QA-028`, and each `*-TS` denied state as a page.

**Owns:**

- new `apps/web/src/app/o/[organizationId]/skills/**`, `apps/web/src/app/o/[organizationId]/marketplace/**`
- new `apps/web/src/server/skill-actions.ts`
- new `apps/web/src/components/skill-*.tsx`, `apps/web/src/components/sandbox-*.tsx`, `apps/web/src/components/marketplace-*.tsx`
- `apps/web/src/app/o/[organizationId]/layout.tsx` (two nav items), `apps/web/src/components/main-nav.tsx` if it needs anything, `apps/web/src/app/globals.css` (additions only)
- new `tests/browser/specs/skills.spec.ts`, `tests/browser/specs/marketplace.spec.ts`

**Calls:** the same services, directly, as ADR-022 says. Each Server Action resolves the person and tenant again from the session, as `work-actions.ts` does.

**Pages:**

- **Skills:** packages, a package's versions, upload a bundle, signers (add a public key, show its fingerprint, revoke with what it will do spelled out).
- **A version:** state, signer's fingerprint, licence, what it declares it can ask for and what data it may be given, latest test result, and publish or yank. Publishing is refused on the page for the uploader, with the reason, before anyone tries.
- **Runs:** try a version by hand, one run's limits, what it used and how it ended. A status panel from `getSandboxStatus`.
- **Marketplace:** what is on offer, a listing with who reviewed it and when, install, installations, and for an owner publishing: become a publisher, submit with an explicit statement that other organizations on this deployment will see it, submissions and their findings, withdraw, ask for a delisting.

**Words to get exactly right:**

- **Never "isolated", "secure", "safe" or "sandboxed so it can't…".** The status panel says what was checked: "Limits on this server were last checked at {time}. Nothing has reviewed this from outside." With no evidence: "No run has checked the limits on this server yet."
- A review says "Reviewed by {label} on {date}", and never "verified", "certified" or "approved by Ensemus".
- Installing says: "This copies the package here and grants it nothing. Someone in your organization still has to publish it."
- No price, anywhere. Do not add a placeholder for one.
- Text from a manifest is shown as text and never as HTML, and is marked as coming from the publisher.

**Tests (browser, unverified):** keyboard-only through publishing, a member sees no write controls and a forged action is refused, every empty and error state, the feature off, and a canary in a manifest's summary renders as text.

**Run:** `pnpm --filter @ensemus/web exec next typegen`, typecheck, eslint and prettier. Never a dev server. Browser specs typecheck, and do not run.

---

# Wave 2: after every wave 1 slice has merged

## acceptance: `EXP-04`, `EXP-05`, `EXP-06`

Proves the parts work together, as far as code can without containers, writes what the owner needs to take this further, and closes the docs. It really needs wave 1 merged, because it runs the real slices against each other.

**Owns:**

- new `tests/unit/m11b-slice.test.ts`: an in-memory end to end, with a real `@ensemus/skills`, real `@ensemus/sandbox` policy and spec, a scripted runtime, and doubles for the database: sign a bundle, parse, verify, compile, and produce a spec and job
- new `tests/stack/skills-marketplace.test.ts`, `tests/stack/sandbox-isolation.test.ts`, `tests/browser/specs/m11b-flow.spec.ts`
- new `docs/06-delivery/evidence/M11B-report.md`, `docs/05-operations/07-skills-sandbox-marketplace-runbook.md`
- `docs/02-architecture/03-data-model.md`, `docs/02-architecture/11-monorepo-and-module-contracts.md`, `docs/03-intelligence/03-agent-studio-and-skills.md`, `docs/01-product/04-capability-catalog.md`
- `docs/specifications/implementation-backlog.csv`, `qa-scenarios.csv`, `threat-register.csv`, `traceability.csv`, `docs/06-delivery/06-end-to-end-delivery-plan.md`
- **`docs/MANIFEST.json`, last of all:** `node docs/specifications/tools/regenerate-manifest.mjs`

**`tests/stack/sandbox-isolation.test.ts` is the proof ADR-034 says is owed.** Written and not run, it has to be what the owner runs later, on the `sandbox` profile, on the images that ship: the probe passes with every check, a hostile job for each of `SBX-TS-01` to `SBX-TS-05` ends as it should, a packet capture shows nothing left the sandbox network, the sandbox worker has no broker and no connector in its bundle, the runner has no database URL and no secret but its token, and a job finds no canary placed in the runner's environment.

**`tests/stack/skills-marketplace.test.ts`:** an owner trusts a generated key, uploads, a worker verifies, a second person publishes, a run happens, a publisher submits, the operator command reviews and lists with a generated review key, another tenant installs, verifies and publishes, and a `revoke` then stops that copy at its next use. Each denied case on the way.

**The runbook** covers, plainly: what each switch does, how to provision the operator role, how to choose and configure a runtime, how to read a probe, what to do for a hostile package (disable, yank, delist with `revoke`), and what has not been proved. **No RTO, RPO or SLA numbers, no certifications, no legal terms.**

**The report** lists commands actually run with results, and everything that did not run, in the words the handoff uses. Status in `implementation-backlog.csv` moves only as far as the evidence does: no ticket here can be `done` until containers have run and outside review has happened. **Never claim isolation.**

---

## Owner-led: no slice

A person has to do these, and no builder drafts them.

- Marketplace publisher terms, takedown policy and what a review obliges anyone to do (`LEGAL-04` territory, with counsel).
- Outside security review of ADR-034 D2, D3, D5, D6 and migration 0651.
- Choosing who holds review keys, and generating and storing them outside Ensemus.
- Choosing a runtime and a host for the runner, and any cost that carries.
- Third-party licence review of the runtime that goes in the runner's image (`LEGAL-05`).
- Any decision to charge for anything here.

## Merge order

Nothing depends on order for compiling, since every signature exists. For tests to pass end to end: skill-format, sandbox-policy, sandbox-runner, skill-catalog, sandbox-runs, skill-verification, marketplace-submissions, marketplace-operator, marketplace-install, skills-api, skills-ui, then acceptance. If the ownership above held, there are no conflicts to resolve.

## Handoff

Each builder reports: tickets, files, behaviour, commands actually run with results, anything left stubbed, what could not run locally, and any report under "If you need a change". Integration, stack and browser tests count as unverified, and are reported that way. Do not push. Finish with `git checkout --detach`.
