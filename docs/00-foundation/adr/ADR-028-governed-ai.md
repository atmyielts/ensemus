# ADR-028: Governed AI

**Status:** Proposed. FD-3, FD-4, FD-10 and FD-21 need outside security review before any real credential is stored, alongside ADR-024 D4 and D5 and ADR-027 D2. **No real credential has been stored or used:** every test uses generated values and local fakes, and a machine check refuses a hosted key until the review has happened (FD-21).
**Date:** 2026-11-06
**Deciders:** Project owner; security owner for FD-3, FD-4, FD-10, FD-14 and FD-21.
**Backlog:** `MODEL-01–04/06`, `AGENT-01–06/15/16`, `AI-13`, `COMM-02`, `SEC-01/02/04/06/11/13/14`. Exit: Slice 3, `QA-009/010/012/013/014/018`, Gate C for one agent.

## Context

M4 is the first time Ensemus lets something it does not trust decide what to do next. Everything below follows from four facts:

- **A model is untrusted.** A document can tell it what to do, and it may obey. So no check may rely on the model behaving, and tests script a model that obeys every injection.
- **The obvious authority is the wrong one.** `createServiceContext` passes every functional test, and it skips every Work Unit check in `packages/application/src/work.ts`. RLS only confines it to the tenant, so an agent on that context would read restricted work its initiator cannot.
- **A provider may bill for a call whose answer was lost.** Temporal retries, workers die, and a retry that forgets a lost call under-counts spending.
- **M4 exit splits in two.** The owner wants to use this with their own key, and no real key may exist before the outside review. So **M4-code-complete** passes everything with fakes and no outbound access, and **M4-owner-live** is the owner's own step after the review.

## Decisions

