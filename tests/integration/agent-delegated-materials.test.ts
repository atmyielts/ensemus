// Actual app/agent roles and real admission/usage/proposal/step services. No provider or invented
// observations. 0419 remains disabled until serving + positive disposition compose; SQL unrun.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  createWorkUnit,
  getWorkUnit,
  recordDelegatedWorkRedactionInTx,
  transitionWorkUnit,
  updateWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import { createChildRun } from '@ensemus/application/ai-delegation';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { createDelegatedWorkPurge } from '@ensemus/application/knowledge/delegated-work-purge';
import { createDelegatedRecordPurge } from '@ensemus/application/knowledge/delegated-record-purge';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { purgeRunTranscriptsForSource, revokeSource } from '@ensemus/application/knowledge/purge';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import { createContextSource } from '@ensemus/application/ai-context-source';
import {
  completeTurn,
  claimQueuedRun,
  createTurnStore,
  finishRun,
} from '@ensemus/application/ai-runs';
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
  delegatedWorkBirths,
  mainInputSnapshots,
  knowledgePurgeJobs,
  sourceRunClosures,
  runInputCheckpoints,
  tombstones,
  openAppDatabase,
  withTenantTx,
  workUnits,
  type AgentContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { loadAgentReadScopeInTx } from '../../packages/application/src/ai/read-scope';
import { pgCode } from '../../packages/application/src/errors';
import { idFromRequest } from '../../packages/application/src/request-id';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedOrganizationBudget,
  seedQueuedRun,
  seedRateCard,
  testAgentSpec,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';
