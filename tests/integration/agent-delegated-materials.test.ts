// Actual app/agent roles and real admission/usage/proposal/step services. No provider or invented
// observations. 0419 remains disabled until serving + positive disposition compose; SQL unrun.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  createWorkUnit,
  recordDelegatedWorkRedactionInTx,
  transitionWorkUnit,
  updateWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import { createChildRun } from '@ensemus/application/ai-delegation';
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
  agentRuns,
  delegatedInputReceipts,
  delegatedWorkBirths,
  mainInputSnapshots,
  openAppDatabase,
  withTenantTx,
  workUnits,
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

  async function fixture() {
    const work = await createWorkUnit(app.db, a.owner, { title: 'Actual parent work' });
    await transitionWorkUnit(app.db, a.owner, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    const spec = testAgentSpec({
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
    expect(
      await withTenantTx(app.db, b.owner, (tx) =>
        tx.select().from(mainInputSnapshots).where(eq(mainInputSnapshots.id, f.snapshot.id)),
      ),
    ).toEqual([]);
  });

  it('refuses app/agent redaction calls and cannot turn a genuine parent into an invented child disposition', async () => {
    const f = await fixture();
    const invoke = (tx: Parameters<typeof recordDelegatedWorkRedactionInTx>[0]) =>
      tx.execute(sql`select * from work.redact_delegated_body(${f.runId}::uuid,${f.work.id}::uuid,'work_unit',${f.work.id}::uuid,NULL::uuid)`);
    await expect(withTenantTx(app.db, createServiceContext(a.organizationId), invoke))
      .rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(withTenantTx(agent.db, f.context, invoke))
      .rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await withTenantTx(agent.db, createServiceContext(a.organizationId), async (tx) => {
      const prior = randomUUID();
      await tx.execute(sql`select set_config('app.delegated_work_redaction_run',${prior},true)`);
      expect((await invoke(tx)).rows).toEqual([]);
      expect((await tx.execute<{ value: string }>(sql`select current_setting('app.delegated_work_redaction_run',true) value`)).rows[0]?.value).toBe(prior);
    });
    expect((await withTenantTx(agent.db, createServiceContext(b.organizationId), invoke)).rows).toEqual([]);
    expect(await withTenantTx(app.db, a.owner, (tx) => tx.select().from(delegatedInputReceipts)
      .where(eq(delegatedInputReceipts.childRunId, f.runId)))).toEqual([]);
  });

  it('denies fabricated Work-update effect metadata without a real fixed-SQL disposition in this transaction', async () => {
    const f = await fixture(), service = createServiceContext(a.organizationId);
    const before = await withTenantTx(app.db, a.owner, (tx) => tx.select({ version: workUnits.version })
      .from(workUnits).where(eq(workUnits.id, f.work.id)));
    await expect(withTenantTx(agent.db, service, (tx) => recordDelegatedWorkRedactionInTx(tx, service, {
      current: f.work, contentSha256: hash('claimed redacted content'),
    }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await withTenantTx(app.db, a.owner, (tx) => tx.select({ version: workUnits.version })
      .from(workUnits).where(eq(workUnits.id, f.work.id)))).toEqual(before);
  });

  it('does not grant runtime roles direct disposition-stamp mutation', async () => {
    const f = await fixture();
    for (const context of [a.owner, createServiceContext(a.organizationId)])
      await expect(withTenantTx(app.db, context, (tx) => tx.update(delegatedInputReceipts)
        .set({ redactedAt: new Date(), redactedVersion: 1, dispositionSha256: hash('forged'),
          redactionScopeKind: 'work_unit', redactionScopeId: f.work.id })
        .where(eq(delegatedInputReceipts.childRunId, f.runId))))
        .rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
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
    await expect(
      withTenantTx(agent.db, f.context, async (tx) => {
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
      }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '23503');
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

  it('retains the interim birth refusal atomically while the disposition capability is unavailable', async () => {
    const f = await fixture();
    expect(
      await createChildRun(agent.db, f.context, { parentRunId: f.runId, stepNumber: 2 }),
    ).toMatchObject({ kind: 'denied' });
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