Each decision is numbered FD ("foundation decision"). Where one belongs to the owner, this takes the safest reversible default and says so under [Open questions](#open-questions-for-the-owner).

| # | Decision | Why |
|---|---|---|
| **FD-1** | `agentRunWorkflow` runs under the standard `workflowIdFor(input)`, `work-<org>-<workUnit>`, with input `{organizationId, workUnitId}`. The first Activity finds the queued run in PostgreSQL. One live execution per Work Unit | The dispatcher cannot read payloads (ADR-024 D4), so it can only pass the aggregate ID. `approval.resolved` and `work.stop_requested` then work unchanged. `reconcileStrandedRuns` probes exactly this ID, so **a workflow under any other ID would read as closed, and its work would be failed** |
| **FD-2** | A new process, `agent-worker` (`workers/workflow/src/agent-main.ts`), polls a new queue, `ensemus-agent`. Workflow code stays on `ensemus-platform`. `agentRunWorkflow` uses `proxyActivities({taskQueue})` with `scheduleToStartTimeout` | A compromise of what holds keys and reaches models should not reach everything else. Spec 09 already calls for a separate agent queue |
| **FD-3** | **`createAgentContext` carries `actorType: 'agent'` and the initiator's membership, re-read from PostgreSQL at every model turn and tool call. Agent code may not import `@ensemus/database/service`, by lint** | See Context. Disabling the initiator stops the run (04-security/04 §6). Reading work falls through to the same ACL path a person gets |
| **FD-4** | New role `ensemus_agent`, `IN ROLE ensemus_app`, so existing tenant policies apply. It alone reads and writes `ai.step_payloads`, and writes usage, reservations and egress decisions. Web keeps `ensemus_app` | Web and worker share `ensemus_app` today, and web is the largest attack surface. This way web can never read a prompt or forge a receipt. Extends ADR-024 D4 |
| **FD-5** | Prompts and model output live in `ai.step_payloads`, tagged with class and SHA-256, reachable only by `ensemus_agent`. Temporal carries IDs and counters. They are deleted when the run ends. No token streaming in M4 | The next turn needs the transcript, yet default traces may not hold it |
| **FD-6** | Money is `bigint` micro-USD everywhere (`*_micros`), and integers in contracts. `max_cost_usd` is decimal text, parsed once by `usdToMicros` at publish | Floats break reconciliation. No price is in code: rates are data, on `ai.rate_cards` |
| **FD-7** | One status list, `AGENT_RUN_STATUSES` in `@ensemus/domain/ai`, and a `STOP_CODES` list. A failed run stays failed, and a retry is a new run on the same Work Unit | Three lists conflicted. "An AgentRun is a single execution attempt" |
| **FD-8** | Fixed order: entitlement → headroom read → actor and class → candidates → capability → egress decision → reservation → pre-send scan → key → adapter → output validation → ledger | Follows 07-commercial §6 and `MODEL-04`, and a denied call reserves nothing and opens no key. An entitlement can never override a policy denial |
| **FD-9** | Fallback is off by default. It exists only as an explicit, ordered `fallback_profile_ids` on a profile, each entry passing the full check again. Never across `billing_owner` without a stored pre-approval. Model turns only, never tools | Reconciles five conflicting statements in the docs. `QA-009`: a BYOM outage must not fall back to a cheaper Ensemus model |
| **FD-10** | Hosted kinds have a fixed host list in code. `openai_compatible` needs an HTTPS public address. Private addresses need an **operator's** setting, `ENSEMUS_PRIVATE_MODEL_ENDPOINTS`, never a tenant's. Redirects are errors, and DNS is resolved once and pinned for the connection. **The sealed key's `purpose` includes the profile ID and endpoint digest, so it is inside the AES-GCM AAD. A trigger on `endpoint_url` change clears `secret_ref`, returns the row to draft and bumps its version** | A tampered endpoint row cannot make the broker release the key: `SecretBroker.withSecret` already checks purpose and AAD, so it needs no change. Covers `TR-022` and `FAULT-10` |
| **FD-11** | **Provider packages only (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`), called once through `doGenerate` behind our `ModelAdapter`, with an injected guarded `fetch` and a fresh instance per call. `ai` core is banned by lint.** Every SDK error maps to an enum at the adapter's boundary | Amends the plan's "AI SDK with `maxRetries: 0`". Docs checked via Context7 on 2026-11-06: core retries by default (`maxRetries` 2), and `AI_APICallError` carries `url`, `requestBodyValues` and `responseBody`, so **logging one leaks the prompt**. Core also depends on `@ai-sdk/gateway`, and a bare model string can resolve to a hosted gateway. Skipping core removes the retry loop, the second step and that path by construction. Pinned to versions at least two weeks old. Direct `fetch` stays acceptable under ADR-019 if a provider package fails conformance |
| **FD-12** | A model turn's step row is written `in_flight` with attempt N and a reservation before the call, with no transaction held during it. On retry: completed step → the stored outcome. `in_flight` from an earlier attempt → a ledger entry `status='estimated'` at the reserved amount, settled, then attempt N+1 if headroom remains. Key: `model:<run>:<step>:<attempt>` | Budgets must over-count rather than under-count |
| **FD-13** | `effective_classification` on a run only rises (a trigger holds this), by strongest-of across the Work Unit, every included artifact and every tool output. Each turn runs egress again. A run is pinned to `(profile_id, profile_version)`. If the profile no longer qualifies or its version moved, it stops with `policy_denied`, with no reroute in M4 | Mixing inherits the strongest class. `BYOM-TS-01` |
| **FD-14** | A deterministic pre-send scan in `@ensemus/policy`: key shapes, PEM blocks and tenant canaries. A hit raises that part to `restricted`, which normally denies egress. It logs codes only. New ticket `SEC-13` | Class alone lets a key inside an approved confidential document through. It is an extra signal and never the only boundary, and the residual risk is stated in operator docs rather than claimed away |
| **FD-15** | `governance.kill_switches`, with scopes `global`, `organization`, `provider`, `agent_version`. Tenant scopes are written by people with `ai.halt`. `global` and `provider` have no tenant and are written by an operator's command using the migrator role. Checked in PostgreSQL before every model call and tool effect. `agent-worker` polls and aborts in-flight calls. **Unreadable state counts as halted** | ADR-024 D3 needs a check before each effect. `model_profiles` is per tenant, so a global disable needs a home of its own, and no role has BYPASSRLS |
| **FD-16** | A child gets its own child Work Unit (`parent_id`) and a native Temporal child workflow with the standard ID. Scopes are the stored intersection. Its budget is carved from the parent's. Depth is the lower of manifest and org policy. A trigger refuses a child wider than its parent | `approvals_one_open_per_work` means two runs on one Work Unit would block each other's approvals. Native children give join and cancel propagation |
| **FD-17** | `createMinimalContextCompiler` until M5's `KNOW-03`: the Work Unit, attached text artifacts and allowed tools, with ACL rechecked at load. Structured roles separate policy, task, evidence and tool output, and only `policy` reaches a model's system role. Hard caps. New ticket `AGENT-15` | Every M4 turn needs context and a class, and `KNOW-03` is M5 |
| **FD-18** | Tools are code, not a table: `TOOL_MANIFESTS` in `@ensemus/domain/ai-tools`. M4's set is `work.read`, `artifact.read_text`, `artifact.draft.create`, `email.send` (via M3, needs bound approval) and `agent.delegate`. **No `secrets.*` tool exists at all** | Fewer tools mean fewer ways to attack. `sales-researcher` needs tools that do not exist |
| **FD-19** | Publishing is an upload with `agent.publish`. The server checks the schema, lints grants, requires a passing report bound to `spec_sha256` and the policy version, then writes an immutable row. "Signer" means publisher membership plus SHA-256. No crypto signature for tenant-authored agents in M4 | Studio is M7. `AGENT-01` says "signer", and no mechanism for one exists |
| **FD-20** | New capabilities in `domain/policy.ts`: `model.manage`, `model.activate`, `agent.publish`, `agent.run`, `agent.stop`, `ai.halt`, `budget.manage`, `usage.view`. Owner and admin for now, and named roles in M7 | The spec's model admin, agent publisher and security steward do not exist yet, so separation of duties is a named exception until M7 |
| **FD-21** | Capture refuses a hosted provider kind unless the deployment sets `ENSEMUS_MODEL_CREDENTIALS_REVIEWED=<review reference>`, and the lender refuses it again at use. Private endpoints work without it | This turns "no real credential before outside review" into a machine check |
| **FD-22** | `timeout_seconds` measures active time. Approval waits and paused time do not count | The example says 180 seconds, and approval waits last days |
| **FD-23** | Web commits `model_profile.probe_requested`, and the dispatcher starts `modelProbeWorkflow`, whose Activity on `ensemus-agent` sends a synthetic prompt and writes the result. Only the agent role can set `active`, by trigger | Web has no outbound path and no key, and a key must never be tested from web |

## What changed against the plan, now M3 is real

The plan assumed M3's shape. Read against ADR-027 and the code on `build-base`:

- **There is no `execute` to call.** M3 sends on its own workflow, started by its own `external_action.ready` event, with its attempt row and its own at-most-one rule. So `ExternalActionPort` is two methods (`propose`, `readState`), and the real one is `externalActionPort` in `packages/application/src/ai/external-action-port.ts`. The tool gateway proposes, and the workflow waits on `approval.resolved` and a durable poll of `readToolWait`, since the dispatcher cannot map an external action back to a Work Unit without reading a payload.
- **`unknown` stays honest.** An M3 intent that ends `unknown` ends the run `outcome_unverified` with `UNKNOWN_EXTERNAL_STATE`, and a person resolves it through M3's own flow. Nothing retries it. A model has no path to resolve it.
- **M3's recheck knows nothing of runs or switches.** ADR-024 asks every effect to recheck PostgreSQL just beforehand, and M3's `beginAttempt` is being written in parallel. So migration 0101 adds `ai.check_attempt_for_agent` on M3's attempt table: an effect an agent proposed cannot start once its run has ended, its initiator is inactive or a switch covers it. It raises `EN007` and rolls the attempt back, so nothing was sent. **Merge note:** `beginAttempt` should map `EN007` to cancelling the intent with `WORK_STOPPED`. Until then the Activity fails and retries with no send, which is safe but noisy. Actions no agent proposed are untouched.
- **The sealing key is in more than one process.** ADR-027 gave `connector-worker` the key and the secrets role, and `agent-worker` needs them as well. Purpose binding keeps a connector credential and a model key from being used for each other, and it does not stop a process with the private key opening both. Separate key pairs per worker would. **The outside review should decide.**
- **The approval is M3's.** `proposeExternalActionInTx` writes the intent and approval with one hash, so `ApprovalBinder` picks the approver and calls that. It does not make a second approval.
- **`decideApproval` and idempotent requests now refuse any non-person.** They refused `service`, and an `agent` context would have got through, so both now check for `user`. This is a one-line edit in each of two files M3 owns.
- **Audit and events name an agent as itself,** with its run as the actor ID (`actorOf`), rather than as the person it acts for. The run row names the initiator.

## Tables, roles and RLS

Migrations `0100_ai.sql` (generated, Drizzle schema in `schema-ai.ts`) and `0101_ai_security.sql` (reviewed). Every table has forced RLS with a tenant policy, except two with policies of their own.

| Table | `ensemus_app` (web, base worker) | `ensemus_agent` (adds) |
|---|---|---|
| `org.service_identities` | S, I, U(status) | |
| `ai.model_profiles` | S, I, U(all but kind, version, qualified_at). A trigger refuses `active` | U(status, qualified_at) |
| `ai.rate_cards` | S, I. Immutable | |
| `ai.model_evaluations` | S | I. Append-only |
| `ai.agent_definitions` | S, I, U(name) | |
| `ai.agent_versions` | S, I. Immutable, by grant and trigger | |
| `ai.agent_publications` | S, I, U(active_until) | |
| `ai.agent_runs` | S, I (queued only, by trigger), U(status, stop_code, ended_at, updated_at, version) **only to close a stranded run, by trigger** | U(counters, class, binding, started_at). **Limits and scopes have no UPDATE grant for anyone** |
| `ai.run_controls` | S, I. Append-only | |
| `ai.execution_steps` | S. **No free-text column** | I, U |
| `ai.step_payloads` | **None, and the policy names only the agent role** | S, I, D |
| `ai.tool_proposals` | S | I, U(approval, action, status, code) |
| `ai.artifact_evidence` | S | I |
| `work.agent_assignments` | S. Grants no access to anyone | I, D |
| `platform.budgets` | S, I, U(limit_micros, updated_at) | U(reserved, spent) |
| `platform.budget_reservations` | S | I, U(status, settled_at) |
| `platform.usage_ledger` | S | I. **Append-only for every role** |
| `platform.entitlements` | S | |
| `governance.egress_decisions` | S | I. Append-only. It cannot be backfilled, and M5's `AGENT-10` reads it |
| `governance.policy_bundles` | S, I, U(active) | |
| `governance.kill_switches` | S (own and operator rows), I and U(release) on own rows | |
| The same, as `ensemus_migrator` | | Rows with no tenant only: the operator's command |

`ensemus_dispatcher` and `ensemus_secrets` get nothing new. No role has BYPASSRLS.

### Role provisioning

**Not applied yet.** It is a compose-side change, recorded here so that it is done once and exactly. `ensemus_migrator` has no CREATEROLE, and `provision.sql` only runs on an empty data directory, so migration 0101 stops with `ROLE_MISSING` and these words until a superuser has done this:

```sql
-- provision.sql, for new installs, next to the other roles:
CREATE ROLE ensemus_agent LOGIN PASSWORD :'agent_password' NOSUPERUSER NOCREATEROLE NOBYPASSRLS IN ROLE ensemus_app;
GRANT CONNECT ON DATABASE ensemus TO ensemus_agent;

-- infrastructure/compose/postgres/upgrade-roles.sql, new, idempotent, for installs that exist, run by the
-- superuser before migrating. The owner's install and the upgrade gate both need it:
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ensemus_agent') THEN
    CREATE ROLE ensemus_agent LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS IN ROLE ensemus_app;
  END IF;
END $$;
ALTER ROLE ensemus_agent WITH PASSWORD :'agent_password';
GRANT CONNECT ON DATABASE ensemus TO ensemus_agent;
```

`10-provision.sh` passes `agent_password`, `generate-test-secrets.mjs` writes `.local/secrets/db_agent_password`, and compose gives `agent-worker` a `DATABASE_URL_AGENT`.

### Stranded runs

If a workflow is gone, the Work Unit's upkeep (`reconcileStrandedRuns`, on the base worker) fails the work, and that worker has only `ensemus_app`. So `ensemus_app` may do exactly one thing to a run: move it to `failed` with `STRANDED`, and the trigger refuses anything else. Web shares that role, so a compromised web tier could fail a run. That is no more than it could do with a stop, and it cannot start, resume, or change what a run spends.

## Ports and contracts

| Where | What |
|---|---|
| `@ensemus/domain/ai`, `ai-tools`, `ai-events`, `ai-binding` | Statuses, codes, tools, event names, `modelKeyPurpose`. `ai.ts` imports nothing, so workflow code can use it |
| `@ensemus/application/ai-ports` | `ProfileStore`, `EgressLog`, `UsageLedger`, `TurnStore`, `HaltCheck`, `ExternalActionPort`, `ApprovalBinder`, `Entitlements`. Agent code names what it needs here, and has no database import at all |
| `@ensemus/policy` | `decideEgress`, `decideAction`, `strongest`, `scanForSecrets`, and `/endpoint`, `/agent-spec-lint`. Pure, by lint |
| `@ensemus/intelligence` | `ModelAdapter`, `EndpointGuard`, `CredentialLender`, `ModelRouter`, `InferenceGateway`, `ProfileProber`, and `/testing` |
| `@ensemus/agent-runtime` | `/reducer` (imports nothing), `/context`, `/tools`, `/delegation` |
| `@ensemus/commercial` | `createEntitlements`: the seam M6's license and M8's billing implement |
| `@ensemus/workflows/agent-schemas` | Strict Zod for everything crossing Temporal |
| `@ensemus/contracts/ai`, `/ai-tools` | Zod for requests, responses, the agent spec and tool arguments, matching `openapi.yaml` and `agent-definition.schema.json` |

Every stub fails closed and is reachable from no event path until its slice lands.

**Events.** `agent_run.requested` and `agent_run.control_requested` have the Work Unit as their aggregate, and `model_profile.probe_requested` has the profile. Payloads hold IDs. The dispatcher reads only the type and aggregate ID.

**Agent spec v1** is amended in place, since nothing uses it yet: `instructions` and `execution.max_total_tokens` added, `required_capabilities` is one vocabulary, `max_cost_usd` is decimal text, `verified_by_policy` is gone (a model's guess cannot become verified memory), and `skills` is refused at publish in M4.

**Spec gaps settled here:** the three egress tables differ, and the stricter reading wins cell by cell, with `data-egress-matrix.csv` the source (G7). `execution_steps.safe_summary` becomes `label_code`, so a model's words cannot reach it (G16). `work.agent_assignments` is new, so `work_assignments.actor_type` stays `human` and no M2 access query changes (G13). `schema.sql` is a reference, and Drizzle plus these migrations win.

## Trade-offs

- **One more long-running worker and one more role.** Not yet measured. It costs a process, and provisioning that must be right on upgrade.
- **Budgets over-count.** A lost answer is charged as an estimate at the reserved amount, which may be more than the provider billed. That is the right way round, and a person may see a higher number than their provider's invoice.
- **Polling while M3 sends.** A durable timer every 30 seconds per waiting run, because the dispatcher cannot read payloads. It holds no worker, and it adds latency to a run's next step, not to the send.
- **The purge loses the transcript** when a run ends, so a person cannot read what a model said after the fact. That is the safe default, and it is the owner's call (below). Default traces hold hashes and source IDs.
- **The pre-send scan is shape-matching.** It catches known formats and registered canaries, and it will miss a secret that looks like prose. `QA-018` proves what it proves, and the operator docs say what it does not.
- **A model key passes through the web tier's memory** once, on the way to being sealed, as every secret does in ADR-024 D5. It is never logged, and no response can carry it.
- **Strings passed to HTTP headers cannot be zeroed.** The lender wipes its buffer, and the header string lives until collected. The transport slice documents this lifetime.
- **Gate C is partly vacuous at M4.** Quality scores come from a scripted model, which proves the harness and the gates and not any model. "Does not treat unsupported facts as trusted memory" holds because no memory write path exists, and it is re-tested at M5. Gate C is signed at M4 as a named exception expiring at M5.

## Consequences

**Easier:** the ledger and egress history exist from the first call, and billing in M8 and the egress ledger in M5 build on them. M5 replaces the context compiler behind one interface. A new tool is one entry and one handler.

**Harder:** every long-lived workflow path needs a committed replay history before it ships, and approval waits can last days across upgrades. The security migration is hard to reverse once tenants exist. Operators have another worker and a kill switch they rarely exercise.

**Mode impact:** the same images and code in Cloud, BYOM and Sovereign. BYOM costs are `billable=false` and labelled estimates. Sovereign reaches only a local, operator-listed endpoint. No mode has an outbound attempt until a profile is active, and hosted egress is only ever through an overlay on `agent-worker`.

**Migration:** `0100` and `0101` add one schema, new tables in existing schemas, and one trigger on M3's attempt table. No existing column changes. **Journal:** these files are not yet in `migrations/meta`, and the final merge stitches them in order across all milestones. Running `drizzle-kit generate` after stitching should produce an empty diff and the missing snapshot.

## Open questions for the owner

Each has a safe default already in the code, and each can be changed later.

1. **Book the outside reviewer now,** extended to FD-3, FD-4, FD-10 and FD-21 and the egress policy. This sets the date of M4-owner-live, and nothing else can.
2. **Which hosted providers?** The ticket says two. Default: wire-level tests only, with `qualified=NO` in the conformance matrix until you hold keys. If you hold one, accept one live and one wire-tested as a named exception.
3. **First agent?** Default: `work-brief` (read, cite, draft), with `email.send` left out of its grants. `docs/specifications/examples/work-brief.agent.yaml`.
4. **Which classes may your key carry?** Default in code: a new profile allows `public` only. Recommendation: `public` and `internal` until you have read the provider's terms and recorded them as `contract_ref`. Restricted stays denied.
5. **Approve this ADR,** with FD-3, FD-4 and FD-10 read personally. They are on the read-yourself list.
6. **How long do transcripts stay?** Default: deleted when the run ends, with no numeric default in code. Numeric retention needs a legal view and arrives with `LIFE-02`.
7. **A second person for approvals?** Default: `SELF_APPROVAL` has no exception, so an agent you started needs a second member to approve its email, and it stops with `NO_ELIGIBLE_APPROVER` otherwise. Model activation and agent publish allow one person, audited, as a named exception until M7's roles.
8. **Budget caps?** Yours to set. There is no default, so no budget means no run.
9. **Does M3's email connector count as M4's side effect?** Default: yes, once M3's slices merge. Tests use a fake connector meanwhile.
10. **Organization limits on agents?** Default: a `governance.policy_bundles` document may set them, and with none, the spec's own ranges apply and delegation depth is 0.
11. **Should each worker get its own sealing key?** See "What changed" above. The review should decide. Default: one key, as ADR-027 has it.
12. **When may a delegated child be born?** Decided 2026-11-09 by the project owner ("build it now"). See "Decision: defining `ai.delegation_influence_ready`" below. Until a reviewed migration records part 1, delegation stays closed in every deployed database.

### Decision: defining `ai.delegation_influence_ready` (open question 12)

**Status:** Decided by the project owner on 2026-11-09. The security owner is not yet named. `0548_delegation_birth_readiness_deleg.sql` (a reserved number, renumbered at merge) implements part 2 and the empty part-1 store. Part 1 is recorded by `0591_delegation_birth_capability_record_deleg.sql` only after a CI run in which every qualification test below passed. Both files carry "FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person". Raised in CI repair round 6 (finding F15).

**What existed.** 0414 created `ai.delegation_influence_ready(p_parent uuid, p_child uuid)` as `SELECT false`. Its comment says that "0416 replaces this OID only when a real immutable delegation-birth dependency is available". 0416, 0417 and 0419 never replaced it. 0419's `ai.guard_delegation_input_birth()` raises `DELEGATION_INPUT_PROOF_UNAVAILABLE` (EN119) for every child `ai.agent_runs` INSERT unless both `ai.delegation_influence_ready(parent, child)` and `ai.validate_delegation_birth(NEW)` are true. 0540 left that unchanged. So `createChildRun` audited `DELEGATION_WIDENED` with the reason `DELEGATION_INPUT_PROOF_UNAVAILABLE`, and FD-16 delegation could not happen in any organization, even under a policy bundle that allows depth and fan-out.

**Owner decisions (2026-11-09).**

- (a) The two-part definition is confirmed.
- (b) Every listed lifecycle item is qualified (bound, and tested with a genuine delegated child) before part 1 is recorded. That includes the typed-record deletion outbox and the `sealDelegatedErasureInTx` offboarding binding.
- (c) The security reviewer is not yet named.

**The lifecycle items, as they stand.** Each is bound in code or SQL, and each is tagged with the test that qualifies it (the map below).

- inherited serving for named viewers, through the 0414 unproven-input fence and the 0419 graph;
- generated-file authority capture and serving, publication and put binding;
- source and record purge confirmation with truthful separate Work counts (`createDelegatedRecordPurge`, `createDelegatedWorkPurge`);
- the mandatory 0510 hold helper `lifecycle.delegated_work_hold_free` on the redaction path;
- transcript purge and version proof for the child and parent runs (FD-5 and 0515);
- restricted eraser ordering and positive physical disposition (0515 and 0516);
- the 0417 new-v1 output guard. Correction: it no longer "stays closed". 0525 lifted it for a running, unstopped native run writing its own Work at or above its own class. A child gets exactly that bound and nothing wider.
- (8a) the canonical typed-record deletion outbox: `knowledge.record_closed`, written by `emitRecordClosedInTx` (`deleteObjectRecord`, `recordImportedTombstone` and the offboarding input closure) once per closure of a record (an event older than the record's tombstone, such as one `ensemus_app` wrote while the record was live, does not suppress it; a per-record advisory lock serializes concurrent emits), routed by the dispatcher to `knowledgeRecordPurgeWorkflow`, and restarted by the tenant's knowledge sweep (`claimRecordPurgeRestarts`, behind the `record-purge-restart-v1` patch) for every dead or tombstoned record PostgreSQL does not yet prove purged. One record whose proof refuses is counted as a sweep failure and the claim moves on to the next candidate; it never aborts the pass. Correction (CI repair round 11): `createKnowledgeArtifactPurge` no longer refuses a custom object record. It proves `object_record` under its own kind through both ports: the generated-file port, whose SQL proof (0419 `knowledge.derived_structured_artifacts_remaining`) names the record through `artifact_lineage_records` (0407) and the frozen authority refs and still raises EN119 until the record's copied Work is proven, and the archive port. Completion still needs both zeros; archive cleanup alone never completes a record, and any kind outside `RECORD_PURGE_KINDS` is refused with `INVALID_INPUT` before either port runs. So an `object_record` purge now reaches `completed` and is no longer counted as a sweep failure. Correction (CI repair round 12, 0554): a completed record is no longer proved again by every sweep. When the composite proof reads completed (in `claimRecordPurgeRestarts`, `confirmRecordPurge` or `readRecordPurgeState`), the same transaction asks PostgreSQL to record a durable completion on the record's purge job (`ai.record_purge_jobs.completed_restore_generation`, keyed by the job's snapshot and by `ai.current_material_restore_generation()`). PostgreSQL writes it only from its own proof: 0419's guard, rewritten by 0554, sends the knowledge worker's update to `ai.attest_record_purge_completion`, which takes no value from the caller and proves again, under the same locks, the current snapshot, the job's check in this generation, `ai.record_work_purge_confirmed`, the generated-file and archive-file zeros and no unresolved object deletion, or raises EN119 and writes nothing. `listRecordPurgeCandidates` leaves out a record with a current completion (`ai.record_purge_completed`), so the sweep neither proves it nor takes the organization row lock (0514) for it. A new restore generation, a changed record snapshot or any agent purge pass (which clears the completion) makes the record a candidate again. The attestation runs with the invoker's rights inside the guard, not in a SECURITY DEFINER function, because every input of the composite proof is visible only to `ensemus_app`'s RLS; `ensemus_app` gains only UPDATE on that one column, and whatever it writes is replaced by the guard's value or refused. Known limit: once completed, a record is not proved again until one of those events, so a later change to tenant-wide proof inputs (an unrelated unfinished run, archive file or deletion claim) does not reopen it; a dead record admits no new consumer, and the workflow and `readRecordPurgeState` still prove from PostgreSQL each time they run;
- (8b) the `sealDelegatedErasureInTx` offboarding binding (`ops-erase.ts`), preceded by the delegated input closure. Correction: 0515's `lifecycle.current_delegated_material_proof` needs every child receipt redacted, redaction needs a closed scope, and 0533 refuses new tombstones once an offboarding is erasing. So `closeDelegatedRecordInputsInTx` tombstones every record an unredacted receipt names (the parent's Work included) after the admission `beginErasure` checks and strictly before erasing, and writes each record's `knowledge.record_closed` event. That closure is irreversible and happens while the offboarding is still `ready_for_erasure`, so `cancelOffboarding` now refuses (`OFFBOARDING_NOT_CANCELLABLE`) once any `TENANT_ERASURE` tombstone exists: a stop after the closure (a hold placed later, a crash, a busy lock) leaves the tenant waiting for erasure, never back in service with tombstoned records. An offboarding tenant has no knowledge sweep (its schedules end before `ready_for_erasure`), so the erase command is its restart path: whenever the seal returns false, and also before the seal is tried when no file is pending and no object remains but the physical proof still refuses (0515 folds the delegated material proof into `lifecycle.tenant_object_proofs_complete`, so without this the restart below the seal was unreachable), it lists every closed record an unredacted child receipt still names (`listDelegatedRecordPurgeRestartsInTx`, metadata only) and starts each record's purge again (the dispatcher's own route, ALLOW_DUPLICATE on the per-record workflow ID), then reports `MATERIAL_PURGE_PENDING` with the count; the operator runs it again. That start needs `TEMPORAL_ADDRESS` and `TEMPORAL_CODEC_KEY` in the operator's environment, and only when a restart is due. The closure reports `DELEGATED_INPUTS_BUSY` for a contended record lock and `DELEGATED_INPUTS_REMAINING` when more than 2,000 records are left after a run's twenty pages.

**Definition as built.** Readiness has two parts, and both must hold.

1. **A reviewed deployment capability.** `ai.delegation_birth_capabilities` is append-only. Only a non-superuser `ensemus_migrator` login session can append (FORCE RLS, an INSERT policy, and a trigger that refuses a writer that is or acts through a superuser or BYPASSRLS role, or writes from a nested trigger); UPDATE, DELETE and TRUNCATE are refused (`DELEGATION_CAPABILITY_APPEND_ONLY`). No runtime role holds any grant on it, and it is read only through `ai.delegation_birth_capability_on()`, a zero-argument SECURITY DEFINER boolean that only `ensemus_agent` may execute. The latest counting row wins, and an appended `revoked` row is the reversal. A `deployment_migration` row must cite a `github-actions:` run, a non-zero 40-character commit and the full tag set below, and it counts in every database. A `qualification_fixture` row (the integration suites) can be appended, and counts, only while the cluster holds the NOLOGIN role `ensemus_delegation_qualification_ci`. Creating a role takes a superuser or a CREATEROLE identity, 0548's premises refuse any Ensemus role with either, and only the integration global setup (as the test superuser) creates it, never an install script or a migration. So in a deployed database a fixture row is refused, and one left behind is ignored: only a deployment row can open birth. 0548 writes no row. CI enables birth for the suites that need a genuine child with a fixture row appended through the migrator, and appends the prior state back afterwards. **What the ledger does not stop:** the migrator owns the table, its trigger and its functions, so a migrator session can disable the trigger, drop a policy or replace `ai.delegation_birth_capability_on()`, and a superuser bypasses RLS and can disable triggers (`ALTER TABLE ... DISABLE TRIGGER`, `session_replication_role`). The ledger is exactly as strong as the migrator credential and the superuser; it binds runtime roles, not them. The evidence fields of a deployment row are checked for shape only, not against GitHub.
2. **A per-birth check that the parent can bear a child.** Pure metadata; it never reads a body. All of these must hold:
   - the caller is `current_user = session_user = ensemus_agent`, acting as `agent`, with a tenant bound;
   - `p_parent` and `p_child` are present and distinct, `p_parent` is the transaction's own `app.agent_run_id`, and `app.agent_scope_protocol` is exactly `scoped-v1:<p_parent>` (checked for every run, not only scope-required ones);
   - the capability above is on;
   - the parent is in this tenant, its initiator is the current membership, and its status is live: `running` or `waiting_for_child`, the two statuses `ai.delegation_birth_candidate` admits;
   - the parent's `ai.run_input_checkpoints` row is `history_complete`, `v1` and not fenced;
   - no `ai.unproven_child_work_inputs` row names the parent's Work. 0414 recorded each legacy child's own Work there, so this refuses a legacy pre-0414 child acting as a parent. The clause is a NOT EXISTS, so it relies on RLS showing the agent its tenant's rows (0414's permissive `child_input_read` TO `ensemus_app`, inherited by the agent); 0548's premises check that policy's exact shape and that no RESTRICTIVE read policy exists, and the superuser inventory case in `delegation-birth-readiness.test.ts` fails if a later change hides the rows;
   - `p_child` does not exist yet. Inside the 0419 BEFORE INSERT guard the child row does not exist, so this clause only does work when the function is called on its own.

   `ai.validate_delegation_birth(NEW)` stays a separate condition and is not folded into this function. The function keeps 0414's OID, owner, invoker rights, `STABLE` and its only grant (to `ensemus_agent`); 0548's own checks verify that before and after the replacement.

**Out of scope, and unchanged.** `ai.validate_delegation_birth`, `ai.guard_delegation_input_birth`, 0414's unproven-input inventory and its keep triggers, and every purge or serving guard.

**Qualification map.** Each tag is required on the capability row, and a unit test (`tests/unit/delegation-readiness-migration.test.ts`) fails unless each titles a plain, unskipped integration case.

| Tag | Item | Test file: case |
|---|---|---|
| ADR028-Q12-L1 | inherited serving | `delegated-child-lifecycle.test.ts`: "full lifecycle: inherited serving admits only named viewers of the copied child Work"; `agent-delegated-materials.test.ts`: "full lifecycle: captures actual inheritance and permanently redacts copied Work once after real closure" |
| ADR028-Q12-L2 | generated-file authority | `delegated-child-lifecycle.test.ts`: "full lifecycle: a child’s generated file retains its inherited read authority" |
| ADR028-Q12-L3 | purge confirmation with separate Work counts (record and source) | `agent-delegated-materials.test.ts`: "full lifecycle: captures actual inheritance and permanently redacts copied Work once after real closure"; `delegated-child-lifecycle.test.ts`: "full lifecycle: source closure redacts copied Work with separate Work counts" |
| ADR028-Q12-L4 | 0510 hold helper | `agent-delegated-materials.test.ts`: "full lifecycle: an actual hold preserves the copied body debt until a genuine release" |
| ADR028-Q12-L5 | transcript purge and version proof, child and parent | `agent-delegated-materials.test.ts`: "full lifecycle: unavailable transcript completion cannot clear real Work/control debt"; `delegated-child-lifecycle.test.ts`: "full lifecycle: child and parent transcripts are purged with a current version proof" |
| ADR028-Q12-L6 | eraser ordering and positive disposition | `agent-delegated-offboarding.test.ts`: "closes delegated inputs before erasing, seals once the purges prove, then erases" |
| ADR028-Q12-L7 | output guard | `delegated-child-lifecycle.test.ts`: "full lifecycle: a running child writes only its own Work, and not after a stop" |
| ADR028-Q12-L8a | typed-record outbox, dispatcher start, sweep restart | `record-deletion-outbox.test.ts` (six cases, the last through the production generated-file proof composition); unit: `workers/workflow/src/record-purge-route.test.ts`, `packages/workflows/src/knowledge-ingest-step.test.ts`, `packages/workflows/src/knowledge-purge-activities.test.ts`, `packages/application/src/knowledge/record-closure.test.ts` |
| ADR028-Q12-L8b | offboarding input closure, cancel refusal, erase-command restart, seal | `agent-delegated-offboarding.test.ts` (four cases); unit: `workers/workflow/src/ops-erase-seal.test.ts` |
| ADR028-Q12-P2 | per-birth negatives, and the ledger's evidence kinds | `delegation-birth-readiness.test.ts` (ten cases) |

What the integration cases do not reach, because Temporal is not running in the integration stack: the dispatcher consuming an outbox row and Temporal running `knowledgeRecordPurgeWorkflow`. `agent-delegated-offboarding.test.ts` feeds the closure's real outbox rows through the dispatcher's real route (`recordPurgeStartFor`), checks the erase command's restarts against it, and runs the workflow's first Activity (`purgeRecordMaterials`) with exactly the started input; the workflow's sequencing is unit-tested (`knowledge-record-purge-step.test.ts`) and the dispatcher's start call is unit-tested with a mock client. The L2 and L7 cases start the child by raw agent-role UPDATEs, not `claimQueuedRun`, so a claim-time check on a delegated child is not exercised there.

**Effect now.** Part 2 and the bindings are live once 0548 is applied. No capability row exists, so `createChildRun` still audits `DELEGATION_INPUT_PROOF_UNAVAILABLE` in every deployed database. The three acceptance cases in `agent-delegated-materials.test.ts` (now tagged L1/L3, L4 and L5) are written to run with the suite's fixture capability,; their first CI run is the qualification evidence for part 1. `tests/helpers/agent-scope-upgrade.ts` keeps expecting `false` for a legacy child: under the decided definition that expectation is correct, so it was not changed (this section earlier said it must change). Its added assertion that a legacy child cannot act as a parent is false for several reasons at once (no capability, a parent that is not live, no v1 checkpoint), so it does not isolate the inventory clause; the superuser case in `delegation-birth-readiness.test.ts` does. The helper is not run by any suite.

**What records part 1.** `0591_delegation_birth_capability_record_deleg.sql` appends the one `deployment_migration` row, citing the green run and commit. It refuses to run if any row already exists. It is written only after a CI run on the commit carrying 0548 and the 8a/8b bindings in which every tagged test passed, and preferably after a named security reviewer has read 0548 and 0591. Writing it before that review is a risk the owner accepted by decision (c).

## Reversal

No event starts a run unless someone asks for one, and until a person creates an active profile with a budget, every path refuses. Stop `agent-worker` and runs wait in their queue with a `WORKER_UNAVAILABLE` stop after the schedule-to-start limit. The ledger and egress history are append-only by design and should be kept. FD-1 and the workflow's shape become expensive to change once real runs exist, because they are in Temporal history. Delegated birth closes again when a reviewed migration appends a `revoked` row to `ai.delegation_birth_capabilities`.

## Approvals

| Role | Name | Decision | Date |
|---|---|---|---|
| Project owner | | Decided open question 12 only: (a) two-part definition confirmed; (b) every listed lifecycle item, including the typed-record deletion outbox and the sealDelegatedErasureInTx offboarding binding, qualified before part 1 is recorded; (c) security reviewer not yet named ("build it now") | 2026-11-09 |
| Security owner (FD-3, FD-4, FD-10, FD-14, FD-21) | | Pending: not yet named. 0548_deleg (and 0591_deleg when written) FLAGGED FOR HUMAN SECURITY REVIEW | |
