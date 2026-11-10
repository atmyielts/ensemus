// Actual app/agent roles after 0416. Authored source only until the parent's fresh-PG gate.
// No provider, fabricated run observation, trigger disable or model-selected input inventory.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createWorkUnit, transitionWorkUnit } from '@ensemus/application';
import { createContextSource } from '@ensemus/application/ai-context-source';
import { claimQueuedRun, createTurnStore, finishRun } from '@ensemus/application/ai-runs';
import { storeProposal, loadProposal } from '@ensemus/application/ai-tool-steps';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { proposeFact, reviewFact } from '@ensemus/application/knowledge/facts';
import {
  admitMainModelDispatchInTx,
  receiveMainInputSnapshotInTx,
  type MainModelAdmission,
} from '@ensemus/application/ai-model-admission';
import {
  agentRuns,
  evidencePackageFacts,
  knowledgeEvidencePackages,
  mainInputSnapshots,
  modelProposalInputs,
  openAppDatabase,
  withTenantTx,
  workUnits,
} from '@ensemus/database';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import { pgCode } from '../../packages/application/src/errors';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  testAgentSpec,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

const hash = (body: string) => createHash('sha256').update(body).digest('hex');
describe('exact main attempt inputs and accepted proposal origin (0416)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  let a: AiTenant, b: AiTenant, profileId: string;
  beforeAll(async () => {
    a = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    b = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    profileId = await seedActiveProfile(app.db, agent.db, a.owner);
  });
  afterAll(async () => {
    await agent.close();
    await app.close();
  });
  async function fixture(scopes = ['work.read']) {
    const work = await createWorkUnit(app.db, a.owner, {
      title: 'Generated snapshot fixture',
      objective: 'Read exact inputs.',
    });
    await transitionWorkUnit(app.db, a.owner, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    const version = await seedAgentVersion(
      app.db,
      a.owner,
      testAgentSpec({ context: { allowed_scopes: scopes, memory_write_policy: 'none' } }),
    );
    const runId = await seedQueuedRun(app.db, a.owner, { workUnitId: work.id, version });
    if (
      !(await claimQueuedRun(agent.db, {
        organizationId: a.organizationId,
        workUnitId: work.id,
        temporalRunId: randomUUID(),
      }))
    )
      throw new Error('TEST_RUN_NOT_CLAIMED');
    const context = await prepareRunInputContext(agent.db, a.organizationId, runId);
    await withTenantTx(agent.db, context, (tx) =>
      tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId)),
    );
    const start = await createTurnStore(agent.db).beginTurn(context, { runId, stepNumber: 1 });
    if (start.kind !== 'begin') throw new Error('TEST_STEP_NOT_STARTED');
    const main: MainModelAdmission = {
      runId,
      stepId: start.stepId,
      attempt: start.attempt,
      reservationAttempt: start.attempt,
      agentVersionId: version.versionId,
      workUnitId: work.id,
      purpose: 'reason',
      classification: 'internal',
      profileId,
      profileVersion: 1,
      ceiling: { inputTokens: 30, outputTokens: 5 },
      costMicros: 1,
      priorUsage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      snapshot: {
        id: randomUUID(),
        writerToken: randomUUID(),
        requestHash: hash(`generated SDK request ${randomUUID()}`),
        phase: 'prepare',
      },
    };
    const snapshot = main.snapshot;
    if (!snapshot) throw new Error('TEST_SNAPSHOT_MISSING');
    const admit = (phase: 'prepare' | 'dispatch') =>
      withTenantTx(agent.db, context, (tx) =>
        admitMainModelDispatchInTx(tx, context, { ...main, snapshot: { ...snapshot, phase } }),
      );
    const rows = () =>
      withTenantTx(agent.db, context, (tx) =>
        tx.select().from(mainInputSnapshots).where(eq(mainInputSnapshots.id, snapshot.id)),
      );
    const receive = (args: unknown, toolId = 'work.read') =>
      withTenantTx(agent.db, context, (tx) =>
        receiveMainInputSnapshotInTx(tx, context, {
          snapshotId: snapshot.id,
          writerToken: snapshot.writerToken,
          kind: 'tool_call',
          toolId,
          payloadHash: hash(JSON.stringify(args)),
        }),
      );
    return { context, main, snapshot, admit, rows, receive, start, runId, work };
  }
  it('captures actual Work hashes, refuses duplicate writer/dispatch claims, and exposes no writer token to app', async () => {
    const f = await fixture();
    expect(await f.admit('prepare')).toBeNull();
    const [prepared] = await f.rows();
    expect(prepared?.state).toBe('prepared');
    expect(prepared?.inputInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'work_unit',
          id: f.work.id,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]),
    );
    expect(await f.admit('prepare')).toBe('POLICY_UNREADABLE');
    expect(
      await withTenantTx(agent.db, f.context, (tx) =>
        admitMainModelDispatchInTx(tx, f.context, {
          ...f.main,
          snapshot: { ...f.snapshot, id: randomUUID(), writerToken: randomUUID() },
        }),
      ),
    ).toBe('POLICY_UNREADABLE');
    expect(await f.admit('dispatch')).toBeNull();
    expect(await f.admit('dispatch')).toBe('POLICY_UNREADABLE');
    await expect(
      withTenantTx(app.db, a.owner, (tx) =>
        tx.select({ token: mainInputSnapshots.writerToken }).from(mainInputSnapshots),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });
  it('freezes before network and refuses a newly observed OTHER Work before dispatch', async () => {
    const f = await fixture();
    expect(await f.admit('prepare')).toBeNull();
    const original = (await f.rows())[0]?.inputInventory;
    const other = await createWorkUnit(app.db, a.owner, { title: 'Later actual read' });
    await createContextSource({
      database: agent.db,
      readObject: async () => {
        throw new Error('TEST_UNEXPECTED_BYTES');
      },
    }).loadWork(f.context, other.id);
    await expect(f.admit('dispatch')).rejects.toSatisfy(
      (error: unknown) => pgCode(error) === 'EN119',
    );
    expect((await f.rows())[0]?.inputInventory).toEqual(original);
    expect((await f.rows())[0]?.state).toBe('prepared');
  });
  it('retains the actual dispatched prefix without attributing later parent reads to that earlier response', async () => {
    const f = await fixture();
    expect(await f.admit('prepare')).toBeNull();
    expect(await f.admit('dispatch')).toBeNull();
    const original = (await f.rows())[0]?.inputInventory;
    const other = await createWorkUnit(app.db, a.owner, { title: 'Actual read after dispatch' });
    await createContextSource({
      database: agent.db,
      readObject: async () => {
        throw new Error('TEST_UNEXPECTED_BYTES');
      },
    }).loadWork(f.context, other.id);
    await f.receive({ work_unit_id: f.work.id });
    expect((await f.rows())[0]?.inputInventory).toEqual(original);
    expect((await f.rows())[0]?.inputInventory).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: other.id })]),
    );
  });
  it('rejects a stale original model attempt and admits the actual new attempt with its own receipt', async () => {
    const f = await fixture();
    expect(await f.admit('prepare')).toBeNull();
    expect(await f.admit('dispatch')).toBeNull();
    // Actual TurnStore reclaim, not an UPDATE/forged attempt stamp. There was no provider in this test.
    const resumed = await createTurnStore(agent.db).beginTurn(f.context, {
      runId: f.runId,
      stepNumber: 1,
    });
    if (resumed.kind !== 'begin' || resumed.attempt <= f.start.attempt)
      throw new Error('TEST_ATTEMPT_NOT_RECLAIMED');
    await expect(f.receive({ work_unit_id: f.work.id })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    const snapshot = { ...f.snapshot, id: randomUUID(), writerToken: randomUUID() };
    expect(
      await withTenantTx(agent.db, f.context, (tx) =>
        admitMainModelDispatchInTx(tx, f.context, {
          ...f.main,
          attempt: resumed.attempt,
          reservationAttempt: resumed.attempt,
          snapshot,
        }),
      ),
    ).toBeNull();
  });
  it('binds the validated exact tool-argument hash to the original snapshot and cannot rewrite that origin on retry', async () => {
    const f = await fixture(),
      args = { work_unit_id: f.work.id };
    expect(await f.admit('prepare')).toBeNull();
    await expect(f.receive(args)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await f.admit('dispatch')).toBeNull();
    await f.receive(args);
    const proposal = await storeProposal(agent.db, f.context, {
      runId: f.runId,
      stepNumber: 1,
      toolId: 'work.read',
      args,
      originatingModel: {
        stepId: f.start.stepId,
        attempt: f.start.attempt,
        inputSnapshotId: f.snapshot.id,
      },
    });
    expect(
      (await loadProposal(agent.db, f.context, { runId: f.runId, stepNumber: 1 }))?.inputSnapshotId,
    ).toBe(f.snapshot.id);
    await expect(f.receive(args)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(
      await withTenantTx(app.db, b.owner, (tx) =>
        tx
          .select()
          .from(modelProposalInputs)
          .where(eq(modelProposalInputs.proposalId, proposal.proposalId)),
      ),
    ).toEqual([]);
  });
  it('rejects wrong tool/payload binding and atomically leaves neither proposal nor payload receipt', async () => {
    const f = await fixture();
    expect(await f.admit('prepare')).toBeNull();
    expect(await f.admit('dispatch')).toBeNull();
    await f.receive({ work_unit_id: f.work.id });
    await expect(
      storeProposal(agent.db, f.context, {
        runId: f.runId,
        stepNumber: 1,
        toolId: 'work.read',
        args: { work_unit_id: randomUUID() },
        originatingModel: {
          stepId: f.start.stepId,
          attempt: f.start.attempt,
          inputSnapshotId: f.snapshot.id,
        },
      }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    expect(await loadProposal(agent.db, f.context, { runId: f.runId, stepNumber: 1 })).toBeNull();
  });
  it('refuses a different actual run principal and an app-role forged origin', async () => {
    const f = await fixture(),
      other = await fixture();
    expect(await f.admit('prepare')).toBeNull();
    expect(await f.admit('dispatch')).toBeNull();
    await expect(
      withTenantTx(agent.db, other.context, (tx) =>
        receiveMainInputSnapshotInTx(tx, other.context, {
          snapshotId: f.snapshot.id,
          writerToken: f.snapshot.writerToken,
          kind: 'final',
          toolId: null,
          payloadHash: hash('Generated output'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(
      await withTenantTx(app.db, b.owner, (tx) =>
        tx
          .select({ id: mainInputSnapshots.id })
          .from(mainInputSnapshots)
          .where(eq(mainInputSnapshots.id, f.snapshot.id)),
      ),
    ).toEqual([]);
    await expect(
      withTenantTx(app.db, a.owner, (tx) =>
        tx.insert(modelProposalInputs).values({
          organizationId: a.organizationId,
          proposalId: randomUUID(),
          snapshotId: f.snapshot.id,
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    expect((await f.rows())[0]?.state).toBe('dispatched');
  });
  it('a result-write rollback and lost acknowledgment cannot create a second accepted response', async () => {
    const f = await fixture(),
      args = { work_unit_id: f.work.id };
    expect(await f.admit('prepare')).toBeNull();
    expect(await f.admit('dispatch')).toBeNull();
    await expect(
      withTenantTx(agent.db, f.context, async (tx) => {
        await receiveMainInputSnapshotInTx(tx, f.context, {
          snapshotId: f.snapshot.id,
          writerToken: f.snapshot.writerToken,
          kind: 'tool_call',
          toolId: 'work.read',
          payloadHash: hash(JSON.stringify(args)),
        });
        throw new Error('TEST_DOMAIN_ROLLBACK');
      }),
    ).rejects.toThrow('TEST_DOMAIN_ROLLBACK');
    expect((await f.rows())[0]?.state).toBe('dispatched');
    await f.receive(args);
    expect((await f.rows())[0]?.state).toBe('response_received');
    await expect(f.receive(args)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('permanent terminal fencing refuses late in-flight result receipts while preserving their metadata', async () => {
    const f = await fixture();
    expect(await f.admit('prepare')).toBeNull();
    expect(await f.admit('dispatch')).toBeNull();
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    await expect(f.receive({ work_unit_id: f.work.id })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect((await f.rows())[0]?.state).toBe('dispatched');
    await expect(
      withTenantTx(agent.db, f.context, (tx) =>
        tx.execute(
          sql`delete from ai.main_input_snapshots where organization_id=${a.organizationId}::uuid and id=${f.snapshot.id}::uuid`,
        ),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });
  it('retains the actual compiler fact hash and complete selected evidence, and refuses legacy fact packages without that proof', async () => {
    const source = await seedSearchableSource(app.db, a.owner, {
      passages: ['snapshotanchor is a generated verified input.'],
      grants: [{ kind: 'organization' }],
    });
    const f = await fixture(['data.internal.read', `knowledge.${source.sourceId}.read`]);
    const proposed = await proposeFact(app.db, a.member, {
      subjectRef: `work_unit:${f.work.id}`,
      predicate: 'delivery.note',
      claim: { text: 'snapshotanchor' },
      origin: 'person',
      evidence: [{ chunkId: source.chunkIds[0]!, quoteStart: 0, quoteEnd: 5 }],
    });
    await reviewFact(app.db, a.owner, {
      factId: proposed.factId,
      expectedVersion: 1,
      decision: 'verify',
      reason: 'Checked generated input.',
    });
    // The earlier genuine context read must not leak its transaction-local authority. This is a
    // production compiler admission regression, not permission granted to the test connection.
    expect(
      await withTenantTx(agent.db, f.context, (tx) =>
        tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)),
      ),
    ).toEqual([]);
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
        question: 'snapshotanchor',
        queryClassification: 'internal',
        workUnitId: f.work.id,
        runId: f.runId,
        sourceIds: [source.sourceId],
        budgetTokens: 1000,
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!compiled.ok) throw new Error(`TEST_COMPILE_REFUSED:${compiled.code}`);
    expect(
      await withTenantTx(agent.db, f.context, (tx) =>
        tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)),
      ),
    ).toEqual([]);
    const fact = compiled.verifiedFacts.find((value) => value.factId === proposed.factId);
    if (!fact) throw new Error('TEST_FACT_NOT_SELECTED');
    const expectedHash = hash(
      JSON.stringify({ subjectRef: fact.subjectRef, predicate: fact.predicate, claim: fact.claim }),
    );
    const [receipt] = await withTenantTx(agent.db, f.context, (tx) =>
      tx
        .select()
        .from(evidencePackageFacts)
        .where(eq(evidencePackageFacts.packageId, compiled.packageId)),
    );
    expect(receipt).toMatchObject({
      factId: proposed.factId,
      subjectRef: fact.subjectRef,
      contentSha256: expectedHash,
      classification: 'internal',
    });
    expect(await f.admit('prepare')).toBeNull();
    expect((await f.rows())[0]?.inputInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'fact',
          id: fact.factId,
          sha256: expectedHash,
          packageId: compiled.packageId,
          subjectRef: fact.subjectRef,
        }),
        expect.objectContaining({
          kind: 'chunk',
          id: source.chunkIds[0],
          sourceId: source.sourceId,
        }),
      ]),
    );
    const [pkg] = await withTenantTx(agent.db, f.context, (tx) =>
      tx
        .select()
        .from(knowledgeEvidencePackages)
        .where(eq(knowledgeEvidencePackages.id, compiled.packageId)),
    );
    if (!pkg) throw new Error('TEST_PACKAGE_MISSING');
    // Actual old-writer shape: a package may exist without the new receipt, but it cannot borrow a
    // newer package's receipt or manufacture a historical claim read by looking up current facts.
    await withTenantTx(agent.db, f.context, (tx) =>
      tx.insert(knowledgeEvidencePackages).values({ ...pkg, id: randomUUID() }),
    );
    await expect(f.admit('dispatch')).rejects.toSatisfy(
      (error: unknown) => pgCode(error) === 'EN119',
    );
    expect((await f.rows())[0]?.state).toBe('prepared');
  });
});
