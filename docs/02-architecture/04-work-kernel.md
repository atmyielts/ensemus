# Universal Work Kernel — execution state and work graph

## 1. Why Work Units exist

A Work Unit is a first-class, technology-independent business objective. A Work Unit may be completed manually, by deterministic workflow, by an agent, or through a combination. Agents do not own the business outcome; they carry out bounded attempts.

## 2. Canonical Work Unit contract

Fields: `id`, `organization_id`, `title`, `objective`, `description`, `accountable_owner`, `contributors`, `project_id`, `priority`, `start_at`, `due_at`, `status`, `completion_criteria`, `acceptance_evidence`, `data_classification`, `version`, `created_by`, timestamps. Optional: `parent_work_unit_id`, tags, relevant objects, origin event, budget allocation.

A completion criterion is testable: artifact exists, client record was created, specified reviewer approved, or external system's receipt confirms action. A model-written assertion without objective evidence is not sufficient for consequential completion.

## 3. State machine

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> ready : dependencies satisfied
  queued --> cancelled
  ready --> running
  running --> blocked : unmet prerequisite / external unavailable
  running --> awaiting_approval : consequential action
  awaiting_approval --> running : valid approval
  awaiting_approval --> cancelled : denied / expired policy outcome
  blocked --> ready : prerequisite satisfied
  running --> verifying : proposed completion
  verifying --> completed : evidence accepted
  verifying --> running : remediation needed
  running --> failed : unrecoverable terminal fault
  failed --> ready : authorized retry
  completed --> [*]
  cancelled --> [*]
```

Reject invalid transitions, record previous version, actor, reason, evidence, and trace correlation. A Work Unit can be reopened by authorized action with history preserved; do not silently change a completed artifact.

As built (M2): `work.work_transitions` holds each change's actor and reason, under the Work Unit's own access rules, and the reason goes into no event, audit entry or workflow. A pause starts when a review is requested and ends only on that review's decision: people with change rights cannot make either move directly, and one review at a time can be open. A review binds the Work Unit's text, through a digest, and its exact files, and it counts as evidence only while it still matches them and has not expired. Reopening closes earlier reviews. Finished work has to be reopened before its content or files change, though access can always be removed, and a file can be deleted from stopped work because stopped work can never be reopened. Plans stop at `verifying`: a person marks the work done, and a file a plan generated is not evidence.

## 4. Work graph invariants

- Directed prerequisite graph is acyclic per organization. Reject direct self-edge and multi-hop cycle; validate under concurrent writes.
- Cross-tenant edges are impossible in database constraints.
- A Work Unit cannot enter `ready` if mandatory prerequisites are not satisfied.
- Dependencies can express `finish-to-start`, `approval-before`, or typed business preconditions; keep a small explicit vocabulary initially.
- Bulk dependency updates are transactional; detected cycles must roll back the whole change.
- Completion acceptance can require a human review or deterministic verifier; model self-verification cannot override required approval.

## 5. Human and agent assignment

Assignments identify a principal (human membership, agent service identity, or team queue), responsibility type, and effective dates. A human is accountable for approval-sensitive Work Units. An agent run uses a snapshot of permissions; revoked permissions must terminate or block future tool actions mid-run. The platform rechecks before every irreversible side effect.

## 6. Durable workflow ownership

Temporal holds the live process machine and waits for signals (`approval_received`, `dependency_resolved`, `external_update`, `cancelled`). PostgreSQL stores the authoritative Work Unit business state. An activity writes a domain transaction and outbox event; workflow projections asynchronously reconcile actual process progress. Keep all nondeterministic operations (LLM, external tools, DB writes) in activities, not deterministic workflow code.

## 7. External side effects

Persist an `external_actions` intent with hash, target connector, idempotency key, and approval binding before calling provider. Use provider-native idempotency when available. If a timeout occurs after request dispatch, reconcile against provider by stable ID or query before retrying. Mark `unknown_external_state` if reliable reconciliation is impossible and require human intervention; never blindly retry a payment or send action.

## 8. Critical path and risk signals

Use DAG traversal to surface blockers and overdue prerequisites. Estimate critical paths only when durations are grounded; show a confidence/estimate range rather than presenting invented certainty. Alert prioritization should depend on business impact and time sensitivity, not arbitrary AI rankings.

## 9. Example execution

`opportunity.won` → create onboarding Work Unit → resolve legal check and account setup in parallel → proposed kickoff draft → approval of external message → send and reconcile external ID → evidence-backed Work Unit completion → memory records decided and verified facts.
