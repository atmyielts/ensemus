# M4 agent workflow replay — recorded and replayed

`AGENT-02`, `AI-13`, `MODEL-01`; ADR-028. Recorded on 2026-11-06 UTC / 2026-11-07 Asia/Tashkent against the pinned Temporal TypeScript SDK 1.25.0 and the current, unmodified workflow implementation.

## Result and scope

The real Temporal capture batch passed **4 tests in 2 files** in 93.50 seconds. It added **33 histories**: 28 completed agent executions, one first execution that actually continued as new, and four model-probe executions. The subsequent offline verification passed **107 tests in 3 files** in 48.14 seconds. `Worker.runReplayHistory` replayed all **71 histories**, including the 38 original histories. No original history was modified or overwritten.

The agent command histories cover completed and unverified output; cost exhaustion; unavailable model, invalid output and policy denial; stop/halt before and during a model Activity; native workflow cancellation; pause/resume; approval done, denied and unknown external state; direct tool denial; successful, failed, refused and failed-to-start child executions; nothing queued; failed and genuinely unregistered model Activities; final-output/tool-wait/next-step resume points; denied reclaim; and a genuine server-suggested continuation. Assertions check actual terminal results and stop codes, the dedicated Activity queue, encrypted payloads, cancellation acknowledgement, durable waits/signals, child commands, reuse of the approved tool step and the absence of a second initial claim on resume. Missing required histories fail the gate.

The model probe covers passed, failed, skipped and Activity retry exhaustion. Capture-time assertions require exactly two attempts for the retry-exhausted case and one for the other outcomes; corpus assertions decode the actual recorded outcome.

## Genuine continuation evidence

`agent-run-continue-as-new.json` has 4,241 real events, including 3,616 empty control signals and five workflow-task events carrying the server's `suggestContinueAsNew` flag. Its final event is `EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW`. No workflow source hook, patched workflow bundle or fabricated event was used. The bounded capture sends at most 20,000 signals in batches of 32 while the authoritative scripted directive remains paused; the actual server suggestion triggers the production continuation branch.

The first run ID is `01a1b242-dc5a-76cc-bc29-cbc901301b98`. Its continuation event names `c5d6cbac-a283-47bf-ab57-323ac7fbbbe7`, whose 121-event history is `agent-run-continued-resume.json`. The resumed execution points back to the first run, receives the same agent run ID and next-step carry, invokes `reclaimAgentRun` and `readResumePoint`, and completes. Both links are asserted, so two unrelated captures cannot stand in for a continuation pair. An incomplete on-disk pair is refused rather than silently replaced.

## Harness and privacy boundary

The capture uses a real Temporal service at the isolated test port 57234, real SDK workers, the repository's real workflow bundle, public `REPLAY_KEY` and synthetic Activity implementations. Only synthetic organization/work/run IDs, enums, bounded counters and deliberate sanitized faults cross the Activity boundary. No database, provider credentials, customer documents, model prompts or tool arguments are used. These are workflow durability fixtures, not real-model quality evidence or provider qualification.

The parent stopped only the isolated M4 agent worker before capture. This prevented a worker with the deployment codec key from taking public-key corpus Activities on `ensemus-agent`. All capture workers drained and stopped before the parent was told it could restart that worker. This agent performed no Docker operation. The offline replay phase needs no running Temporal server and polls no deployed queue.

`capture-support.ts` retains existing callers, adds an optional precise start callback and Activity heartbeat throttle for real cancellation tests, writes with exclusive creation, and cancels/drains failed captures before its workers close. The cancellation fixture uses supported `Context.current()` and a direct pinned test dependency. No production schema, API, configuration, credential or workflow logic changes are part of this slice.

## Commands actually run

```powershell
pnpm install --offline --frozen-lockfile --ignore-scripts --filter @ensemus/tests
pnpm exec tsc --noEmit -p tests/tsconfig.json
pnpm exec eslint tests/replay/capture-support.ts tests/replay/agent-run-paths.ts tests/replay/capture-agent-run.test.ts tests/replay/history-payloads.ts tests/replay/agent-run-corpus.test.ts tests/replay/capture-model-probe.test.ts tests/replay/model-probe-corpus.test.ts
pnpm exec vitest run --project unit packages/workflows/src/model-probe.test.ts packages/workflows/src/model-probe-activities.test.ts packages/workflows/src/agent-activity-lifecycle.test.ts

& { . ./.local/m4-stack-env.ps1; $env:ENSEMUS_CAPTURE_REPLAY = '1'; pnpm exec vitest run --project replay tests/replay/capture-agent-run.test.ts tests/replay/capture-model-probe.test.ts } *> .local-m4-replay-capture.log
pnpm exec vitest run --project replay tests/replay/agent-run-corpus.test.ts tests/replay/model-probe-corpus.test.ts tests/replay/replay.test.ts *> .local-m4-replay-verification.log
```

The offline frozen install succeeded without resolution or network access. Test TypeScript and scoped ESLint passed; the focused unit batch passed **24 tests in 3 files**. Prettier formatted the owned source. Capture output is retained locally in `.local-m4-replay-capture.log`; replay output is in `.local-m4-replay-verification.log`. The local environment script and logs are not required for CI: the normal replay project loads committed histories without the capture opt-in.

After the initial green replay batch, the harness gained the incomplete-pair refusal and the corpus gained explicit run-ID link assertions. The parent's final full replay run passed **158 checks in six files in 43.73 seconds**, with **20 opt-in capture checks skipped**. It replayed all 71 histories and executed the new link assertions. The capture-only incomplete-pair refusal is source-inspected, not claimed as an executed negative test. New history JSON was then formatted to the repository's existing style; no original history or event content was changed. `git diff --check` passed for the owned tracked changes. The full replay log is `.local-m4-replay-final.log`.

This slice does not reproduce a killed operating-system worker, a rolling worker deployment, an absent-worker schedule-to-start outage or a database/real-provider recovery. Those remain distinct Temporal/runtime acceptance checks; the unregistered-Activity history is not an absent-worker substitute. Cloud, BYOM and Sovereign share this deterministic workflow implementation, but these captures do not independently establish each mode's deployment, network, persistence, upgrade or backup acceptance.
