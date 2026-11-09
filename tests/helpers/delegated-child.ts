// A genuine delegated child for the integration suites, moved here from agent-delegated-materials.test.ts
// so other suites (ADR-028 open question 12 qualification) can use it. Not unchanged: the move added
// genuineChildWithRecord's scopes and beforeModel options, birthDiagnostic, and the scope and capability
// state in the birth-failure message. The child it builds, and every admission it goes through, are the
// same as before the move.
// Actual app/agent roles and real admission/usage/proposal/step services. No provider or invented
// observations. A child is born only while the 0548 capability is qualified (tests/helpers/
// delegation-capability.ts) and under an owner's active policy bundle (underDelegationPolicy).
import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  createWorkUnit,
  getWorkUnit,
  transitionWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import { createChildRun } from '@ensemus/application/ai-delegation';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { createDelegatedRecordPurge } from '@ensemus/application/knowledge/delegated-record-purge';
import { createContextSource } from '@ensemus/application/ai-context-source';
import { completeTurn, claimQueuedRun, createTurnStore } from '@ensemus/application/ai-runs';
import {
  admitMainModelDispatchInTx,
  receiveMainInputSnapshotInTx,
  type MainModelAdmission,
} from '@ensemus/application/ai-model-admission';
import { createToolStepStore, storeProposal } from '@ensemus/application/ai-tool-steps';
import { createUsageLedger } from '@ensemus/application/ai-usage';
import {
  agentPublications,
  agentRuns,
  auditEvents,
  delegatedInputReceipts,
  policyBundles,
  tombstones,
  withTenantTx,
  type AgentContext,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import { loadAgentReadScopeInTx } from '../../packages/application/src/ai/read-scope';
import { idFromRequest } from '../../packages/application/src/request-id';
import {
  prepareRunInputContext,
  seedAgentVersion,
  seedQueuedRun,
  testAgentSpec,
  type AiTenant,
} from './ai/fixtures';

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = sha256Hex;
export const noObjects: ObjectStore = {
  async put() {
    throw new Error('TEST_UNEXPECTED_OBJECT_PUT');
  },
  async get() {
    throw new Error('TEST_UNEXPECTED_OBJECT_READ');
  },
  async delete() {
    throw new Error('TEST_UNEXPECTED_OBJECT_DELETE');
  },
  async exists() {
    throw new Error('TEST_UNEXPECTED_OBJECT_PROBE');
  },
};

export type DelegatedChildDeps = {
  app: AppDatabase;
  agent: AppDatabase;
  /** Read when called, so a suite may seed these in beforeAll. */
  tenant(): AiTenant;
  profileId(): string;
  rateCardId(): string;
};

/** Everything below works on one tenant. Use one harness per tenant: the bundle version counter is its own. */
export function delegatedChildHarness(deps: DelegatedChildDeps) {
  const { app, agent } = deps;

  async function fixture(
    scopes?: string[],
    beforeModel?: (context: AgentContext) => Promise<void>,
  ) {
    const a = deps.tenant(),
      profileId = deps.profileId(),
      rateCardId = deps.rateCardId();
    const work = await createWorkUnit(app, a.owner, { title: 'Actual parent work' });
    await transitionWorkUnit(app, a.owner, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    const spec = testAgentSpec({
      ...(scopes ? { context: { allowed_scopes: scopes, memory_write_policy: 'none' } } : {}),
      tools: { allow: ['work.read', 'agent.delegate'], deny: [] },
      execution: {
        max_model_turns: 5,
        max_tool_calls: 5,
        max_total_tokens: 10_000,
        max_cost_usd: '1',
        timeout_seconds: 60,
        max_delegation_depth: 3,
      },
    });
    const version = await seedAgentVersion(app, a.owner, spec);
    const childVersion = await seedAgentVersion(app, a.owner, spec);
    // createChildRun starts only a version with a live publication (agent_publications), so the
    // delegated version is published by the MFA-stepped-up owner, as publishing requires (0404).
    await withTenantTx(app, a.owner, (tx) =>
      tx.insert(agentPublications).values({
        organizationId: a.organizationId,
        definitionId: childVersion.definitionId,
        versionId: childVersion.versionId,
      }),
    );
    const runId = await seedQueuedRun(app, a.owner, {
      workUnitId: work.id,
      version,
      tools: ['work.read', 'agent.delegate'],
      limits: { maxDelegationDepth: 3 },
    });
    if (
      !(await claimQueuedRun(agent, {
        organizationId: a.organizationId,
        workUnitId: work.id,
        temporalRunId: randomUUID(),
      }))
    )
      throw new Error('TEST_RUN_NOT_CLAIMED');
    const context = await prepareRunInputContext(agent, a.organizationId, runId),
      turns = createTurnStore(agent);
    await withTenantTx(agent, context, (tx) =>
      tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId)),
    );
    await turns.bindProfile(context, { runId, profileId, profileVersion: 1 });
    await beforeModel?.(context);
    const step = await turns.beginTurn(context, { runId, stepNumber: 1 });
    if (step.kind !== 'begin') throw new Error('TEST_MODEL_STEP_NOT_STARTED');
    const snapshot = {
      id: randomUUID(),
      writerToken: randomUUID(),
      requestHash: hash(`Actual test SDK request ${randomUUID()}`),
      phase: 'prepare' as const,
    };
    const admission: MainModelAdmission = {
      runId,
      stepId: step.stepId,
      attempt: step.attempt,
      reservationAttempt: step.attempt,
      agentVersionId: version.versionId,
      workUnitId: work.id,
      purpose: 'reason',
      classification: 'internal',
      profileId,
      profileVersion: 1,
      ceiling: { inputTokens: 30, outputTokens: 5 },
      costMicros: 40,
      priorUsage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      snapshot,
    };
    const ledger = createUsageLedger(agent);
    const reservation = await withTenantTx(agent, context, async (tx) => {
      const denial = await admitMainModelDispatchInTx(tx, context, admission);
      if (denial) throw new Error(`TEST_MAIN_ADMISSION_${denial}`);
      return ledger.reserve(tx, context, {
        runId,
        stepId: step.stepId,
        attempt: step.attempt,
        agentVersionId: version.versionId,
        amountMicros: admission.costMicros,
      });
    });
    if (!reservation.ok) throw new Error(`TEST_MODEL_RESERVATION_${reservation.code}`);
    await withTenantTx(agent, context, async (tx) => {
      const denial = await admitMainModelDispatchInTx(tx, context, {
        ...admission,
        snapshot: { ...snapshot, phase: 'dispatch' },
      });
      if (denial) throw new Error(`TEST_MAIN_DISPATCH_${denial}`);
    });
    const args = {
      agent_version_id: childVersion.versionId,
      title: ' Actual copied child﻿',
      tools: ['work.read'],
      max_cost_micros: 10_000,
    };
    // The paid-result accounting and trusted result binder use their actual services. The provider
    // response is synthetic; no network is contacted and no input receipt is constructed by tests.
    await withTenantTx(agent, context, async (tx) => {
      await ledger.record(tx, context, {
        idempotencyKey: `model:${runId}:1:${step.attempt}`,
        meter: 'model_input_tokens',
        quantity: 1,
        unit: 'token',
        costMicros: 1,
        rateCardId,
        rateCardVersion: 1,
        reservationId: reservation.reservationId,
        workUnitId: work.id,
        runId,
        stepId: step.stepId,
        profileId,
        profileVersion: 1,
        providerKind: 'local_openai_compatible',
        requestHash: snapshot.requestHash,
        status: 'final',
      });
      await ledger.settle(tx, context, {
        reservationId: reservation.reservationId,
        actualMicros: 1,
      });
      await receiveMainInputSnapshotInTx(tx, context, {
        snapshotId: snapshot.id,
        writerToken: snapshot.writerToken,
        kind: 'tool_call',
        toolId: 'agent.delegate',
        payloadHash: hash(JSON.stringify(args)),
      });
    });
    const proposal = await storeProposal(agent, context, {
      runId,
      stepNumber: 1,
      toolId: 'agent.delegate',
      args,
      originatingModel: {
        stepId: step.stepId,
        attempt: step.attempt,
        inputSnapshotId: snapshot.id,
      },
    });
    if (
      !(await completeTurn(agent, context, {
        agentRunId: runId,
        stepId: step.stepId,
        attempt: step.attempt,
        outcome: 'tool_proposed',
        code: null,
        delta: { modelTurns: 1, inputTokens: 1, costMicros: 1 },
      }))
    )
      throw new Error('TEST_MODEL_STEP_NOT_COMPLETED');
    const tools = createToolStepStore({ database: agent, objects: noObjects });
    await withTenantTx(agent, context, async (tx) => {
      await loadAgentReadScopeInTx(tx, context);
      const tool = await tools.openStep(tx, context, {
        runId,
        stepNumber: 2,
        toolId: 'agent.delegate',
      });
      if (!tool) throw new Error('TEST_NATIVE_TOOL_STEP_NOT_OPENED');
      await tools.moveProposal(tx, {
        proposalId: proposal.proposalId,
        status: 'done',
        decisionCode: 'ALLOWED',
      });
      await tools.updateStep(tx, {
        stepId: tool.stepId,
        state: 'completed',
        outcome: 'done',
        decisionCode: 'ALLOWED',
      });
    });
    const childRunId = idFromRequest('agent_child_run', context.membershipId, runId, 2);
    const childWorkId = idFromRequest('agent_child_work', context.membershipId, runId, 2);
    const candidate = () =>
      withTenantTx(agent, context, async (tx) => {
        await loadAgentReadScopeInTx(tx, context);
        return (
          await tx.execute<{
            proposalId: string;
            snapshotId: string;
            inputs: unknown;
            classification: string;
          }>(sql`
        select proposal_id "proposalId",snapshot_id "snapshotId",input_inventory inputs,classification
          from ai.delegation_birth_candidate(${runId}::uuid,${childRunId}::uuid)`)
        ).rows;
      });
    return {
      work,
      context,
      runId,
      childRunId,
      childWorkId,
      proposalId: proposal.proposalId,
      snapshot,
      candidate,
    };
  }

  // With no active policy bundle an organization allows no delegation at all (ADR-028 question 10,
  // NO_DELEGATION), and createChildRun refuses DELEGATION_DEPTH before any other rule. A genuine
  // child is born only under an owner's active bundle that grants a depth and a fan-out, written as
  // an owner writes one. It is withdrawn again after the call, so no other case runs under it.
  let bundleVersion = 0;
  async function underDelegationPolicy<T>(action: () => Promise<T>): Promise<T> {
    const a = deps.tenant();
    bundleVersion += 1;
    const document = {
      organization_policy: { agent_limits: { max_delegation_depth: 3, max_delegation_fan_out: 2 } },
    };
    await withTenantTx(app, a.owner, async (tx) => {
      await tx.update(policyBundles).set({ active: false }).where(eq(policyBundles.active, true));
      await tx.insert(policyBundles).values({
        organizationId: a.organizationId,
        version: bundleVersion,
        sha256: hash(JSON.stringify(document)),
        document,
        active: true,
        createdByMembershipId: a.owner.membershipId,
      });
    });
    try {
      return await action();
    } finally {
      await withTenantTx(app, a.owner, (tx) =>
        tx.update(policyBundles).set({ active: false }).where(eq(policyBundles.active, true)),
      );
    }
  }

  /**
   * What refused a birth, read in the parent's own agent transaction the way createChildRun reads it:
   * whether its scope loads (and so sets the scoped-v1 marker), then the per-birth predicate, then the
   * part-1 capability. A savepoint keeps a refused scope load from aborting the reads after it.
   */
  async function birthDiagnostic(f: { context: AgentContext; runId: string; childRunId: string }) {
    return withTenantTx(agent, f.context, async (tx) => {
      const scope = await tx
        .transaction(async (savepoint) => {
          await loadAgentReadScopeInTx(savepoint as Tx, f.context);
        })
        .then(
          () => true,
          () => false,
        );
      const ready = (
        await tx.execute<{ ready: boolean | null }>(
          sql`select ai.delegation_influence_ready(${f.runId}::uuid,${f.childRunId}::uuid) ready`,
        )
      ).rows[0]?.ready;
      const capability = (
        await tx.execute<{ on: boolean | null }>(
          sql`select ai.delegation_birth_capability_on() "on"`,
        )
      ).rows[0]?.on;
      return { scope, ready, capability };
    });
  }

  // ADR-028 'Decision: defining ai.delegation_influence_ready' (project owner, 2026-11-09; 0548_deleg).
  // These are genuine full-composition gates: a child is born only through createChildRun, with the
  // part-1 capability qualified for the suite and every 0419 birth check passing. They are not skipped.
  async function genuineChildWithRecord(
    options: { scopes?: string[]; beforeModel?: (context: AgentContext) => Promise<void> } = {},
  ) {
    const a = deps.tenant();
    const input = await createWorkUnit(app, a.owner, {
      title: 'Actual inherited record material',
    });
    const f = await fixture(options.scopes, async (context) => {
      await createContextSource({
        database: agent,
        readObject: async () => {
          throw new Error('TEST_UNEXPECTED_BYTES');
        },
      }).loadWork(context, input.id);
      await options.beforeModel?.(context);
    });
    const created = await underDelegationPolicy(() =>
      createChildRun(agent, f.context, { parentRunId: f.runId, stepNumber: 2 }),
    );
    if (created.kind !== 'created') {
      // The refusal's safe reason is audited; name it so a failure says which gate refused.
      const denials = await withTenantTx(app, a.owner, (tx) =>
        tx
          .select({ reason: auditEvents.safeReason })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.targetRef, `agent_run:${f.runId}`),
              eq(auditEvents.action, 'agent_run.delegation_denied'),
            ),
          ),
      );
      // Read as the run reads it, in its own transaction after its scope load, so a refused scope,
      // a false predicate and a closed capability are each named rather than guessed at.
      const why = await birthDiagnostic(f);
      throw new Error(
        `TEST_GENUINE_CHILD_NOT_ADMITTED:${created.code}:${denials.map((row) => row.reason).join(',')}` +
          `:scope=${String(why.scope)}:delegation_influence_ready=${String(why.ready)}:capability=${String(why.capability)}`,
      );
    }
    expect(created).toMatchObject({ childRunId: f.childRunId, childWorkUnitId: f.childWorkId });
    const child = await getWorkUnit(app, a.owner, f.childWorkId);
    expect(child.title).toBe('Actual copied child');
    const [receipt] = await withTenantTx(app, a.owner, (tx) =>
      tx
        .select()
        .from(delegatedInputReceipts)
        .where(eq(delegatedInputReceipts.childRunId, f.childRunId)),
    );
    if (!receipt) throw new Error('TEST_GENUINE_BIRTH_RECEIPT_MISSING');
    expect(receipt.proposalId).toBe(f.proposalId);
    expect(receipt.snapshotId).toBe(f.snapshot.id);
    return { ...f, input, receipt };
  }
  const recordAdapter = (transcripts = createRunTranscriptPurge()) =>
    createDelegatedRecordPurge({
      database: agent,
      transcripts,
      accounting: createKnowledgeCallStore(agent, { halt: createHaltCheck() }),
    });
  const closeRecord = (id: string) => {
    const a = deps.tenant();
    return withTenantTx(app, a.owner, (tx) =>
      tx.insert(tombstones).values({
        organizationId: a.organizationId,
        targetType: 'work_unit',
        targetId: id,
        reasonCode: 'USER_DELETED',
      }),
    );
  };

  return {
    fixture,
    underDelegationPolicy,
    birthDiagnostic,
    genuineChildWithRecord,
    recordAdapter,
    closeRecord,
  };
}
