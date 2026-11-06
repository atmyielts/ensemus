# M4 scripted assurance and real-stack canary gate

Backlog: MODEL-06, AGENT-16 harness, SEC-02, SEC-04; QA-018, FAULT-08, SEC-003, SEC-005, SEC-007, SEC-014. Prepared 2026-11-06 in `codex/m4-integration`.

**Scripted reports validate the harness, publication gates and policy behavior. Real model quality is unverified.** No real provider credentials, customer data or production service was used. No Docker, integration or stack command was run by this assurance agent.

## Implemented evidence

- `evaluations/agents/harness.ts` runs the actual inference gateway/router/policy over explicit in-memory ports and `ScriptedModelAdapter`. It writes strict `evaluationReportSchema` reports bound to the parsed spec SHA-256. A companion experiment pins fixture version/digest, agent/skill versions, prompt digest, scripted deployment/response digest, policy/matrix revision, context assembly, source corpus, runner/scorer, budget and baseline. `model_label = scripted:<experiment_sha256>` binds that companion through the existing strict report schema.
- Publication is exercised through the actual `preparePublication`. Deliberately wrong fixtures fail; lower scores than the accepted baseline block even above the manifest threshold; incompatible/changed baseline artifacts fail; fabricated, omitted, duplicate/extra and stale-hash citations fail grounding; critical failures and spend excess block independently of aggregate score.
- `tests/eval/gateway-red-team.test.ts` uses the actual inference gateway, tool gateway and policy without policy mocks. The scripted model follows every injected instruction. Forbidden secret/model/policy/budget/grant tools, poisoned descriptions, explicit denies, restricted email, forged approval fields, widened delegation, revoked initiators, stops and halts cannot reach an effect port. Egress refusals assert zero credential leases and zero adapter calls. Allowed email and grounded draft positive controls reach the intended approval/draft ports.
- `tests/eval/canary-controls.test.ts` exercises actual context role separation/trace projection, pre-key scanning in every prompt role, tool-argument rejection, provider error normalization, Temporal log projection and payload codec. Scanner controls detect raw/hex/base64/base64url markers and reject missing/empty captures. These are in-process checks, not persistence or HTTP acceptance.
- `tests/fixtures/fake-model/server.mjs` provides bounded, independent per-model script controls, bounded request capture, explicit exhaustion failure and standalone host configuration. Its library default remains loopback. It belongs only to the test overlay. No real key is needed for the private local profile.

Generated artifacts come from actual scripted executions:

| Artifact | Intended result |
| --- | --- |
| `scripted-baseline.json` | Passing four-case synthetic baseline |
| `scripted-wrong-fixture-control.json` | Fails a deliberately wrong critical expected answer |
| `scripted-baseline-regression-control.json` | Fails a lower score than the baseline |
| `scripted-fabricated-citation-control.json` | Fails an invented source citation |

Reports contain IDs, digests, codes and counters; no raw prompt, model answer or source passage is copied into them. Digests provide reproducible association, not a signature or authorization to substitute an untrusted baseline.

## Real stack gate: written, not run by this agent

`tests/stack/ai-canary.test.ts` drives HTTP signup, organization creation, publication, work creation and run start through the built proxy/web. Only active keyless private profile qualification and budget setup are explicit DB seeds; the test does not claim profile activation or legal/commercial onboarding acceptance.

The journey places distinct runtime markers in an S3 artifact, published instructions, model-issued draft arguments and a raw provider 500 response. The real worker must load the artifact, call the private fake, commit the cited draft, feed the tool transcript into a second model turn and finish with the provider failure. Positive controls require exactly two fake requests, the expected source/prompt/tool markers in those requests, an S3 draft and its DB evidence, transient payload cleanup, a completed Temporal workflow carrying the failed domain outcome and nonempty audit/API/page captures. It scans actual Temporal database dumps, service logs, audit, run/step APIs and HTML/RSC timelines on both replicas. A separate unprotected Temporal workflow is a positive dump-scan control. BYOM and Sovereign are covered by named cases; Cloud is not covered by this new fixture.

Required existing test-stack wiring:

