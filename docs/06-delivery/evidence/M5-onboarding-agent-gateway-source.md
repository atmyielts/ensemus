# M5 onboarding agent gateway source follow-up

Status: source authored and scoped source checks passed on `codex/m5-onboarding`
from `91e7836`. This is an
AGENT-12/AGENT-06 composition slice, not M5 completion or provider qualification.
The earlier M6 source checkpoints remain on their own branch.

## Behavior

- The public run API remains person-only. A private shared transaction kernel is
  the only run/outbox/audit insert path; both callers refresh the real initiating
  member's active status and `agent.run` authority. Delegated workers retain their
  actual actor type.
- The worker admission seam accepts only `client-brief` and an actual saved
  onboarding ID as its stable request key. It checks the requesting member, exact
  brief Work, all four objective/owner/hierarchy/project pins, active participants,
  and the selected reviewer's human contributor assignments on brief/review Work.
  New admission requires the saved `started` state and exactly one currently active
  published `client-brief` definition/version with a matching spec and live identity.
  It neither creates nor publishes an agent definition.
- The actual run ID, outbox event, audit entry and onboarding's waiting-state
  transition commit together. The state machine rereads that binding rather than
  accepting an unbound adapter response or writing a second state version. Retries
  return the same saved run ID, including after that run has ended.
- Each later advancement rechecks the selected reviewer's current assignments.
  Known unavailable publication/model/budget setup produces an explicit stopped
  outcome. Database contention, deadlocks, serialization failures, outages and
  unknown errors propagate for workflow retry; they are not converted into a
  permanent unavailable outcome.
- Status reads bind the saved onboarding to the actual run, brief Work and initiating
  member. Cost is the signed usage-ledger total (including corrections); no measured
  model row means `null`. Run counters are not a substitute for ledger evidence.
- Output IDs come only from settled, complete, live `agent_run` provenance belonging
  to that exact run/Work/member, with the authoritative named-viewer artifact
  readability check. Human uploads and unrelated attachments do not qualify.
  At most two IDs are returned, sufficient to refuse an ambiguous brief honestly.
- The platform worker registers the existing onboarding activities with this actual
  adapter. No model/provider call runs in this request transaction or base worker.
- SQL advancement retries use exponential intervals from one second to one minute,
  without the earlier three-attempt cap. Its Activity failure boundary emits only
  fixed messages/codes and empty details; known authority/configuration refusals are
  nonretryable, while temporary restore/version races and unknown infrastructure
  failures remain retryable. Actual Temporal retry/replay execution is unrun.
- The detail page uses centralized plain-language outcome wording. Technical codes
  remain in the optional details section.

## Qualification boundaries

The root integrator owns migration `0215`: tenant-safe run FK; direct SQL binding
checks for exact queued root run, fresh rights, all immutable pins and assignments;
assignment mutation serialization through parent Work; and active-publication
serialization/ambiguity checks. This branch does not author or register that SQL.
The source is not a substitute for applying and exercising those guards.

The publication advisory key agreed with the integrator is
`ensemus:agent-publication:<lowercase organization UUID>:<lowercase definition UUID>`,
hashed by `pg_catalog.hashtextextended(text, 0)`. The SQL trigger owns the locking;
this source adds no parallel advisory-lock implementation.

No secret, provider endpoint, deployment mode or license change is introduced. The
adapter uses existing tenant application-role metadata reads, not private
transcript privileges. Cloud/BYOM/Sovereign provider/operator acceptance, actual
agent/model execution, grounded human acceptance, welcome-email approval and real
receipt/cost remain separate unexecuted gates for this follow-up.

## Validation record

The following commands ran in this checkout, sequentially where applicable:

| Command / scope | Actual result |
| --- | --- |
| `pnpm exec prettier --write <owned files>` then `--check` on the same inventory | Final pass, 17 matched source/config files. The Markdown evidence path is ignored by repository formatting policy. First write found one extra closing parenthesis in the new status query; corrected before the successful checks below. |
| `pnpm exec eslint <16 owned TS/TSX files>` | Pass. |
| `pnpm exec vitest run --project unit --maxWorkers=1` with the seven files listed below | 7 files, 110 tests passed. |
| First `pnpm --filter @ensemus/application typecheck` | Failed on missing local workspace links inherited from the reused M6 checkout (`@ensemus/policy`, `@ensemus/knowledge`, agent-runtime's `@ensemus/domain`). |
| Integrator-authorized `pnpm install --offline --frozen-lockfile --ignore-scripts` | Passed: 10 reused, 10 added, 0 downloaded; resolution skipped; lockfile unchanged. No scripts or network installation. |
| Rerun `pnpm --filter @ensemus/application typecheck` | Passed. |
| `pnpm exec tsc --noEmit -p tests/tsconfig.json` | Passed. Includes authored integration tests, not their execution. |
| `pnpm --filter @ensemus/worker typecheck` | Passed. |
| `pnpm --filter @ensemus/web exec next typegen` then `pnpm --filter @ensemus/web exec tsc --noEmit --incremental false` | Both passed. |
| `pnpm --filter @ensemus/workflows typecheck` | Passed, including the new activity/workflow unit source. |

Focused unit files:

- `packages/application/src/ai/run-control.test.ts`
- `packages/application/src/ai/timeline.test.ts`
- `packages/application/src/knowledge/onboarding-run-port.test.ts`
- `packages/workflows/src/client-onboarding-activities.test.ts`
- `packages/workflows/src/client-onboarding-workflow.test.ts`
- `packages/workflows/src/client-onboarding-step.test.ts`
- `tests/unit/onboarding-view.test.ts`

The authored integration tests cover actor boundaries, concurrent/lost-response
idempotency, transaction rollback, retryable failures, unbound adapters, missing or
ambiguous publication, cross-tenant/member/Work identity, stale authority and pins,
reviewer removal, corrected ledger cost, generated-output provenance/revocation,
human upload exclusion and plain-language fallback wording.

Database/integration, migration, browser, Docker, build and provider gates are unrun.
Existing state-machine fixtures now request actual M4 runs; explicit test-only status
overrides still isolate state-machine refusal paths and are not product defaults.
