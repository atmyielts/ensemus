# Durable Knowledge model bridge: source checkpoint

This is implementation evidence for the M4/M5 privacy and model-runtime join. It does not close
M5, M8, the integrated platform, provider qualification, production billing or native MFA acceptance.
Migration 0216 is authored here; its journal/snapshot/application belong to the integrator.

## Implemented boundary

Knowledge uses genuine `embed`, `rerank` and `answer` purposes. Qualification is a fixed synthetic
operation, pinned to the actual profile/version, protocol and (for native embeddings) dimension and
vector-space version. A legacy text probe cannot qualify embedding or ranking. Unqualified legacy
spaces remain historical and cannot become active. Equal aliases across profiles are distinct spaces.

A standalone Knowledge job has its own durable requester, explicit workload approval, immutable
request hash/key, deadline and caller bounds. A job never impersonates an AgentRun. Auxiliary agent
calls retain the real run, model step and initiator. SQL requires exactly one of those principals for
each call, reservation and canonical usage row. Profile/rate/mode/period/class/policy snapshots stay
attached to the actual call. Commercial values come from approved rows; source has no price default.

The HTTP process commits the query job and polls metadata/results. It never obtains the query payload,
key or model adapter. Immediate lexical search remains immediate. Model jobs dispatch by immutable ID
to the actual agent queue; ingest requests approved embedding jobs, and answers reuse their one durable
answer workflow. Both model Activity timeouts cover the existing 86,400-second technical bound. Every
provider call still obeys its actual immutable job deadline and cancellation; that ceiling is no spend
default. Paid model Activities have maximumAttempts=1. The keyless fallback can only refuse an actual
unclaimed zero-attempt job under the row lock; it cannot report a paid result or certify private deletion.

The actual native embedding adapter uses the provider SDK's embedding operation, one guarded request,
explicit returned indices, dimension/finite/nonzero checks and actual usage. Ranking uses a bounded
structured protocol with unique in-range positions. Missing capability, approval, secret/network
permission, budget, entitlement or policy authority refuses. Tenant policy and secret scanning run
before dispatch. Public and hosted keys never fall back to environment credentials.

All actual input IDs/hashes/classes are persisted before dispatch. Source/document/catalog locks
precede checkpoint/attempt locks. Agent structured refs must already exist in the actual run read ledger;
the bridge cannot reconstruct a read afterward. Every optional reranker candidate is retained even if
the final ranking drops it. Run-bound chunk inputs become actual run/viewer evidence packages, and
answer jobs retain all call sources. Fresh named-viewer ACL, current source/record class and deletion
checks guard dispatch, publication and serving. Structured hashes are historical: ordinary edits do
not invalidate a receipt merely because mutable content changed.

Provider response and domain acceptance are separate states. A per-principal factory issues opaque
in-memory receipt capabilities for the actual immutable call, then rechecks SQL principal/input authority
and the actual vector/answer/evidence write inside the same publication transaction. Savepoint rollback
restores every temporary tenant/actor/run/protocol binding on error; success restores them explicitly.
A copied/foreign receipt cannot be accepted. Acceptance is idempotent only for the same result target.

Unknown paid attempts are never resent. They retain conservative money/token accounting and settle
estimated canonical usage once. `reconcileRun(serviceContext, runId)` is an agent-role metadata-only
seam that requires the real terminal run and permanent checkpoint fence; prepared calls free-refuse,
dispatched calls charge the reserved estimate. Legacy lost-attempt/finish cleanup excludes auxiliary
model-call holds. Until the integrator binds finish/reclaim reconciliation, those holds remain held.

Only the actual agent role can delete private job payloads. It fences the durable job, deletes, verifies
actual COUNT0 and records an immutable matching fence-generation receipt under the same lock. Late
payload insertion is permanently denied. Eraser gets metadata proof only. Unknown object puts remain
an independent physical-proof obligation; a transcript receipt never proves object quiescence.

## Preliminary checks actually executed

On 2026-11-07 before the later regression/timeout/locking additions:

- Frozen offline ignore-scripts workspace install passed; cached linking only, no download/version change.
- Scoped Prettier, ESLint (zero warnings) and `git diff --check` passed.
- Three focused unit files passed: 21 tests (bounds/qualification, actual SDK embedding adapter,
  gateway dispatch/secret/budget/usage/unknown-response behavior).
- Sequential database, application, intelligence, Knowledge, workflows, worker, web noemit and
  integration-test types passed. Web used `tsc --noEmit`, without Next build/type generation.

The final bounded source batch on 2026-11-07 passed:

- Actual contracts/OpenAPI generator, scoped Prettier/ESLint (zero warnings) and diff whitespace checks.
- 52 tests across six files: four new model/adapter/gateway/transport files plus existing answer-step
  and OpenAPI contract regressions, with maximum one Vitest worker.
- All eight sequential types: database, application, intelligence, Knowledge, workflows, worker,
  web `tsc --noEmit` and integration tests. Two test fixture assignment signatures were corrected
  against the real DAL before the final tests noemit pass.

No database migration, real-role suite, Docker/build/browser, Temporal runtime, live provider or
Cloud-funded operation was executed here. The last SQL-only class-floor guard is also unexecuted.

`tests/integration/knowledge-model-jobs.test.ts` now authors actual-role cases for explicit authority,
request immutability, private-payload/tenant isolation, exclusive money identity, actual publication and
duplicate receipt, wrong job/call/tenant, rollback/GUC restoration, stale source/Work revocation, raised
class, historical hashes, unknown paid outcome, fallback contention, permanent COUNT0 fence,
terminal auxiliary accounting, approved embedding-space identity and absent Cloud credit hold.
These cases are authored, not executed. Qualification fixtures use an explicit test-only admission
adapter and synthetic provider output; they are not native-session/MFA/provider acceptance evidence.

