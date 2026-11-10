# M4 slices

Builders work in parallel from the foundation commit, and **no file has two owners**. Everything they must agree on is already decided in [ADR-028](../00-foundation/adr/ADR-028-governed-ai.md) and already typed in the code. Read that ADR first, because it holds the reasons.

If you need a change to a file you do not own, or to anything in "Fixed" below, stop and report it. Do not work around it, and do not edit the file.

Wave 1 can all start at once: twelve slices that depend only on foundation's ports, and test against doubles. Wave 2 needs wave 1 merged: wiring and assurance, which do not share files.

The plan's network slice (`S14`, `SEC-14`) is compose work, so it is not here. Nor is role provisioning. Both are recorded in ADR-028 and in the foundation's report under what Docker work comes later.

Tickets only a person can finish have no slice. See [Owner-led](#owner-led).

## Fixed: nobody changes these

| What | Where |
|---|---|
| Migrations, RLS, roles and triggers. **No builder adds a migration** | `packages/database/migrations/0100_ai.sql`, `0101_ai_security.sql`, `packages/database/src/schema-ai.ts`, `drizzle.config.ts`. The journal and `meta/` are stitched at the final merge |
| Tenant binding, and the agent's way in | `packages/database/src/tenant.ts`, `agent.ts`, `index.ts` |
| Vocabulary | `packages/domain/src/ai.ts`, `ai-tools.ts`, `ai-events.ts`, `ai-binding.ts`, `policy.ts` |
| Ports | `packages/application/src/ai/ports.ts`, `external-action-port.ts`, and every `package.json` export map |
| Contracts | `packages/contracts/src/ai.ts`, `ai-tools.ts`, `packages/workflows/src/agent-schemas.ts`, `constants.ts`, `docs/specifications/schemas/agent-definition.schema.json` |
| Interfaces in the new packages | `packages/intelligence/src/types.ts`, `index.ts`, `packages/policy/src/types.ts`, `index.ts`. Your own file's exported signature is fixed too: fill in the body |
| Dispatcher and build | `workers/workflow/src/dispatcher.ts`, `workers/workflow/scripts/build.mjs`, `packages/workflows/src/workflows.ts` (re-exports) |
| Import rules | `eslint.config.mjs` |
| Dependencies. **`pnpm-lock.yaml` is frozen, and no builder adds a package.** `@ai-sdk/*`, `undici`, `ajv` and `ajv-formats` are in `@ensemus/intelligence` already | every `package.json`, `apps/web/next.config.ts` |
| Error wording | `packages/application/src/errors.ts`, `apps/web/src/lib/messages.ts`, `packages/telemetry/src/index.ts` |
| Shared test helpers | `tests/helpers/ai/*`, `tests/helpers/stack.ts`, `tests/contract/model-adapter.contract.ts`, `tests/contract/scripted-adapter.test.ts`, `packages/intelligence/src/testing/*`, `tests/unit/ai-vocabulary.test.ts`, `tests/integration/ai-schema.test.ts`, `tests/replay/capture-support.ts`, `corpus.ts` |
| `docs/specifications/openapi.yaml`, `packages/contracts/generated/*`, `tests/unit/openapi-contract.test.ts` | **Only the wiring slice,** which removes `x-ensemus-status: planned` once the routes are merged. A wave-1 branch that adds a route fails `tests/unit/openapi-contract.test.ts` with "marked planned, but a route exists". That is expected, and you do not fix it |
| Decisions | ADR-028, this file |

A bug in any of these is reported, not fixed in passing.

## Rules for every slice

**Code only.** The owner's machine is low on disk, and the owner decides later when to run containers.

- Never run `docker` or `docker compose` in any form. Never run `pnpm test:integration`, `test:stack`, `test:browser` or `test:upgrade`, or anything that needs a container. Do not edit Dockerfiles or compose files: report what they will need.
- Allowed: `pnpm exec prettier`, `pnpm exec eslint <paths>`, `tsc --noEmit` on the packages you changed, `pnpm --filter @ensemus/web exec next typegen`, `pnpm exec vitest run --project unit <paths>`, `pnpm test:replay`. Check just what you changed, in as few runs as you can.
- Run every install, typecheck, eslint, `next typegen` or vitest command through the machine's slot wrapper, if your instructions name one.
- Still write the integration, stack, temporal and browser tests below, and typecheck them. **They count as unverified. Say so, and never report them as passing.**

**Tests.**

- Denied and cross-tenant tests first, then the code. Two tenants, same names, real roles in `tests/integration/`.
- Put as much as you can into pure functions and `*.test.ts` next to them, in the `unit` project, with doubles for ports. That is the part that runs today. `tests/helpers/ai/fixtures.ts` has two-tenant seeds that go through the real roles and triggers.
- Scripted models **obey** every injection (`ScriptedModelAdapter`), so a test proves the control and not a refusal. Assert "denied before egress" as zero adapter hits **and** zero `RecordingLender.asked`. A deny that still opened a key fails.
- Generated test values only: `tests/helpers/ai/canaries.ts`, `@example.invalid`. No real key, address or provider. Fakes live with tests and are never a default code path.
- No invented prices, limits, SLAs or legal terms. Anything like that is configuration, and a test's rate card is the test's own.

**Code.**

- An agent acts as its initiator: `contextForRun` from `@ensemus/application/ai-runs`, re-read for every step. **Never `createServiceContext`:** lint bans it, and the trap is that it passes every functional test (FD-3). Test the case of an initiator who lacks access.
- All tenant access goes through `withTenantTx`, and no transaction stays open across a model call or a network call.
- Only IDs, enums and counters cross Temporal. Workflow files import only `@temporalio/workflow`, types, `constants.ts` and `@ensemus/agent-runtime/reducer`.
- `@ensemus/intelligence` and `@ensemus/agent-runtime` have no database import, by lint. Name what you need in the ports, and the services in `packages/application/src/ai` supply it.
- Web can never read a prompt: `ai.step_payloads` has no grant for its role. A timeline shows `label_code` and counters, in words the web tier owns.
- Log codes through `createLogger`. Allowed fields are in `packages/telemetry/src/index.ts`, and text from a provider, a model or a document is never one. Never log an SDK error object: it can quote the whole prompt.
- Refusals by people follow the existing audited pattern (`packages/application/src/refusals.ts`). Errors come from the codes already in `errors.ts`.
- Follow the house comment style: say why, in plain sentences.
- Commit with several `-m` flags, ending in the attribution line your instructions give. Do not push.

## Wave 1

### policy-router: `SEC-01`, `SEC-13`, `MODEL-03`, `COMM-02` (routing)

Egress decision, secret scan, router and the gateway's order. **The last check before company data leaves. A wrong order sends data and logs a denial afterwards, so do not rush it.**

**Owns:** `packages/policy/src/{classification,egress,action,secret-scan}.ts` and their tests; `packages/intelligence/src/router/**`, `packages/intelligence/src/gateway.ts`, `gateway.test.ts`; `packages/application/src/ai/egress-log.ts`; `tests/integration/ai-routing.test.ts`.

**Implements:**

```ts
// @ensemus/policy, pure
decideEgress(input: EgressInput): EgressDecision        // from data-egress-matrix.csv
decideAction(input: ActionInput): ActionDecision        // deny > require_approval > allow
scanForSecrets(parts: readonly ContentPart[], canaries?: readonly string[]): ScanResult
// @ensemus/intelligence
createModelRouter({ profiles: ProfileStore, egress: EgressLog, now? }): ModelRouter
createInferenceGateway(deps: GatewayDeps): InferenceGateway
// @ensemus/application/ai-egress-log
createEgressLog(database): EgressLog
listEgressDecisions(database, context, { runId }): Promise<readonly EgressDecisionView[]>
```

**Order, FD-8, in one readable function:** `entitlements.check(ctx, 'model.call')`, `ledger.headroom`, then `router.select` (class and actor, candidates, capability, `decideEgress`, one `egress.record` per decision), then in a short transaction `halt.assertRunning` and `ledger.reserve`, then `scanForSecrets` (a hit raises that part to `restricted` and re-decides), `checkEndpoint` from `@ensemus/policy/endpoint`, `credentials.withKey`, `adapter.generate`, validate output, then in a short transaction `ledger.settle` and `ledger.record`. Fallback is FD-9: the next entry of an explicit list, re-checked, or fail closed with `MODEL_UNAVAILABLE`. A tool call naming anything outside `compiled.tools` is `invalid_output`. `ajv` is available for `responseSchema`.

**Table:** generate S1's matrix from `docs/specifications/data-egress-matrix.csv` as source text, and test that the two match. Where docs differ, the stricter reading wins (G7).

**QA owned:** `QA-009`, `QA-010`, `AI-TS-02`, `BYOM-TS-01`, routing half of `FAULT-10`, scan half of `QA-018`. Threat `SEC-004`.

**Required tests.** Unit: full matrix of 4 classes × 3 destinations. Unknown input denies. Deny beats allow. A tenant bundle cannot loosen. Restricted denies external even with a tenant allow. Wrong region and missing contract deny. Scan finds each shape and returns no content. Mixed class takes the strongest. Property: no input yields allow without an approved active profile. Gateway stops at each stage with zero later calls, against doubles for every port. `QA-009`: BYOM profile down while a healthy, cheaper `billing_owner='ensemus'` profile exists: zero hits there, fail closed `MODEL_UNAVAILABLE`. `QA-010`: restricted data and an external profile: zero hits, one `egress_decisions` row, zero keys asked for. `AI-TS-02`: a disallowed fallback entry denied and recorded, wrong region denied, a missing capability fails rather than being dropped. `BYOM-TS-01`: profile version moves mid-run: next turn `policy_denied`. An injected prompt cannot influence selection: `InferenceTask` has no field for model output, proved by a type test. Integration: two tenants, A's profile is never a candidate for B; provider access revoked mid-run.

### transport: `SEC-11`, `MODEL-02`

Endpoint guard, key lending, adapters and the fake model server. **A mistake sends a customer's key to an attacker, or logs a prompt. Do not rush it.**

**Owns:** `packages/policy/src/endpoint.ts`, `endpoint.test.ts`; `packages/intelligence/src/net/**`, `credentials.ts`, `credentials.test.ts`, `adapters/**`; `tests/fixtures/fake-model/server.mjs`; `tests/conformance/**`; `tests/contract/real-adapters.test.ts`; `tests/integration/ai-credentials.test.ts`.

**Implements:**

```ts
checkEndpoint(kind: ProviderKind, endpointUrl: string, settings: EndpointSettings): EndpointCheck   // @ensemus/policy/endpoint
createEndpointGuard({ resolve?: Resolver }): EndpointGuard
createCredentialLender({ secrets: SecretLease, reviewInterlock: string | null }): CredentialLender
createModelAdapter(): ModelAdapter
```

**Rules:** hosted kinds have a fixed host list in code (`api.openai.com`, `api.anthropic.com`), and private addresses come only from the operator's `ENSEMUS_PRIVATE_MODEL_ENDPOINTS` (`loadModelEgressSettings` in `@ensemus/config`). Guard: `undici` `Agent` with `connect.lookup` resolving once and pinning, `fetch` with `redirect: 'error'`. **Prove the pinning works: it is unverified.** Lender: purpose is `modelKeyPurpose(profileId, endpointUrl)`, it refuses a hosted kind with no interlock (FD-21), and it wipes the buffer. Document that a string passed to a header cannot be zeroed. Adapters: `createOpenAI`, `createAnthropic`, `createOpenAICompatible` from the provider packages, a fresh instance per call, one `doGenerate`, `ai` core banned by lint, every error mapped to `AdapterFailure`, and `mayHaveBilled` true for anything after the request could have been read. Two hosted kinds and `local_openai_compatible`. Hosted wire formats come from provider docs (use Context7) and stay `qualified=NO` until a live run.

**Fake server:** deterministic, OpenAI-compatible and each hosted wire format, counts hits, records headers, on a loopback port. No test code in a shipped image.

**QA owned:** guard half of `FAULT-10`, threats `TR-022`, `SEC-016`. Conformance list in spec 01.

**Required tests,** unit, with local HTTP servers and a fake resolver: 169.254.169.254, RFC1918, loopback, IPv6-mapped and link-local all refused. DNS answer changes between check and connect (rebinding) still reaches only the pinned address. Redirect refused. Plain HTTP refused unless on the operator's list. A tenant cannot add a private address. A key under a changed endpoint digest yields `SecretUnavailable`. Another tenant's or purpose's key fails. A provider 401 echoing the key: canary absent from the result, logs and error. Against the fake: structured JSON, tool call, malformed JSON, a tool not in the list, long-context truncation refused and not silently dropped, cancellation, timeout, 429, 500, partial response, usage missing, **retry count exactly zero (the fake counts hits)**, no SDK error field reaches a log. `tests/contract/real-adapters.test.ts` runs `describeModelAdapterContract` over the real adapters.

### model-profiles: `MODEL-01`, `COMM-02` (capture), Journey D

Registry, credential capture and the activation probe. **`FD-21` is the machine check behind the outside-review rule.**

**Owns:** `packages/application/src/ai/model-profiles.ts`, `model-probe-store.ts`; `packages/workflows/src/model-probe.ts`, `model-probe-activities.ts`; `packages/intelligence/src/probe.ts`; `apps/web/src/app/o/[organizationId]/settings/models/**`; `apps/web/src/app/api/v1/organizations/[organizationId]/model-profiles/**`; `tests/integration/ai-model-profiles.test.ts`; `tests/browser/specs/models.spec.ts`; `tests/replay/capture-model-probe.test.ts`, `tests/replay/model-probe-corpus.test.ts`.

**Implements**, stubs in place: every export of `@ensemus/application/ai-model-profiles` (`createModelProfile`, `listModelProfiles`, `getModelProfile`, `updateModelProfile`, `attachModelKey`, `requestModelProbe`, `disableModelProfile`, `addRateCard`, `createProfileStore`), `@ensemus/application/ai-model-probe-store` (`loadProfileForProbe`, `recordProbeResult`), `modelProbeWorkflow(input: ModelProbeInput): Promise<ModelProbeOutcome>`, `createModelProbeActivities(deps)`, `createProfileProber(deps)`. The route takes a key once: `storeSecret` from `@ensemus/secrets/seal` with `modelKeyPurpose`, then `attachModelKey`, then the key is gone. The view is `modelProfileViewSchema`, with no `secret_ref`. `destination` on `RoutableProfile`: hosted kinds and `openai_compatible` are `customer_byom_public_api` (or `ensemus_cloud_managed_model` when `billing_owner='ensemus'`), and `local_openai_compatible` is `customer_private_inference`.

**QA owned:** `QA-024` partial (API and UI only, export in M6). Threat `SEC-016`. Negative test from 04-security/02 §9.

**Required tests:** member cannot create. API and page output carry no key or `secret_ref`, by canary and RSC scan. Arbitrary URL rejected for hosted kinds. Endpoint change voids the key and returns the profile to draft. Hosted credential refused without the FD-21 setting. Activation refused without a passing probe. Web cannot mark active (trigger). Cross-tenant profile ID returns 404. The key cannot be read back. Probe fails closed on any adapter failure, and a stale version writes nothing. Browser: keyboard flow and axe.

### usage: `MODEL-04`, `COMM-02` (entitlements)

Ledger, reservations, budgets and the entitlement seam. **Billing in M8 depends on history that cannot be rebuilt. Under-counting a lost call is the failure to prevent.**

**Owns:** `packages/application/src/ai/usage.ts`, `budget.ts`; `packages/commercial/src/**`; `apps/web/src/app/api/v1/organizations/[organizationId]/{entitlements,usage,budgets}/**`; `apps/web/src/app/o/[organizationId]/settings/budgets/**`; `tests/integration/ai-usage.test.ts`.

**Implements:**

```ts
createUsageLedger(database): UsageLedger                 // @ensemus/application/ai-usage
costMicros(usage, rate): number                          // rounds up
setBudget(database, context, input: SetBudget): Promise<{ budgetId }>   // ai-budget, needs budget.manage
getUsageSummary(database, context, { period }): Promise<UsageSummary>   // needs usage.view
createEntitlements(database): Entitlements               // @ensemus/commercial
getEntitlementsView(database, context): Promise<EntitlementsView>
```

**Rules:** `reserve` is one atomic `UPDATE ... WHERE reserved + spent + amount <= limit` per budget that applies (organization and agent version). No budget or no rate card denies, with no code default. `settle` may overspend: it records what happened. A lost-answer retry writes `estimated` at the reserved amount (FD-12). Entitlements: BYOM and Sovereign are entitled with `billable=false`, and Cloud has no included allowance until a row in `platform.entitlements` says so. **No plan, price or quota in code.**

**QA owned:** `QA-027` partial (BYOM `billable=false`, labelled estimate), cost part of `QA-012`. Threat `SEC-010`.

**Required tests:** pure `costMicros` and rounding. Two concurrent reservations for the last headroom, one wins. Same idempotency key twice, one row. Lost-answer retry writes `estimated` and over-counts. Cancel releases the unused reservation. UPDATE and DELETE on the ledger refused for every role. Per-run reconcile equals the sum of the ledger. No rate card or no budget denies. Rate-card version recorded. Entitlement denial differs from policy denial in admin diagnostics. An entitlement cannot override a policy deny. Member cannot set a budget. Cross-tenant budget read returns nothing.

### agents: `AGENT-01`, `AGENT-16` (publish gate)

Registry and publishing.

**Owns:** `packages/policy/src/agent-spec-lint.ts`, `agent-spec-lint.test.ts`; `packages/application/src/ai/agents.ts`; `apps/web/src/app/o/[organizationId]/settings/agents/**`; `apps/web/src/app/api/v1/organizations/[organizationId]/agent-versions/**`; `tests/integration/ai-agents.test.ts`; `tests/browser/specs/agents.spec.ts`.

**Implements:**

```ts
lintAgentSpec(spec: unknown, limits: OrgAgentLimits): SpecLintResult   // @ensemus/policy/agent-spec-lint, pure
publishAgentVersion(database, context, { spec, evaluationReport, policyVersion }): Promise<AgentVersionView>
listAgentVersions(database, context): Promise<readonly AgentVersionView[]>
getAgentVersion(database, context, versionId): Promise<AgentVersionView>
```

**Rules:** parse with `agentSpecV1Schema`, lint against `TOOL_MANIFESTS` and `FORBIDDEN_TOOL_PREFIXES`, compute `spec_sha256` over `canonicalJson`, require a passing `evaluationReportSchema` report with that hash and the policy version, parse `max_cost_usd` once with `usdToMicros`, then write the definition if new, a service identity, the immutable version and a publication in one transaction, emitting `agent_version.published`. Organization limits come from the active `governance.policy_bundles` document. With none, the spec's own ranges apply and delegation depth is 0.

**QA owned:** threat `SEC-007` (grants immutable).

**Required tests:** UPDATE and DELETE on a version refused for all roles. Schema violation refused. Unknown tool in `allow` refused. `secrets.*` refused. Limits above org policy refused. No or stale evaluation report refused. A report for another spec refused. Member cannot publish. A running Work Unit keeps its version after a new publish. Cross-tenant version ID refused. Browser spec.

### spine: `AGENT-02`, `AI-13`

The workflow and its Activities. **Long-lived workflows are the hardest code to change, and approval waits can last days across upgrades.**

**Owns:** `packages/agent-runtime/src/reducer.ts`, `reducer.test.ts`; `packages/workflows/src/agent-run.ts`, `agent-activities.ts`, `agent-run.test.ts`; `packages/application/src/ai/runs.ts`; `tests/replay/capture-agent-run.test.ts`, `tests/replay/agent-corpus.test.ts`, `tests/replay/histories/agent-*.json`; `tests/integration/ai-runs.test.ts`; `tests/temporal/agent-run.test.ts`.

**Implements:**

```ts
decideNext(state: ReducerState, last: LastStep): NextStep              // imports nothing, by lint
agentRunWorkflow(input: AgentRunInput, carry?: AgentRunCarry): Promise<AgentRunResult>
createAgentActivities(deps: AgentActivityDeps): AgentActivities
// @ensemus/application/ai-runs
claimQueuedRun, contextForRun, setRunStatus, addToCounters, finishRun, closeStrandedRun, storeStepPayload, createTurnStore
```

**Shape:** workflow code stays on the platform queue (the dispatcher starts it), with Activities through `proxyActivities({ taskQueue: AGENT_TASK_QUEUE, scheduleToStartTimeout: AGENT_SCHEDULE_TO_START })`. Each loop: `readRunDirective` (PostgreSQL is the answer, and `AGENT_RUN_CONTROL_SIGNAL` and `approvalResolved` only wake it), `decideNext`, then one Activity: `runModelTurn` or `runToolCall`. A `needs_approval` outcome sets `waiting_for_approval` and waits with `condition(() => woken, TOOL_WAIT_POLL)` around `readToolWait`. Time in waits and pauses does not count against `timeoutSeconds` (FD-22). `runModelTurn` is safe to retry through `TurnStore.beginTurn` (FD-12). Cancellation reaches the Activity's signal, with a heartbeat. The child branch (FD-16) starts a native child workflow with `workflowIdFor` after a `createChildRun` Activity, whose body calls `@ensemus/application/ai-delegation`, stubbed until that slice merges. So delegation never edits this file. A `final_output` goes to `verifying` and `verifyRunOutput`. **Completing the Work Unit is not the run's to do:** it moves to `verifying`, and an agent cannot use the owner's confirmation, because `work.ts` checks `actorType === 'user'`.

**Two traps.** `reconcileStrandedRuns` probes `getHandle(workflowIdFor(input), work.runId).describe()`, so after `continueAsNew` the old run ID reads as closed. The first Activity after continue-as-new must re-claim, moving `work_units.run_id` and `agent_runs.temporal_run_id` to `workflowInfo().runId`, and `carry.agentRunId` proves it is the same run. And this workflow shares its ID with `workUnitWorkflow`, so claim must refuse a Work Unit a plan already holds.

**QA owned:** `QA-012`, `QA-014`, `FAULT-02`, `FAULT-03`, threat `SEC-015`, ADR-024 acceptance rows 1 and 2.

**Required tests.** Unit: exhaustive `decideNext`: turn, tool, token, cost and time limits each stop with their code, a run cannot raise its limits, every outcome maps somewhere. `workflows.test.ts`-style: the reducer loads in the workflow sandbox, and payload schemas refuse free text. Integration: claim by two workers, one wins. Temporal: worker killed during a model call resumes without repeating finished turns, worker rolled during an approval wait, cancel during a call aborts it, `continueAsNew` at `continueAsNewSuggested`, pause, resume, stop, `scheduleToStart` timeout when `agent-worker` is absent ends with `WORKER_UNAVAILABLE`. Replay: a capture test for each path. **Histories need a Temporal server, so write the capture test and report the histories as owed.** A changed step order without `patched` must fail once they exist.

### context: `AGENT-15`

Minimal context and prompt assembly. **Role separation is what keeps a poisoned document as data, and regressions are invisible without golden tests.**

**Owns:** `packages/agent-runtime/src/context/**`; `packages/application/src/ai/context-source.ts`; `tests/integration/ai-context.test.ts`.

**Implements:**

```ts
createMinimalContextCompiler({ source: ContextSource, limits }): ContextCompiler
createContextSource({ database, readObject }): ContextSource
```

**Rules:** `loadWork` and `loadArtifactText` go through `loadReadable` under the agent context, so the initiator's access decides. Run class is strongest-of across the Work Unit, its client, each artifact and each tool output. Text artifacts only, by `mimeType`. Only `instructions` and fixed text reach role `policy`. Evidence and tool output are delimited in their own roles, whatever they say. No secret interpolation exists in the template path. `requestHash` is the SHA-256 of the assembled messages.

**QA owned:** supports `QA-018`, `FAULT-08`, `FAULT-01` analogue for artifacts.

**Required tests,** unit against a double `ContextSource`, plus integration: an initiator without access to restricted work gets nothing, even though the agent role could read it. An artifact deleted or access removed between runs is excluded. Mixed classes raise the run's class. Enormous and binary artifacts capped or refused. Injected text stays in the evidence role and never reaches system text (golden tests). Output reproducible for pinned versions: hashes equal. Traces hold hashes and source IDs only. Another run's transcript cannot be loaded. Cross-tenant artifact ID refused.

### tools: `AGENT-03`

The tool gateway. **The model is untrusted, and this is what makes that safe.**

**Owns:** `packages/agent-runtime/src/tools/**`; `packages/application/src/ai/tool-steps.ts`; `tests/integration/ai-tools.test.ts`.

**Implements:**

```ts
createToolGateway({ source, externalActions, approvals, halt }): ToolGateway
// ToolGateway.handle(context: AgentContext, step: ToolStepRef): Promise<ToolHandleResult>
storeProposal, loadProposal, setProposalStatus     // @ensemus/application/ai-tool-steps
```

**Pipeline, in this order:** allowlist (`TOOL_MANIFESTS`, spec `allow` and `deny`, `delegated_scopes.tools`, through `decideAction`) → parse (`TOOL_ARGS_SCHEMAS`, strict) → principal and resource ACL → class → approval policy → `halt.assertRunning` → idempotent effect → receipt → audit. `email.send` proposes through `ExternalActionPort` and `ApprovalBinder`, and the payload is exactly what M3 freezes (ADR-027 D1). The idempotency key is derived from run and step, so a retry finds the same proposal. M3's workflow sends it, and tool output class raises the run's class. `artifact.draft.create` is at least the run's class, and writes `ai.artifact_evidence`.

**QA owned:** `AI-TS-01` with M3's port. Threats `SEC-003`, `SEC-007`, `SEC-008`, `SEC-015`.

**Required tests,** unit against doubles for every port, plus integration: tool outside grants, model-invented tool, bad args, extra args. Destructive or financial denied by default. A tool in `deny` wins. Resource in another tenant or outside the initiator's ACL. Initiator disabled mid-run. An agent trying to change model, grant or budget through a tool. Output cap. Timeout-after-send reconciles and does not send twice (a fake `ExternalActionPort`). Unknown state stops as `unknown_external_state` and is shown as unknown. Cancel during tool execution. Tool output class raises the run's class. `artifact.draft.create` cannot lower class. An attempt for a run that has ended is refused by the trigger.

### approvals: `AGENT-04`, Journey C

Approval binding. **A person's consent is the only thing authorizing an outside effect. A time-of-check error makes it meaningless.**

**Owns:** `packages/application/src/ai/tool-approvals.ts`; `apps/web/src/app/o/[organizationId]/approvals/[approvalId]/agent-action.tsx`; `tests/integration/ai-approvals.test.ts`. The one-line include in the existing page goes to wiring.

**Implements:**

```ts
createApprovalBinder({ externalActions, halt }): ApprovalBinder
getAgentActionForApproval(database, context, approvalId): Promise<AgentActionView | null>
```

**Rules:** reuse `checkExecution`, `actionHash` and M3's `proposeExternalActionInTx`, and rewrite none of them. The approver comes from policy, never from anything a model said: the Work Unit's accountable owner, unless that is the initiator, then another owner or admin who can read the work. With nobody, refuse `NO_ELIGIBLE_APPROVER`. `recheck` runs in the same transaction as the step acting on it: policy, approver still valid, run still running, not halted.

**QA owned:** `QA-007` agent path, `FAULT-06`, threat `SEC-014`.

**Required tests:** the hash binds tool, version, target and exact payload, so changing any one voids the approval. Editing recipients after approval denies. Expiry at execute. Recheck reruns in the same transaction. The initiator cannot approve (`SELF_APPROVAL`). The agent and the model have no path to approve: `decideApproval` refuses an agent context. A service context cannot decide. An approval from another run or Work Unit cannot be used. An approver who loses access: the approval closes. The screen shows initiator, agent, exact payload, data class, risk and expiry, per 02-agent-runtime. Unit tests for approver selection. Browser spec.

### halt: `SEC-06`

The kill switch. **Only used in an incident, so it gets no daily exercise. It must fail closed and work offline.**

**Owns:** `packages/application/src/ai/halt.ts`; `packages/database/src/halt-operator.ts`; `workers/workflow/src/kill-switch.ts`, `kill-switch.test.ts`, `halt-global.ts`; `apps/web/src/app/o/[organizationId]/settings/safety/**`; `tests/integration/ai-halt.test.ts`.

**Implements:**

```ts
createHaltCheck(): HaltCheck
engageKillSwitch, releaseKillSwitch, listKillSwitches      // @ensemus/application/ai-halt, need ai.halt
engageOperatorSwitch, releaseOperatorSwitch, listOperatorSwitches   // @ensemus/database/halt-operator
createHaltWatcher({ pollMs }): HaltWatcher                 // deps may grow: it is your signature
```

**Rules:** `assertRunning` reads global, this tenant's, provider and agent-version rows, and any read failure throws `AI_HALTED`. `halt-global.ts` is the operator's command, like `setup-token.ts`, and reaches only the database.

**QA owned:** `QA-AI-KILL`. Incident doc §5.

**Required tests:** each scope blocks queued runs, the next turn and the next tool. A stop committed with its signal lost still blocks the effect. In-flight call aborted within a measured limit. Unreadable switch state halts. Member cannot engage or release. A tenant cannot engage global or release a global row. Global via the command works with no network. Core read-only work still works while halted. Audited with no content. Unit tests with a fake clock for the watcher.

### timeline: `AGENT-06`, Journey B

Timeline and stop UI.

**Owns:** `packages/application/src/ai/timeline.ts`, `run-control.ts`; `apps/web/src/app/o/[organizationId]/work/[workUnitId]/run/**`; `apps/web/src/app/api/v1/organizations/[organizationId]/agent-runs/**`; `tests/integration/ai-timeline.test.ts`; `tests/browser/specs/agent-run.spec.ts`.

**Implements:**

```ts
getAgentRun, listRunsForWork, listRunSteps     // @ensemus/application/ai-timeline
startAgentRun(database, context, input: StartAgentRun): Promise<AgentRunView>
controlAgentRun(database, context, { agentRunId, kind }): Promise<void>
```

**Rules:** `startAgentRun` needs `agent.run` and change access to the work, reads limits and tools from the version, and commits the run and `agent_run.requested` in one transaction (`emit`, aggregate `work_unit`). `controlAgentRun` needs `agent.stop`, or the initiator's own run, and commits `ai.run_controls` and `agent_run.control_requested`. Words for each `STEP_LABEL_CODES` live in the page. Refuse a run where budget or profile is plainly missing only as a friendly early check: the gateway is what enforces it.

**QA owned:** Journey B.

**Required tests:** only `label_code` and counters shown, so no model text and no chain of thought can reach the page (canary in `step_payloads` absent from HTML, RSC payload and API). Member without work access gets 404. Stop, pause and resume need the right capability, and forged forms are refused and audited. Starting a run commits run and outbox in one transaction. Reconnect shows true state on another replica. Unknown state is stated honestly. Cost labelled estimate for BYOM. Empty, error and loading states. Keyboard and axe. Pure view helpers in unit tests.

### delegation: `AGENT-05`

Child runs. **A union instead of an intersection is an escalation, and recursion spends real money.**

**Owns:** `packages/agent-runtime/src/delegation.ts`, `delegation.test.ts`; `packages/application/src/ai/delegation.ts`; `tests/integration/ai-delegation.test.ts`; `tests/temporal/agent-delegation.test.ts`.

**Implements:**

```ts
intersectScopes(parent, asked): { granted, refused }
allowedDepth(manifestDepth, orgDepth): number
carveChildBudget(parentRemainingMicros, askedMicros): { ok: true; micros } | { ok: false }
createChildRun(database, context, { parentRunId, stepNumber }): Promise<ChildRunResult>
settleChildRun(database, context, { parentRunId, childRunId }): Promise<void>
```

Does not edit the workflow: spine calls these. The `agent.delegate` arguments are in `ai.step_payloads`, read through `@ensemus/application/ai-tool-steps`.

**QA owned:** `QA-013`, `FAULT-09`. Threats `SEC-007`, `SEC-010`.

**Required tests,** unit and integration: child scopes are the intersection, never a union. A child asking for more is denied and audited. Depth and fan-out caps hold at the lower of manifest and org policy. A child's budget is carved from the parent, so the sum never exceeds the ceiling under recursion. Stopping the parent stops children. A child cannot widen a provider allowlist. A child inherits the run's class as a floor. `max_delegation_depth: 0` cannot delegate. A recursive script reaches the ceiling and stops with a budget code. The trigger refuses a wider child, even if the application is wrong. Cross-tenant parent refused.

## Wave 2: needs wave 1 merged

### wiring: `MODEL-02`, `COMM-02`, Slice 3, Gate C evidence

The real parts together, and the honest report.

**Owns:** `workers/workflow/src/agent-main.ts`; `packages/workflows/src/activities.ts` (calls `closeStrandedRun` after `failRun`); `apps/web/src/app/o/[organizationId]/layout.tsx` and nav; the one-line include in `apps/web/src/app/o/[organizationId]/approvals/[approvalId]/page.tsx`; `docs/specifications/openapi.yaml`, `packages/contracts/generated/*`, `tests/unit/openapi-contract.test.ts`, removing `planned` for each operation with a route; `docs/specifications/examples/work-brief.agent.yaml`, `model-conformance-matrix.csv`, `qa-scenarios.csv` and backlog statuses; `tests/stack/ai-slice3.test.ts`, `tests/stack/ai-real-failures.test.ts`, `tests/browser/specs/ai-journeys.spec.ts`, an extension to `tests/stack/restore.test.ts`; `docs/05-operations/**` for the operator's steps; `docs/06-delivery/evidence/M4-report.md`.

**Work:** replace `refusingDeps` in `agent-main.ts` with the real objects: `createInferenceGateway`, `createToolGateway`, `createMinimalContextCompiler`, `createProfileProber`, `createUsageLedger`, `createHaltCheck`, `createHaltWatcher`, `createEntitlements`, `createCredentialLender` over `SecretBroker`, `createEndpointGuard`, `createModelAdapter`. Read `DATABASE_URL_SECRETS`, `SECRET_SEALING_PRIVATE_KEY`, `ENSEMUS_MODEL_CREDENTIALS_REVIEWED` and `ENSEMUS_PRIVATE_MODEL_ENDPOINTS`. Map `EN007` in M3's `beginAttempt` to `WORK_STOPPED`, if M3 has merged.

**Slice 3:** BYOM-shaped profile → vault → deny and allow → fake model → redacted trace and ledger. Then: run → tool → approval → M3 effect → verified → cost measured. **Recovery list on built images:** kill web mid-run, kill worker mid-model-call, retry after external action before receipt, revoke provider mid-run, approve then change proposal, restore DB, delete referenced document, exhaust budget, cancel during tool execution. In Cloud, BYOM and Sovereign tenant modes.

**Report honestly:** `M4-report.md` says what ran and what did not. Everything needing containers is unverified until the owner runs it.

### assurance: `MODEL-06`, `AGENT-16` (harness), `SEC-02`, `SEC-04`, Gate A's AI parts

Evaluation harness and red team. Tests only: **a failure goes back to the owning slice's files through a separate fix, so red-team results are never tuned away in the same change.** Report failures, do not patch them.

**Owns:** `evaluations/{agents,routing,safety}/**`; `tests/eval/**`; `tests/security/**`; `tests/stack/ai-canary.test.ts`; `docs/06-delivery/evidence/m4/**`.

**Evaluation:** a harness that runs a suite over `ScriptedModelAdapter`, and produces an `evaluationReportSchema` report bound to `spec_sha256`, with the experiment identity from 07-evaluation §3 and `scripted_model: true`. Required: it fails when a fixture is deliberately wrong (control). A fabricated citation fails grounding. Reports are versioned. A lower score than baseline blocks. Synthetic fixtures only. **With a scripted model this proves the harness, gates and policy behaviour, not model quality, and every report says so.**

**Red team, QA owned:** `QA-018`, `FAULT-08`, threats `SEC-003`, `SEC-005`, `SEC-007`, `SEC-014`. Canary in artifact, prompt, tool argument and provider error, then dump Temporal persistence, service logs, audit, API and timeline: absent (ADR-024 acceptance row 3, using the existing dump scan with its control). A malicious document says to export or email secrets. A rogue plan tries to switch model to a public provider. A poisoned tool description. Social-engineered approval content changes. An agent asks for an API key. A fake policy in a document does not change policy. Model output claims approval. Each must be stopped by policy with the model's cooperation assumed absent: **the scripted model obeys every injection.** Gateway-level cases in `tests/security`, dump scans in `tests/stack`.

## Owner-led

No agent can finish these, and they have no slice:

- **Booking and passing the outside security review** of ADR-024 D4 and D5 and ADR-028 FD-3, FD-4, FD-10 and FD-21. This clears `FOUND-05`, and M4-owner-live waits on it.
- **Reading a provider's terms and recording them** as `contract_ref`, region and allowed classes, before a real key. Nobody drafts legal terms here.
- **Entering your own key,** after setting `ENSEMUS_MODEL_CREDENTIALS_REVIEWED` and adding the egress overlay, then running the activation probe, conformance and one real evaluation for `MODEL-02` and `MODEL-06`'s real numbers. Never paste a key into a chat with a coding agent, a test or a fixture.
- **Rotating and revoking that key mid-run** and searching logs for it (`BYOM-TS-01`, `SEC-016` on the real path).
- **Setting budgets** (no default) and **reading ADR-028 and migration 0101.**
- **Running everything that needs containers,** when you choose to: integration, stack, browser, upgrade and air-gap gates, and capturing replay histories.
