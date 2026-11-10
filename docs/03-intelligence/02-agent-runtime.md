# Agent runtime and durable orchestration — TypeScript contract

## Principles

An agent is a **versioned, permissioned executor** operating on a bounded task. A Work Unit is the business objective; an AgentRun is a single execution attempt; an ExecutionStep captures tool/model decisions and receipts. Agents do not own the durable work lifecycle: Temporal does.

## Component boundaries

- `packages/agent-runtime`: bounded tool/reason/validate loop, contextual state, typed skills, output validators, cancellation, budget state and step emitters. Pure or I/O interface-driven TypeScript; never imports `next/*`.
- `packages/intelligence`: approved inference adapters and routing.
- `packages/policy`: independent authorization, classification and egress decisions.
- `packages/knowledge`: retrieved context, provenance, tenant + resource policy intersection.
- `workers/workflow`: Temporal definitions, Activities and task queues. Workflows hold deterministic scheduling, waits and compensation decisions. Model calls, DB, file/network I/O and random IDs belong in Activities.
- `apps/web`: starts work and displays state, but never hosts the long-lived agent loop.

## State model

`queued → preparing → running → paused / waiting_for_approval / waiting_for_child → running → verifying → completed`, with `failed`, `cancelled`, `budget_exhausted`, `policy_denied`, `timed_out` and `outcome_unverified`. The one list is `AGENT_RUN_STATUSES` in `@ensemus/domain/ai`, and migration 0101 holds the same transitions (ADR-028 FD-7). Persist causal event IDs, actor/delegation, agent version, work unit ID, bound provider profile, source references, outputs, budget receipts, and recovery cursor.

## Bounded agent loop

1. Resolve actor/delegation/tenant/Work Unit and load *published immutable agent version*.
2. Validate requested skill, approved tool set, model profile, classification and budgets; compile minimal context.
3. Execute bounded reasoning steps. Only allow tools from registry and validate typed arguments.
4. Independently re-evaluate resource/action policy for every tool call; require human approval for designated side effects, bound to exact action payload hash and expiry.
5. Execute tool with idempotency key or reconciliation strategy; store sanitized evidence and receipts.
6. Verify outcome against explicit business criteria. Complete Work Unit only after verification.
7. Record cost, metrics, provenance and safe failure handling; allow authorized recovery.

## Durable semantics

Temporal may replay workflow code, so do **not** put model inference or nondeterministic I/O inside workflow functions. Run LLM calls as Activities. Signal workflows from verified approval/external events. Use stable workflow IDs; pin incompatible long-running workflows with supported SDK versioning mechanisms. A tool's side effect may occur before an Activity receives its completion acknowledgement: retries must check idempotency receipts or reconcile externally. Exactly-once delivery across external services is not promised.

## Agent coordination

Prefer a single agent per Work Unit activity until decomposition is justified. When specialized agents are required, orchestrate explicit typed tasks and artifacts, bounded depth/fanout and deterministic join conditions. Agents exchange artifacts and typed state, not infinite freeform discussion. Recursion/fanout limits, spending guards, and timeouts are mandatory.

## Agent controls

Max model turns, tool calls, elapsed time, tokens, cash budgets, CPU/memory, output size, delegated depth, rate-limits and tenant concurrency. A run cannot expand its own quotas, tool grants or provider allowlists. Runtime workers should be killable/restartable without losing committed outcomes; cancel tokens propagate to activities where safe.

## Human review and traceability

Approval screen displays initiator, agent, exact proposed action/diff, affected data, risk, model/source evidence and expiry. Approval is evaluated anew at execution time if resource permissions or proposal hash changed. User sees progress/receipts rather than unverified 'done'. No exposure of private model chain-of-thought, company secrets or proprietary prompt contents in ordinary traces.

## Recovery tests

Kill web during a run; kill worker during a model call; retry after external action but before receipt; revoke provider access mid-run; approve then change proposal; restore database; delete referenced document; exhaust budget; cancel during tool execution. No duplicate consequential side effects, no cross-tenant access, and clear recoverable states.