## Integration obligations

- Join 0216 schema configuration, canonical snapshots/journal and actual fresh PostgreSQL gate.
  Preserve root-owned 0208/0211/0213/0215 repairs, M7 registrations and onboarding composition.
- Bind new approval/qualification ports to the actual native branded interactive context and
  `assertInteractivePrivilege` in the effect transaction: `model_workload.approve` and
  `model_profile.activate`, respectively. Missing binding refuses. M7's 0404 SQL backstop explicitly
  depends on 0216; its joined native-session fixtures must supply real admission.
- Pass actual modelStep and cancellation to agent compilation; start heartbeat/halt watching before
  auxiliary calls. Re-read run counters/headroom afterward and preserve the main gateway's conservative
  price/token envelope and genuine `reason` profile/policy bundle. Main-purpose authorization is an
  explicit callback; it is never an alias through Knowledge `answer`.
- Preserve the final executor's fresh classification check across **all** retained earlier influences,
  including dropped candidate sources/documents and actual historical structured refs. 0216's
  `model_call_inputs_readable` / `model_job_inputs_readable` compare current source, document and
  structured class against the pinned call/output class. `assert_model_call` also refuses a call below
  the run's independently raised effective class. Root's final main-context envelope must compare every
  retained current class with the requested envelope; access alone is insufficient. Future actual
  `object_record` typed refs must join those checks and the actual-before-material read ledger, without
  backfilling history or accepting a browser/model flag.
- Bind `knowledge.calls.reconcileRun(createServiceContext(org), runId)` on both actual finish and
  reclaim after terminal fencing, including initiator loss. Retry reconciliation only; never replay
  a paid network request. Cloud reconciliation needs the same genuine credit hold binding as dispatch.
- Supply the real M8 approved-card/credit hold port for Cloud/Ensemus-paid calls. Absence refuses and
  rolls back all holds. Include standalone model-job canonical usage in M8 billing. Never infer a
  micro-USD/credit or credit/currency conversion. Call-specific estimated-usage correction is not
  implemented by this checkpoint and must not bypass immutable receipt validation.
- Extend 0999's exact append-only deletion whitelist/FK order for new metadata; re-grant only metadata
  SELECT/receipt EXECUTE to an eraser provisioned after 0216. Private-payload deletion/certification
  remains agent-only, hold-aware offboarding drains/fences first, and retained source/provenance rows
  still require independent physical proof. Missing cleanup binding must leave nonzero remaining work.
- Complete fresh-role receipt/revocation/contention/eraser gates, full integration, workflow replay,
  browser, worker image/offline and actual provider tests. No source result is a runtime gate.
# Follow-up from the parent's 57-migration gate (source only, 2026-11-08)

The parent's next fresh-57 rerun passed the actual restricted revocation case and reached 24 of 25 model-job cases. The remaining old-attempt assertion expected the older 0216 code EN120, while 0414's earlier `MAIN_MODEL_RUNTIME_REQUIRED` backstop correctly returns EN119. The source assertion now admits only the actual before-body read scope (without a main-model protocol stamp), requires that exact EN119/message, and separately verifies the step's attempt/state are unchanged. This isolates the genuine main-writer boundary as later read-authority guards are joined. No runtime guard changed, and this assertion follow-up has not yet been executed.

The parent applied 57 migrations and reported 23 of 25 model-job cases passed. One remaining case exposed a real PL/pgSQL name collision: `guard_model_money_principal` used `c` as both a local call row and an EXISTS table alias. The source repair renames only that SQL alias, preserving the exact money/principal admission.

The other test incorrectly treated unassigning INTERNAL Work as a read revocation; internal Work is intentionally readable by current members. The corrected fixture uses RESTRICTED Work and explicit matching restricted job/route/input/result protection. It asserts the actual named viewer becomes unreadable after unassign, then requires fresh-result inspection and transactional acceptance to refuse, preserving already-settled usage and the unaccepted receipt. It still verifies that an ordinary Work text update does not invalidate historical input hashes. No production ACL or result-acceptance guard was weakened.

These two follow-up source edits have not run format, lint, types, units or database checks in the author checkout. The parent owns the fresh migration/database rerun; its preceding 23-pass result is not acceptance of this repair.

# Approval locking-read repair (source only, 2026-11-08)

The parent's fresh 55-migration run reported 109 cases: 90 passed and 19 failed. Fourteen model-job failures reached `ai.assert_model_call` but the approval lookup returned no row: PostgreSQL applies UPDATE USING to `FOR SHARE`, and the approval policy allowed that locking visibility only for `actor_type=user`.

The 0216 repair aligns UPDATE USING with the existing tenant metadata SELECT. WITH CHECK now requires the actual app login/role and user actor. `ai.model_manager` independently requires both `current_user` and `session_user` to be `ensemus_app`, preserving fresh active owner/admin checks and preventing an agent login from obtaining mutation authority with SET ROLE plus mutable actor bindings. Conservative revocation still needs no fresh MFA proof; qualification and approval creation retain their separate native admission backstops.

The authored real-role regression pins approval metadata as delegated, agent and service workers, rejects their mutation and an agent login impersonating the app role, denies foreign-tenant lookup/mutation, and verifies ordinary app-owner conservative revocation. No format, lint, type, unit, SQL or database command was run for this repair while the parent's serialized verification slot was occupied. The migration and regression require the parent's fresh database gate; the earlier aggregate result is diagnosis evidence, not repair acceptance.