import { seedSearchableSource } from '../helpers/knowledge';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const noObjects: ObjectStore = {
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
describe('delegated material birth evidence (0419)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  let a: AiTenant, b: AiTenant, profileId: string, rateCardId: string;
  beforeAll(async () => {
    a = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    b = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    profileId = await seedActiveProfile(app.db, agent.db, a.owner);
    rateCardId = await seedRateCard(app.db, a.owner, profileId);
    await seedOrganizationBudget(app.db, a.owner, 1_000_000);
  });
  afterAll(async () => {
    await agent.close();
    await app.close();
  });

  async function fixture(
    scopes?: string[],
    beforeModel?: (context: AgentContext) => Promise<void>,
  ) {
    const work = await createWorkUnit(app.db, a.owner, { title: 'Actual parent work' });
    await transitionWorkUnit(app.db, a.owner, {
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
    const version = await seedAgentVersion(app.db, a.owner, spec);
    const childVersion = await seedAgentVersion(app.db, a.owner, spec);
    // createChildRun starts only a version with a live publication (agent_publications), so the
    // delegated version is published by the MFA-stepped-up owner, as publishing requires (0404).
    await withTenantTx(app.db, a.owner, (tx) =>
      tx.insert(agentPublications).values({
        organizationId: a.organizationId,
        definitionId: childVersion.definitionId,
        versionId: childVersion.versionId,
      }),
    );
    const runId = await seedQueuedRun(app.db, a.owner, {
      workUnitId: work.id,
      version,
      tools: ['work.read', 'agent.delegate'],
      limits: { maxDelegationDepth: 3 },
    });
    if (
      !(await claimQueuedRun(agent.db, {
        organizationId: a.organizationId,
        workUnitId: work.id,
        temporalRunId: randomUUID(),
      }))
    )
      throw new Error('TEST_RUN_NOT_CLAIMED');
    const context = await prepareRunInputContext(agent.db, a.organizationId, runId),
      turns = createTurnStore(agent.db);
    await withTenantTx(agent.db, context, (tx) =>
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
    const ledger = createUsageLedger(agent.db);
    const reservation = await withTenantTx(agent.db, context, async (tx) => {
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
    await withTenantTx(agent.db, context, async (tx) => {
      const denial = await admitMainModelDispatchInTx(tx, context, {
        ...admission,
        snapshot: { ...snapshot, phase: 'dispatch' },
      });
      if (denial) throw new Error(`TEST_MAIN_DISPATCH_${denial}`);
    });
    const args = {
      agent_version_id: childVersion.versionId,
      title: '\u00a0Actual copied child\ufeff',
      tools: ['work.read'],
      max_cost_micros: 10_000,
    };
    // The paid-result accounting and trusted result binder use their actual services. The provider
    // response is synthetic; no network is contacted and no input receipt is constructed by tests.
    await withTenantTx(agent.db, context, async (tx) => {
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
    const proposal = await storeProposal(agent.db, context, {
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
      !(await completeTurn(agent.db, context, {
        agentRunId: runId,
        stepId: step.stepId,
        attempt: step.attempt,
        outcome: 'tool_proposed',
        code: null,
        delta: { modelTurns: 1, inputTokens: 1, costMicros: 1 },
      }))
    )
      throw new Error('TEST_MODEL_STEP_NOT_COMPLETED');
    const tools = createToolStepStore({ database: agent.db, objects: noObjects });
    await withTenantTx(agent.db, context, async (tx) => {
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
      withTenantTx(agent.db, context, async (tx) => {
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

  it('uses the exact paid original attempt prefix and does not attribute later actual reads to it', async () => {
    const f = await fixture(),
      before = await f.candidate();
    expect(before).toEqual([
      expect.objectContaining({ proposalId: f.proposalId, snapshotId: f.snapshot.id }),
    ]);
    const other = await createWorkUnit(app.db, a.owner, { title: 'Later actual parent read' });
    await createContextSource({
      database: agent.db,
      readObject: async () => {
        throw new Error('TEST_UNEXPECTED_BYTES');
      },
    }).loadWork(f.context, other.id);
    expect(await f.candidate()).toEqual(before);
    expect(before[0]?.inputs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: other.id })]),
    );
    // The web role holds column SELECT without writer_token (0416), so it asks for no secret column;
    // the other tenant still sees no row of it.
    expect(
      await withTenantTx(app.db, b.owner, (tx) =>
        tx
          .select({ id: mainInputSnapshots.id })
          .from(mainInputSnapshots)
          .where(eq(mainInputSnapshots.id, f.snapshot.id)),
      ),
    ).toEqual([]);
  });

  it('refuses app/agent redaction calls and cannot turn a genuine parent into an invented child disposition', async () => {
    const f = await fixture();
    const invoke = (tx: Parameters<typeof recordDelegatedWorkRedactionInTx>[0]) =>
      tx.execute(
        sql`select * from work.redact_delegated_body(${f.runId}::uuid,${f.work.id}::uuid,'work_unit',${f.work.id}::uuid,NULL::uuid)`,
      );
    await expect(
      withTenantTx(app.db, createServiceContext(a.organizationId), invoke),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(withTenantTx(agent.db, f.context, invoke)).rejects.toSatisfy(
      (error: unknown) => pgCode(error) === '42501',
    );
    await withTenantTx(agent.db, createServiceContext(a.organizationId), async (tx) => {
      const prior = randomUUID();
      await tx.execute(sql`select set_config('app.delegated_work_redaction_run',${prior},true)`);
      expect((await invoke(tx)).rows).toEqual([]);
      expect(
        (
          await tx.execute<{ value: string }>(
            sql`select current_setting('app.delegated_work_redaction_run',true) value`,
          )
        ).rows[0]?.value,
      ).toBe(prior);
    });
    expect(
      (await withTenantTx(agent.db, createServiceContext(b.organizationId), invoke)).rows,
    ).toEqual([]);
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(delegatedInputReceipts)
          .where(eq(delegatedInputReceipts.childRunId, f.runId)),
      ),
    ).toEqual([]);
  });

  it('denies fabricated Work-update effect metadata without a real fixed-SQL disposition in this transaction', async () => {
    const f = await fixture(),
      service = createServiceContext(a.organizationId);
    const before = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select({ version: workUnits.version }).from(workUnits).where(eq(workUnits.id, f.work.id)),
    );
    await expect(
      withTenantTx(agent.db, service, (tx) =>
        recordDelegatedWorkRedactionInTx(tx, service, {
          current: f.work,
          contentSha256: hash('claimed redacted content'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select({ version: workUnits.version })
          .from(workUnits)
          .where(eq(workUnits.id, f.work.id)),
      ),
    ).toEqual(before);
  });

  it('does not grant runtime roles direct disposition-stamp mutation', async () => {
    const f = await fixture();
    for (const context of [a.owner, createServiceContext(a.organizationId)])
      await expect(
        withTenantTx(app.db, context, (tx) =>
          tx
            .update(delegatedInputReceipts)
            .set({
              redactedAt: new Date(),
              redactedVersion: 1,
              dispositionSha256: hash('forged'),
              redactionScopeKind: 'work_unit',
              redactionScopeId: f.work.id,
            })
            .where(eq(delegatedInputReceipts.childRunId, f.runId)),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });

  it('cannot stamp a purge-time control witness as app/interactive agent or against an active unrelated source', async () => {
    const f = await fixture(),
      source = await seedSearchableSource(app.db, a.owner, {
        passages: ['Generated unrelated closure fixture.'],
        grants: [{ kind: 'organization' }],
      });
    const [run] = await withTenantTx(agent.db, f.context, (tx) =>
      tx.select({ version: agentRuns.version }).from(agentRuns).where(eq(agentRuns.id, f.runId)),
    );
    if (!run) throw new Error('TEST_RUN_MISSING');
    const stamp = {
      organizationId: a.organizationId,
      sourceId: source.sourceId,
      sourceVersion: 1,
      runId: f.runId,
      terminalVersion: run.version,
      fenceGeneration: 1,
      terminalStatus: 'cancelled',
    };
    for (const context of [a.owner, createServiceContext(a.organizationId)])
      await expect(
        withTenantTx(app.db, context, (tx) => tx.insert(sourceRunClosures).values(stamp)),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(agent.db, f.context, (tx) => tx.insert(sourceRunClosures).values(stamp)),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(agent.db, createServiceContext(a.organizationId), (tx) =>
        tx.insert(sourceRunClosures).values(stamp),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(sourceRunClosures).where(eq(sourceRunClosures.runId, f.runId)),
      ),
    ).toEqual([]);
  });

  it('keeps actual terminal material authority closed while later metadata versions remain writable', async () => {
    const f = await fixture();
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    // 0101's run state machine (agent_runs_check_change, EN006 AGENT_RUN_INVALID_TRANSITION) fires
    // before 0419's fenced_terminal_run_no_revival (EN119): BEFORE triggers run in name order, and
    // 0101 has never allowed any move out of a terminal status. Either refusal keeps it closed.
    await expect(
      withTenantTx(agent.db, f.context, (tx) =>
        tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, f.runId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN006');
    const [metadata] = await withTenantTx(agent.db, f.context, (tx) =>
      tx
        .update(agentRuns)
        .set({ version: sql`${agentRuns.version}+1` })
        .where(eq(agentRuns.id, f.runId))
        .returning({ status: agentRuns.status, version: agentRuns.version }),
    );
    expect(metadata?.status).toBe('cancelled');
    await expect(
      createContextSource({
        database: agent.db,
        readObject: async () => {
          throw new Error('TEST_UNEXPECTED_BYTES');
        },
      }).loadWork(f.context, f.work.id),
    ).rejects.toThrow();
  });

  it('refuses reviving a terminal run in 0419 itself, not only in the 0101 state machine', async () => {
    const f = await fixture();
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    // BEFORE triggers fire in name order, so 0101's agent_runs_check_change refuses every move out
    // of a terminal status (EN006, the case above) before 0419's fenced_terminal_run_no_revival is
    // reached, for every role. To prove 0419's own guard, only the 0101 trigger is switched off,
    // inside a superuser transaction that is always rolled back: the schema never changes for
    // anyone else, and integration files run one at a time (fileParallelism: false).
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    let refusal: { code?: unknown; message?: unknown } | null = null;
    try {
      await su.query('begin');
      try {
        await su.query("select set_config('app.organization_id',$1,true)", [a.organizationId]);
        await su.query('alter table ai.agent_runs disable trigger agent_runs_check_change');
        await su.query(
          "update ai.agent_runs set status='running' where organization_id=$1 and id=$2",
          [a.organizationId, f.runId],
        );
      } catch (error) {
        refusal = error as { code?: unknown; message?: unknown };
      } finally {
        await su.query('rollback');
      }
      // The rollback restored the 0101 trigger.
      const enabled = await su.query<{ tgenabled: string }>(
        `select tgenabled from pg_trigger
          where tgrelid='ai.agent_runs'::regclass and tgname='agent_runs_check_change'`,
      );
      expect(enabled.rows).toEqual([{ tgenabled: 'O' }]);
    } finally {
      await su.end();
    }
    expect(refusal).toMatchObject({ code: 'EN119', message: 'TERMINAL_RUN_PERMANENTLY_FENCED' });
    const [stored] = await withTenantTx(agent.db, f.context, (tx) =>
      tx.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, f.runId)),
    );
    expect(stored?.status).toBe('cancelled');
  });

  it('closes a genuine compiler consumer once and retains a purge-time control witness without double charging', async () => {
    const source = await seedSearchableSource(app.db, a.owner, {
      passages: ['closureanchor is an actual lexical input.'],
      grants: [{ kind: 'organization' }],
    });
    const f = await fixture([
      'work.read',
      'data.internal.read',
      `knowledge.${source.sourceId}.read`,
    ]);
    const compiled = await compileEvidence(
      agent.db,
      f.context,
      {
        model: createScriptedModelPort({
          route: () => ({
            decision: 'deny',
            reasonCode: 'NO_APPROVED_MODEL',
            policyVersion: 'generated-lexical-only',
          }),
        }),
        authorizeAgentContext: async () => true,
      },
      {
        purpose: 'agent_turn',
        question: 'closureanchor',
        queryClassification: 'internal',
        workUnitId: f.work.id,
        runId: f.runId,
        sourceIds: [source.sourceId],
        budgetTokens: 1000,
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!compiled.ok) throw new Error(`TEST_COMPILE_REFUSED:${compiled.code}`);
    await revokeSource(app.db, a.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Actual privacy closure fixture.',
    });
    const service = createServiceContext(a.organizationId);
    await purgeRunTranscriptsForSource(
      agent.db,
      service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId: source.sourceId },
    );
    const ledgerBefore = await withTenantTx(app.db, a.owner, (tx) =>
      tx.execute<{ cost: string }>(sql`select sum(cost_micros)::text cost from platform.usage_ledger
      where organization_id=${a.organizationId}::uuid and run_id=${f.runId}::uuid`),
    );
    const adapter = createDelegatedWorkPurge({
      database: agent.db,
      accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
    });
    expect(
      await adapter.purgeSource(service, { sourceId: source.sourceId, limit: 25 }),
    ).toMatchObject({
      confirmed: true,
      remaining: 0,
      controlsRemaining: 0,
      unproven: 0,
      removed: 0,
    });
    const [witness] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select()
        .from(sourceRunClosures)
        .where(
          and(
            eq(sourceRunClosures.sourceId, source.sourceId),
            eq(sourceRunClosures.runId, f.runId),
          ),
        ),
    );
    expect(witness).toMatchObject({
      sourceVersion: 2,
      fenceGeneration: 1,
      terminalStatus: 'cancelled',
    });
    expect(witness?.closedAt).toBeInstanceOf(Date);
    expect(
      await adapter.purgeSource(service, { sourceId: source.sourceId, limit: 25 }),
    ).toMatchObject({ confirmed: true, remaining: 0, controlsRemaining: 0 });
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(sourceRunClosures)
          .where(
            and(
              eq(sourceRunClosures.sourceId, source.sourceId),
              eq(sourceRunClosures.runId, f.runId),
            ),
          ),
      ),
    ).toEqual([witness]);
    expect(
      (
        await withTenantTx(app.db, a.owner, (tx) =>
          tx.execute<{
            cost: string;
          }>(sql`select sum(cost_micros)::text cost from platform.usage_ledger
      where organization_id=${a.organizationId}::uuid and run_id=${f.runId}::uuid`),
        )
      ).rows,
    ).toEqual(ledgerBefore.rows);
    await expect(
      createContextSource({
        database: agent.db,
        readObject: async () => {
          throw new Error('TEST_UNEXPECTED_BYTES');
        },
      }).loadWork(f.context, f.work.id),
    ).rejects.toThrow();
  });

  it('keeps actual source-consumer private rows while held, with its permanent fence committed', async () => {
    const source = await seedSearchableSource(app.db, a.owner, {
      passages: ['heldclosure is genuine compiler material.'],
      grants: [{ kind: 'organization' }],
    });
    const f = await fixture([
      'work.read',
      'data.internal.read',
      `knowledge.${source.sourceId}.read`,
    ]);
    const compiled = await compileEvidence(
      agent.db,
      f.context,
      {
        model: createScriptedModelPort({
          route: () => ({
            decision: 'deny',
            reasonCode: 'NO_APPROVED_MODEL',
            policyVersion: 'generated-lexical-only',
          }),
        }),
        authorizeAgentContext: async () => true,
      },
      {
        purpose: 'agent_turn',
        question: 'heldclosure',
        queryClassification: 'internal',
        workUnitId: f.work.id,
        runId: f.runId,
        sourceIds: [source.sourceId],
        budgetTokens: 1000,
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!compiled.ok) throw new Error(`TEST_COMPILE_REFUSED:${compiled.code}`);
    await revokeSource(app.db, a.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Actual source held after closure.',
    });
    const service = createServiceContext(a.organizationId),
      holdId = randomUUID();
    const privateCount = () =>
      withTenantTx(
        agent.db,
        service,
        async (tx) =>
          (
            await tx.execute<{ count: number }>(
              sql`select count(*)::integer count from ai.step_payloads payload join ai.execution_steps step
        on step.organization_id=payload.organization_id and step.id=payload.step_id
        where step.organization_id=${a.organizationId}::uuid and step.run_id=${f.runId}::uuid`,
            )
          ).rows[0]!.count,
      );
    const before = await privateCount();
    expect(before).toBeGreaterThan(0);
    await withTenantTx(app.db, a.owner, async (tx) => {
      await tx.execute(sql`insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
        values(${a.organizationId}::uuid,${holdId}::uuid,${randomUUID()},${a.owner.membershipId}::uuid)`);
      await tx.execute(sql`insert into lifecycle.legal_hold_scopes(organization_id,hold_id,scope_type)
        values(${a.organizationId}::uuid,${holdId}::uuid,'organization')`);
    });
    try {
      await expect(
        purgeRunTranscriptsForSource(
          agent.db,
          service,
          { transcripts: createRunTranscriptPurge() },
          { sourceId: source.sourceId },
        ),
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(await privateCount()).toBe(before);
      const [checkpoint] = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select({
            fencedAt: runInputCheckpoints.fencedAt,
            purgedAt: runInputCheckpoints.payloadsPurgedAt,
          })
          .from(runInputCheckpoints)
          .where(eq(runInputCheckpoints.runId, f.runId)),
      );
      expect(checkpoint?.fencedAt).toBeInstanceOf(Date);
      expect(checkpoint?.purgedAt).toBeNull();
    } finally {
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.execute(sql`update lifecycle.legal_holds set status='released',released_by_membership_id=${a.owner.membershipId}::uuid,
        released_at=now(),release_reason_code='TEST_RELEASE',version=version+1 where organization_id=${a.organizationId}::uuid and id=${holdId}::uuid`),
      );
    }
    expect(
      (
        await purgeRunTranscriptsForSource(
          agent.db,
          service,
          { transcripts: createRunTranscriptPurge() },
          { sourceId: source.sourceId },
        )
      ).removed,
    ).toBeGreaterThan(0);
    expect(await privateCount()).toBe(0);
  });

  it('requires actual native agent proof even for an explicitly checked source with no Work consumers', async () => {
    const source = await seedSearchableSource(app.db, a.owner, {
      passages: ['Actual source without a generated Work consumer.'],
      grants: [{ kind: 'organization' }],
    });
    const { purgeJobId } = await revokeSource(app.db, a.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Actual empty consumer-set fixture.',
    });
    const service = createServiceContext(a.organizationId),
      adapter = createDelegatedWorkPurge({
        database: agent.db,
        accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
      });
    expect(
      await withTenantTx(app.db, service, (tx) =>
        adapter.confirmInTx(tx, service, { sourceId: source.sourceId }),
      ),
    ).toMatchObject({ confirmed: false, remaining: 0, controlsRemaining: 0 });
    await purgeRunTranscriptsForSource(
      agent.db,
      service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId: source.sourceId },
    );
    expect(
      await adapter.purgeSource(service, { sourceId: source.sourceId, limit: 25 }),
    ).toMatchObject({ confirmed: true, removed: 0, remaining: 0, controlsRemaining: 0 });
    await expect(
      withTenantTx(app.db, service, (tx) =>
        tx
          .update(knowledgePurgeJobs)
          .set({ delegatedWorkRemoved: 99 })
          .where(eq(knowledgePurgeJobs.id, purgeJobId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    const [job] = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select().from(knowledgePurgeJobs).where(eq(knowledgePurgeJobs.id, purgeJobId)),
    );
    expect(job).toMatchObject({
      state: 'pending',
      delegatedWorkRemoved: 0,
      delegatedWorkRemaining: 0,
      delegatedWorkUnknown: 0,
      delegatedWorkControlsRemaining: 0,
      delegatedWorkSourceVersion: 2,
    });
    expect(job?.delegatedWorkCheckedAt).toBeInstanceOf(Date);
    expect(job?.delegatedWorkReceiptsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses direct app/agent witness and receipt inserts even with the actual proposal IDs', async () => {
    const f = await fixture();
    const witness = {
      organizationId: a.organizationId,
      workUnitId: f.childWorkId,
      childRunId: f.childRunId,
      parentRunId: f.runId,
      parentWorkUnitId: f.work.id,
      proposalId: f.proposalId,
      snapshotId: f.snapshot.id,
      birthContentSha256: hash('not the actual copied body'),
      classification: 'internal',
    };
    for (const attempt of [
      () => withTenantTx(app.db, a.owner, (tx) => tx.insert(delegatedWorkBirths).values(witness)),
      () =>
        withTenantTx(agent.db, f.context, (tx) => tx.insert(delegatedWorkBirths).values(witness)),
    ])
      await expect(attempt()).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(agent.db, f.context, async (tx) => {
        await loadAgentReadScopeInTx(tx, f.context);
        return tx.execute(sql`insert into ai.delegated_input_receipts
      (organization_id,child_run_id,parent_run_id,child_work_unit_id,proposal_id,snapshot_id,original_step_id,original_attempt,
       tool_step_number,request_sha256,proposal_payload_sha256,birth_content_sha256,input_inventory,inventory_sha256,classification)
      select ${a.organizationId}::uuid,${f.childRunId}::uuid,${f.runId}::uuid,${f.childWorkId}::uuid,
       candidate.proposal_id,candidate.snapshot_id,candidate.original_step_id,candidate.original_attempt,candidate.tool_step_number,
       candidate.request_sha256,candidate.proposal_payload_sha256,candidate.birth_content_sha256,candidate.input_inventory,candidate.inventory_sha256,candidate.classification
      from ai.delegation_birth_candidate(${f.runId}::uuid,${f.childRunId}::uuid) candidate`);
      }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });

  it('a real same-transaction Work UPDATE cannot manufacture an INSERT witness', async () => {
    const f = await fixture();
    const before = await f.candidate();
    const [current] = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select({ version: workUnits.version }).from(workUnits).where(eq(workUnits.id, f.work.id)),
    );
    if (!current) throw new Error('TEST_PARENT_WORK_MISSING');
    await updateWorkUnit(app.db, a.owner, f.work.id, current.version, {
      title: 'Actual changed parent',
    });
    await withTenantTx(app.db, a.owner, async (tx) => {
      await tx
        .update(workUnits)
        .set({ title: 'Actual changed parent' })
        .where(eq(workUnits.id, f.work.id));
      expect(
        await tx
          .select()
          .from(delegatedWorkBirths)
          .where(eq(delegatedWorkBirths.workUnitId, f.work.id)),
      ).toEqual([]);
    });
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(delegatedInputReceipts)
          .where(
            and(
              eq(delegatedInputReceipts.parentRunId, f.runId),
              eq(delegatedInputReceipts.childWorkUnitId, f.work.id),
            ),
          ),
      ),
    ).toEqual([]);
    // A routine mutable title change does not replace the historical hash or invent new inputs.
    expect(await f.candidate()).toEqual(before);
  });

  it('distinguishes historical content hashes from retained authority-only metadata', async () => {
    const f = await fixture();
    const refs = await withTenantTx(agent.db, f.context, async (tx) => {
      await loadAgentReadScopeInTx(tx, f.context);
      return (
        await tx.execute<{
          kind: string;
          id: string;
          sha256: string | null;
          proofKind: string;
        }>(sql`
        select ref_kind kind,ref_id id,content_sha256 sha256,proof_kind "proofKind" from ai.delegated_frozen_refs(
          (select input_inventory from ai.main_input_snapshots where organization_id=${a.organizationId}::uuid and id=${f.snapshot.id}::uuid))`)
      ).rows;
    });
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'work_unit',
          id: f.work.id,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          proofKind: 'actual_content',
        }),
        expect.objectContaining({
          kind: 'work_unit',
          id: f.work.id,
          sha256: null,
          proofKind: 'read_authority',
        }),
      ]),
    );
  });

  it('records only an actual Work INSERT and rolls the copied body back without its reciprocal child receipt', async () => {
    const f = await fixture();
    // The same assertion as a toSatisfy on the code, written so a failure prints the actual code.
    const refused = await withTenantTx(agent.db, f.context, async (tx) => {
      await loadAgentReadScopeInTx(tx, f.context);
      await tx.insert(workUnits).values({
        organizationId: a.organizationId,
        id: f.childWorkId,
        parentId: f.work.id,
        ownerMembershipId: a.owner.membershipId,
        createdByMembershipId: a.owner.membershipId,
        title: 'Actual copied child',
        classification: 'internal',
      });
      expect(
        await tx
          .select({ runId: delegatedWorkBirths.childRunId })
          .from(delegatedWorkBirths)
          .where(eq(delegatedWorkBirths.workUnitId, f.childWorkId)),
      ).toEqual([{ runId: f.childRunId }]);
      // No genuine child run/receipt is written: deferred reciprocal FK must reject the commit.
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(pgCode(refused)).toBe('23503');
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.childWorkId)),
      ),
    ).toEqual([]);
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(delegatedWorkBirths)
          .where(eq(delegatedWorkBirths.workUnitId, f.childWorkId)),
      ),
    ).toEqual([]);
  });

  it('refuses a child request without its actual original accepted proposal atomically', async () => {
    const f = await fixture();
    const childWorkId = idFromRequest('agent_child_work', f.context.membershipId, f.runId, 3);
    expect(
      await createChildRun(agent.db, f.context, { parentRunId: f.runId, stepNumber: 3 }),
    ).toMatchObject({ kind: 'denied' });
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, childWorkId)),
      ),
    ).toEqual([]);
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(delegatedWorkBirths)
          .where(eq(delegatedWorkBirths.workUnitId, childWorkId)),
      ),
    ).toEqual([]);
  });

  // These are genuine full-composition gates, not expected passes while0414/0417 readiness stays
  // false. Root must review/qualify the complete lifecycle before enabling and running them.
  async function genuineChildWithRecord() {
    const input = await createWorkUnit(app.db, a.owner, {
      title: 'Actual inherited record material',
    });
    const f = await fixture(undefined, async (context) => {
      await createContextSource({
        database: agent.db,
        readObject: async () => {
          throw new Error('TEST_UNEXPECTED_BYTES');
        },
      }).loadWork(context, input.id);
    });
    const created = await createChildRun(agent.db, f.context, {
      parentRunId: f.runId,
      stepNumber: 2,
    });
    if (created.kind !== 'created') {
      // The refusal's safe reason is audited; name it so a failure says which gate refused.
      const denials = await withTenantTx(app.db, a.owner, (tx) =>
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
      throw new Error(
        `TEST_GENUINE_CHILD_NOT_ADMITTED:${created.code}:${denials.map((row) => row.reason).join(',')}`,
      );
    }
    expect(created).toMatchObject({ childRunId: f.childRunId, childWorkUnitId: f.childWorkId });
    const child = await getWorkUnit(app.db, a.owner, f.childWorkId);
    expect(child.title).toBe('Actual copied child');
    const [receipt] = await withTenantTx(app.db, a.owner, (tx) =>
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
      database: agent.db,
      transcripts,
      accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
    });
  const closeRecord = (id: string) =>
    withTenantTx(app.db, a.owner, (tx) =>
      tx.insert(tombstones).values({
        organizationId: a.organizationId,
        targetType: 'work_unit',
        targetId: id,
        reasonCode: 'USER_DELETED',
      }),
    );

  it('full lifecycle: captures actual inheritance and permanently redacts copied Work once after real closure', async () => {
    const f = await genuineChildWithRecord();
    const later = await createWorkUnit(app.db, a.owner, {
      title: 'Read only after the original proposal',
    });
    await createContextSource({
      database: agent.db,
      readObject: async () => {
        throw new Error('TEST_UNEXPECTED_BYTES');
      },
    }).loadWork(f.context, later.id);
    await withTenantTx(app.db, a.owner, async (tx) => {
      expect(
        (
          await tx.execute<{ included: boolean }>(
            sql`select ai.delegated_record_ref(${f.childRunId}::uuid,'work_unit',${f.input.id}::uuid) included`,
          )
        ).rows[0]?.included,
      ).toBe(true);
      expect(
        (
          await tx.execute<{ included: boolean }>(
            sql`select ai.delegated_record_ref(${f.childRunId}::uuid,'work_unit',${later.id}::uuid) included`,
          )
        ).rows[0]?.included,
      ).toBe(false);
    });
    await closeRecord(f.input.id);
    await expect(getWorkUnit(app.db, a.owner, f.childWorkId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const service = createServiceContext(a.organizationId),
      purger = recordAdapter();
    expect(
      await purger.purgeRecord(service, { kind: 'work_unit', id: f.input.id, limit: 25 }),
    ).toEqual({ confirmed: true, removed: 1, remaining: 0, controlsRemaining: 0, unproven: 0 });
    const [disposed] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select()
        .from(delegatedInputReceipts)
        .where(eq(delegatedInputReceipts.childRunId, f.childRunId)),
    );
    expect(disposed).toMatchObject({
      ...f.receipt,
      redactedAt: expect.any(Date),
      redactedVersion: expect.any(Number),
      dispositionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      redactionScopeKind: 'work_unit',
      redactionScopeId: f.input.id,
      redactionPurgeJobId: null,
    });
    expect(
      await purger.purgeRecord(service, { kind: 'work_unit', id: f.input.id, limit: 25 }),
    ).toEqual({ confirmed: true, removed: 1, remaining: 0, controlsRemaining: 0, unproven: 0 });
    const [replayed] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select()
        .from(delegatedInputReceipts)
        .where(eq(delegatedInputReceipts.childRunId, f.childRunId)),
    );
    expect(replayed).toEqual(disposed);
    const resurrection = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .update(workUnits)
        .set({ title: 'Attempted resurrection' })
        .where(eq(workUnits.id, f.childWorkId))
        .returning({ id: workUnits.id }),
    ).catch((error: unknown) => {
      expect(['42501', 'EN119']).toContain(pgCode(error));
      return [];
    });
    expect(resurrection).toEqual([]);
  });

  it('full lifecycle: an actual hold preserves the copied body debt until a genuine release', async () => {
    const f = await genuineChildWithRecord(),
      holdId = randomUUID();
    await closeRecord(f.input.id);
    await withTenantTx(app.db, a.owner, async (tx) => {
      await tx.execute(sql`insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
        values(${a.organizationId}::uuid,${holdId}::uuid,${randomUUID()},${a.owner.membershipId}::uuid)`);
      await tx.execute(
        sql`insert into lifecycle.legal_hold_scopes(organization_id,hold_id,scope_type) values(${a.organizationId}::uuid,${holdId}::uuid,'organization')`,
      );
    });
    const service = createServiceContext(a.organizationId),
      purger = recordAdapter();
    const privateCount = () =>
      withTenantTx(
        agent.db,
        service,
        async (tx) =>
          (
            await tx.execute<{
              count: number;
            }>(sql`select count(*)::integer count from ai.step_payloads payload
        join ai.execution_steps step on step.organization_id=payload.organization_id and step.id=payload.step_id
        where step.organization_id=${a.organizationId}::uuid and step.run_id in(${f.runId}::uuid,${f.childRunId}::uuid)`)
          ).rows[0]!.count,
      );
    try {
      const before = await privateCount();
      expect(before).toBeGreaterThan(0);
      const held = await purger.purgeRecord(service, {
        kind: 'work_unit',
        id: f.input.id,
        limit: 25,
      });
      expect(held).toMatchObject({ confirmed: false, removed: 0, remaining: 1 });
      expect(held.controlsRemaining).toBeGreaterThan(0);
      expect(await privateCount()).toBe(before);
      const [checkpoint] = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select({
            fencedAt: runInputCheckpoints.fencedAt,
            purgedAt: runInputCheckpoints.payloadsPurgedAt,
          })
          .from(runInputCheckpoints)
          .where(eq(runInputCheckpoints.runId, f.runId)),
      );
      expect(checkpoint?.fencedAt).toBeInstanceOf(Date);
      expect(checkpoint?.purgedAt).toBeNull();
      const [pending] = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(delegatedInputReceipts)
          .where(eq(delegatedInputReceipts.childRunId, f.childRunId)),
      );
      expect(pending?.redactedAt).toBeNull();
      expect(pending?.dispositionSha256).toBeNull();
    } finally {
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.execute(sql`update lifecycle.legal_holds set status='released',released_by_membership_id=${a.owner.membershipId}::uuid,
      released_at=now(),release_reason_code='TEST_RELEASE',version=version+1 where organization_id=${a.organizationId}::uuid and id=${holdId}::uuid`),
      );
    }
    expect(
      await purger.purgeRecord(service, { kind: 'work_unit', id: f.input.id, limit: 25 }),
    ).toMatchObject({ confirmed: true, removed: 1, remaining: 0, controlsRemaining: 0 });
  });

  it('full lifecycle: unavailable transcript completion cannot clear real Work/control debt', async () => {
    const f = await genuineChildWithRecord();
    await closeRecord(f.input.id);
    const real = createRunTranscriptPurge(),
      service = createServiceContext(a.organizationId);
    const unknown = recordAdapter({ ...real, purgeUsing: async () => ({ removed: 0 }) });
    expect(
      await unknown.purgeRecord(service, { kind: 'work_unit', id: f.input.id, limit: 25 }),
    ).toMatchObject({ confirmed: false, removed: 0, remaining: 1 });
    const [fenced] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select({
          fencedAt: runInputCheckpoints.fencedAt,
          purgedAt: runInputCheckpoints.payloadsPurgedAt,
        })
        .from(runInputCheckpoints)
        .where(eq(runInputCheckpoints.runId, f.runId)),
    );
    expect(fenced?.fencedAt).toBeInstanceOf(Date);
    expect(fenced?.purgedAt).toBeNull();
    const [pending] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select()
        .from(delegatedInputReceipts)
        .where(eq(delegatedInputReceipts.childRunId, f.childRunId)),
    );
    expect(pending?.redactedAt).toBeNull();
    expect(
      await recordAdapter().purgeRecord(service, { kind: 'work_unit', id: f.input.id, limit: 25 }),
    ).toMatchObject({ confirmed: true, removed: 1, remaining: 0, controlsRemaining: 0 });
  });

  it('keeps exact fact metadata private to its owner-only seam for actual app and agent logins', async () => {
    const f = await fixture();
    await expect(
      withTenantTx(app.db, a.owner, (tx) =>
        tx.execute(sql`select * from knowledge.fact_authority_metadata(${randomUUID()}::uuid)`),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(agent.db, f.context, (tx) =>
        tx.execute(sql`select * from knowledge.fact_authority_metadata(${randomUUID()}::uuid)`),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    const dispatcher = new pg.Client({ connectionString: urls.dispatcher() });
    await dispatcher.connect();
    try {
      await expect(
        dispatcher.query('select * from knowledge.fact_authority_metadata($1)', [randomUUID()]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await dispatcher.end();
    }
  });

  it('the boolean fact seam refuses missing proof and restores exact private selectors on success/error', async () => {
    const prior = { org: b.organizationId, fact: randomUUID(), package: randomUUID() };
    await withTenantTx(app.db, a.owner, async (tx) => {
      await tx.execute(sql`select set_config('knowledge.fact_authority_org',${prior.org},true),
        set_config('knowledge.fact_authority_fact',${prior.fact},true),set_config('knowledge.fact_authority_package',${prior.package},true)`);
      const result = await tx.execute<{
        allowed: boolean;
      }>(sql`select knowledge.fact_authority_receipt_live(
        ${randomUUID()}::uuid,${randomUUID()}::uuid,${'a'.repeat(64)},'internal') allowed`);
      expect(result.rows).toEqual([{ allowed: false }]);
      const selectors = () =>
        tx.execute<{ org: string; fact: string; package: string }>(sql`select
        current_setting('knowledge.fact_authority_org',true) org,current_setting('knowledge.fact_authority_fact',true) fact,
        current_setting('knowledge.fact_authority_package',true) package`);
      expect((await selectors()).rows).toEqual([prior]);
      await expect(
        tx.transaction((savepoint) =>
          savepoint.execute(sql`select knowledge.fact_authority_receipt_live(
        ${randomUUID()}::uuid,${randomUUID()}::uuid,${'b'.repeat(64)},'invalid-protection')`),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
      expect((await selectors()).rows).toEqual([prior]);
    });
  });
});