- `agent-worker`, ordinary workflow worker, dispatcher, Temporal, database, object storage, proxy and both web replicas running the joined image/migration.
- Test-only `fake-model` bound to `0.0.0.0:8000`, private agents network address `${ENSEMUS_NETWORK_PREFIX:-172.30}.7.20`, host control `127.0.0.1:${ENSEMUS_TEST_MODEL_CONTROL_PORT:-58026}`.
- Operator private-model allowlist includes `http://fake-model:8000`; profile URL is `http://fake-model:8000/v1`. Keyless local inference leaves the real credential review interlock in place.
- Existing helper ports: PostgreSQL 55432 (or `ENSEMUS_TEST_PG_PORT`), Temporal 57233, object storage 58333, proxy base `ENSEMUS_TEST_BASE` (default `https://localhost:8443`). Existing generated local role/storage/codec secrets are used, never pasted into reports.

The `stack` Vitest project already includes the new file. Opt in explicitly; missing worker/fake-model wiring fails rather than passing silently:

```powershell
$env:ENSEMUS_AI_ENABLED = 'true'
pnpm exec vitest run --project stack tests/stack/ai-canary.test.ts
```

## Local commands and boundaries

Focused commands run by this agent:

```powershell
pnpm exec vitest run --project unit tests/eval tests/contract/real-adapters.test.ts packages/application/src/ai/tool-approvals.test.ts
pnpm exec eslint --max-warnings 0 evaluations tests/eval tests/security tests/stack/ai-canary.test.ts tests/fixtures/fake-model/server.mjs tests/conformance/fake-model.ts tests/conformance/adapter-conformance.suite.ts packages/application/src/ai/tool-approvals.ts packages/application/src/ai/tool-approvals.test.ts
pnpm exec tsc --noEmit --target ES2023 --lib ES2023 --module ESNext --moduleResolution Bundler --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --esModuleInterop --skipLibCheck --types node tests/eval/scripted-harness.test.ts tests/eval/gateway-red-team.test.ts tests/eval/canary-controls.test.ts tests/eval/fake-model-controls.test.ts tests/eval/scripted-evidence.test.ts tests/stack/ai-canary.test.ts
```

Focused strict TypeScript and ESLint passed. The final focused unit run passed **403 tests in 7 files**. No result from an unrun command is counted. Prettier and `git diff --check` passed for owned code; the evidence generator passed separately and wrote the four JSON artifacts. Regenerate the four synthetic artifacts explicitly:

```powershell
$env:ENSEMUS_WRITE_M4_EVIDENCE = '1'
pnpm exec vitest run --project unit tests/eval/scripted-evidence.test.ts
```

No Vitest configuration change is required: unit already includes `tests/eval`; no-DB security support uses plain `.ts` imports rather than `.test.ts` files that would inadvertently enter the database-backed security project.

## Joined approval fixes and read-only composition review

The parent separately assigned two approval regressions. `tool-approvals.ts` now treats failed work as stopped for sends (the kernel intentionally permits failed work to be reopened, so its general terminal predicate was insufficient). New requests also refuse completed/failed/cancelled work. The recheck closes consent when the approver loses access before returning a simultaneous export-policy refusal; binding, initiator, lifecycle and expiry checks still precede closure. Restricted export remains refused when access is retained. Five regressions were added, including actual `decideAction` behavior, and the focused approval suite passed 144 tests.

The actual-adapter timeout test now gives SDK/DNS setup time to reach the local server, observes the first request and still requires timeout normalization plus exactly one request. This avoids treating a pre-send scheduling race as a retry defect.

Read-only review found no high-confidence blocker in current `agent-composition.ts`, `agent-main.ts`, bounded S3 read or role provisioning: both router and gateway receive the tenant bundle; supported Temporal connection options and direct activity context are used; credential interlock remains; S3 checks advertised and streamed byte size and destroys the body; agent provisioning rejects elevated attributes and unexpected memberships. This source review does not replace real upgrade, egress, persistence or runtime acceptance. Outside security review, real-provider qualification/terms/key rotation, full container gates and real model evaluations remain owner/root gates.
