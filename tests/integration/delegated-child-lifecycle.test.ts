// ADR-028 open question 12, owner decision (b) of 2026-11-09: every lifecycle item is qualified with a
// genuine delegated child before part 1 is recorded. These are the positives for L1 (inherited serving),
// L2 (generated-file authority), L3 (source closure with separate Work counts), L5 (transcript purge and
// version proof) and L7 (the output guard). L4 and the record half of L3 are the acceptance cases in
// agent-delegated-materials.test.ts; L6 and L8b are in agent-delegated-offboarding.test.ts and L8a in
// record-deletion-outbox.test.ts. Real roles and services; the capability is qualified for this file
// through the migrator and restored afterwards. SQL first runs in the CI run after 0548 was journaled.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { createWorkUnit, getWorkUnit, readArtifact, type ObjectStore } from '@ensemus/application';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { controlAgentRun } from '@ensemus/application/ai-run-control';
import { finishRun, purgeEndedRunTranscript } from '@ensemus/application/ai-runs';
import { createToolStepStore } from '@ensemus/application/ai-tool-steps';
import { createDelegatedWorkPurge } from '@ensemus/application/knowledge/delegated-work-purge';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { purgeRunTranscriptsForSource, revokeSource } from '@ensemus/application/knowledge/purge';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import {
  agentRuns,
  artifactAuthorityRefs,
  artifactLineage,
  delegatedInputReceipts,
  executionSteps,
  knowledgePurgeJobs,
  openAppDatabase,
  runInputCheckpoints,
  withTenantTx,
  type AgentContext,
} from '@ensemus/database';
import { createAgentContext } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { pgCode } from '../../packages/application/src/errors';
import {
  openAgentTestDatabase,
  seedActiveProfile,
  seedAiTenant,
  seedOrganizationBudget,
  seedRateCard,
  sha256Of,
  withAdmittedRunTx,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';
import { delegatedChildHarness } from '../helpers/delegated-child';
import { qualifyDelegationForSuite } from '../helpers/delegation-capability';

class Store implements ObjectStore {
  bodies = new Map<string, Buffer>();
  gets = 0;
  async put(key: string, body: Buffer) {
    this.bodies.set(key, Buffer.from(body));
  }
  async get(key: string) {
    this.gets++;
    const body = this.bodies.get(key);
    if (!body) throw new Error('TEST_OBJECT_MISSING');
    return Buffer.from(body);
  }
  async delete(key: string) {
    this.bodies.delete(key);
  }
  async exists(key: string) {
    return this.bodies.has(key);
  }
}
/** The SQLSTATE and raised message of a refusal, or null when the operation went through. */
async function refusalOf(operation: Promise<unknown>) {
  try {
    await operation;
    return null;
  } catch (error) {
    return {
      code: pgCode(error),
      message: (error as { cause?: { message?: string } }).cause?.message,
    };
  }
}

describe('ADR-028 delegated child lifecycle qualification', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  let a: AiTenant, profileId: string, rateCardId: string;
  let capability: Awaited<ReturnType<typeof qualifyDelegationForSuite>> | undefined;
  beforeAll(async () => {
    capability = await qualifyDelegationForSuite('delegated-child-lifecycle');
    a = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    profileId = await seedActiveProfile(app.db, agent.db, a.owner);
    rateCardId = await seedRateCard(app.db, a.owner, profileId);
    await seedOrganizationBudget(app.db, a.owner, 1_000_000);
  });
  afterAll(async () => {
    await capability?.restore();
    await agent.close();
    await app.close();
  });
  const { genuineChildWithRecord, recordAdapter, closeRecord } = delegatedChildHarness({
    app: app.db,
    agent: agent.db,
    tenant: () => a,
    profileId: () => profileId,
    rateCardId: () => rateCardId,
  });
  const childContextOf = (childRunId: string) =>
    createAgentContext(agent.db, {
      organizationId: a.organizationId,
      initiatorMembershipId: a.owner.membershipId,
      agentRunId: childRunId,
    });

  /**
   * The born child, moved queued, preparing, running by raw agent-role UPDATEs, with one tool step
   * inserted directly and the generated-draft path wired exactly as the tool gateway drives it. This is
   * NOT the runtime's start: claimQueuedRun (initiator access, ceiling and Work-claim checks, assignment
   * and first step) and openStep are skipped, so a check they would apply to a delegated child is not
   * exercised by the L2 and L7 cases. The database guards on every write still apply.
   */
  async function runningChild(f: { childRunId: string; childWorkId: string }) {
    const context = await childContextOf(f.childRunId),
      store = new Store(),
      tools = createToolStepStore({ database: agent.db, objects: store });
    await withTenantTx(agent.db, context, async (tx) => {
      await tx.update(agentRuns).set({ status: 'preparing' }).where(eq(agentRuns.id, f.childRunId));
      await tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, f.childRunId));
    });
    const stepId = randomUUID();
    await withAdmittedRunTx(agent.db, context, (tx) =>
      tx.insert(executionSteps).values({
        organizationId: a.organizationId,
        id: stepId,
        runId: f.childRunId,
        stepNumber: 0,
        kind: 'tool_call',
        state: 'in_flight',
        labelCode: 'DRAFTING_ARTIFACT',
      }),
    );
    const draftId = tools.draftIdFor(context, { runId: f.childRunId, stepNumber: 0 }),
      text = 'Synthetic delegated child output.';
    const note = () =>
      withTenantTx(agent.db, context, async (tx) => {
        await tools.readRun(tx, context, f.childRunId, { lock: true });
        return tools.noteDraftUpload(tx, context, {
          draftId,
          workUnitId: f.childWorkId,
          runId: f.childRunId,
          text,
        });
      });
    const publish = (write: Awaited<ReturnType<typeof note>>) =>
      tools.withTx(context, async (tx) => {
        await tools.readRun(tx, context, f.childRunId, { lock: true });
        return tools.insertDraft(tx, context, {
          draftId,
          runId: f.childRunId,
          stepId,
          workUnitId: f.childWorkId,
          name: 'generated.txt',
          text,
          classification: 'internal',
          evidence: [],
          write,
        });
      });
    const generate = async () => {
      const write = await note();
      await tools.putDraft(context, { draftId, text, write });
      await publish(write);
      return write;
    };
    /**
     * A pending lineage header shaped as beginInTx writes one, behind the run's own admission. With
     * `admitted: false` the run's readRun admission is skipped, so a refusal can only come from the
     * database's own guards on the insert (0525's output guard is reached before its admission check).
     */
    const gatedHeader = (workUnitId: string, options: { admitted?: boolean } = {}) =>
      withTenantTx(agent.db, context, async (tx) => {
        if (options.admitted !== false)
          await tools.readRun(tx, context, f.childRunId, { lock: true });
        const artifactId = randomUUID();
        await tx.insert(artifactLineage).values({
          organizationId: a.organizationId,
          artifactId,
          workUnitId,
          objectKey: `${a.organizationId}/artifacts/${artifactId}`,
          artifactSha256: sha256Of('Synthetic bounded child output.'),
          sizeBytes: 31,
          classification: 'internal',
          executionKind: 'agent_run',
          executionId: f.childRunId,
          executorRef: 'agent-run/v1',
          viewerMembershipId: context.membershipId,
          inventorySha256: sha256Of('synthetic inventory'),
          inventoryComplete: true,
          structuredInventoryComplete: true,
          state: 'pending',
          writeId: randomUUID(),
          generation: 1,
          writeState: 'active',
        });
        return artifactId;
      });
    return { context, store, tools, draftId, text, generate, gatedHeader };
  }

  it('[ADR028-Q12-L1] full lifecycle: inherited serving admits only named viewers of the copied child Work', async () => {
    const f = await genuineChildWithRecord();
    const child = await getWorkUnit(app.db, a.owner, f.childWorkId);
    expect(child.title).toBe('Actual copied child');
    await expect(getWorkUnit(app.db, a.member, f.childWorkId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const readable = (viewer: string) =>
      withTenantTx(
        app.db,
        a.owner,
        async (tx) =>
          (
            await tx.execute<{ readable: boolean }>(
              sql`select knowledge.work_scope_readable(${f.childWorkId}::uuid,${viewer}::uuid) readable`,
            )
          ).rows[0]?.readable,
      );
    expect(await readable(a.owner.membershipId)).toBe(true);
    expect(await readable(a.member.membershipId)).toBe(false);
    const childContext: AgentContext = await childContextOf(f.childRunId);
    expect(
      await withTenantTx(
        agent.db,
        childContext,
        async (tx) =>
          (
            await tx.execute<{ admitted: boolean }>(
              sql`select ai.run_scope_preflight(${f.childRunId}::uuid) admitted`,
            )
          ).rows[0]?.admitted,
      ),
    ).toBe(true);
    await closeRecord(f.input.id);
    await expect(getWorkUnit(app.db, a.owner, f.childWorkId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('[ADR028-Q12-L2] full lifecycle: a child’s generated file retains its inherited read authority', async () => {
    const f = await genuineChildWithRecord(),
      child = await runningChild(f);
    await child.generate();
    const refs = await withTenantTx(app.db, createServiceContext(a.organizationId), (tx) =>
      tx
        .select({ kind: artifactAuthorityRefs.refKind, id: artifactAuthorityRefs.refId })
        .from(artifactAuthorityRefs)
        .where(eq(artifactAuthorityRefs.artifactId, child.draftId)),
    );
    expect(refs).toEqual(expect.arrayContaining([{ kind: 'work_unit', id: f.input.id }]));
    const served = () =>
      readArtifact(app.db, child.store, a.owner, {
        workUnitId: f.childWorkId,
        artifactId: child.draftId,
      });
    expect((await served()).body.toString()).toBe(child.text);
    await finishRun(agent.db, child.context, {
      agentRunId: f.childRunId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    await closeRecord(f.input.id);
    // Closing the input alone already ends serving, before any purge: the copied child Work becomes
    // invisible (as in the L1 case), and readArtifact refuses through Work visibility. That refusal is
    // not evidence about the file's own authority, which is why the retained refs are checked
    // separately: the closure did not strip the generated file's inherited input ref.
    const gets = child.store.gets;
    await expect(served()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(child.store.gets).toBe(gets);
    const kept = await withTenantTx(app.db, createServiceContext(a.organizationId), (tx) =>
      tx
        .select({ kind: artifactAuthorityRefs.refKind, id: artifactAuthorityRefs.refId })
        .from(artifactAuthorityRefs)
        .where(eq(artifactAuthorityRefs.artifactId, child.draftId)),
    );
    expect(kept).toEqual(expect.arrayContaining([{ kind: 'work_unit', id: f.input.id }]));
    const service = createServiceContext(a.organizationId);
    expect(
      await recordAdapter().purgeRecord(service, { kind: 'work_unit', id: f.input.id, limit: 25 }),
    ).toMatchObject({ confirmed: true, remaining: 0, controlsRemaining: 0 });
    // After the copied Work's purge, still refused, and still without reading a byte.
    await expect(served()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(child.store.gets).toBe(gets);
  });

  it('[ADR028-Q12-L3] full lifecycle: source closure redacts copied Work with separate Work counts', async () => {
    const source = await seedSearchableSource(app.db, a.owner, {
      passages: ['delegatedsourceanchor is an actual lexical input.'],
      grants: [{ kind: 'organization' }],
    });
    const f = await genuineChildWithRecord({
      scopes: ['work.read', 'data.internal.read', `knowledge.${source.sourceId}.read`],
      beforeModel: async (context) => {
        const [run] = await withTenantTx(agent.db, context, (tx) =>
          tx
            .select({ workUnitId: agentRuns.workUnitId })
            .from(agentRuns)
            .where(eq(agentRuns.id, context.agentRunId)),
        );
        if (!run) throw new Error('TEST_PARENT_MISSING');
        const compiled = await compileEvidence(
          agent.db,
          context,
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
            question: 'delegatedsourceanchor',
            queryClassification: 'internal',
            workUnitId: run.workUnitId,
            runId: context.agentRunId,
            sourceIds: [source.sourceId],
            budgetTokens: 1000,
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!compiled.ok) throw new Error(`TEST_COMPILE_REFUSED:${compiled.code}`);
      },
    });
    await revokeSource(app.db, a.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Actual delegated source closure fixture.',
    });
    const service = createServiceContext(a.organizationId);
    await purgeRunTranscriptsForSource(
      agent.db,
      service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId: source.sourceId },
    );
    const adapter = createDelegatedWorkPurge({
      database: agent.db,
      accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
    });
    expect(
      await adapter.purgeSource(service, { sourceId: source.sourceId, limit: 25 }),
    ).toMatchObject({
      confirmed: true,
      removed: 1,
      remaining: 0,
      controlsRemaining: 0,
      unproven: 0,
    });
    const [job] = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select().from(knowledgePurgeJobs).where(eq(knowledgePurgeJobs.sourceId, source.sourceId)),
    );
    // Copied Work bodies are counted on their own, apart from file and transcript removals.
    expect(job).toMatchObject({
      delegatedWorkRemoved: 1,
      delegatedWorkRemaining: 0,
      delegatedWorkUnknown: 0,
      delegatedWorkControlsRemaining: 0,
    });
    const [receipt] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select()
        .from(delegatedInputReceipts)
        .where(eq(delegatedInputReceipts.childRunId, f.childRunId)),
    );
    expect(receipt).toMatchObject({
      redactedAt: expect.any(Date),
      redactionScopeKind: 'knowledge_source',
      redactionScopeId: source.sourceId,
      redactionPurgeJobId: job?.id,
    });
  });

  it('[ADR028-Q12-L5] full lifecycle: child and parent transcripts are purged with a current version proof', async () => {
    const f = await genuineChildWithRecord(),
      service = createServiceContext(a.organizationId);
    await finishRun(agent.db, await childContextOf(f.childRunId), {
      agentRunId: f.childRunId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    for (const runId of [f.childRunId, f.runId])
      expect(await purgeEndedRunTranscript(agent.db, service, { agentRunId: runId })).toBe(
        'purged',
      );
    await closeRecord(f.input.id);
    expect(
      await recordAdapter().purgeRecord(service, { kind: 'work_unit', id: f.input.id, limit: 25 }),
    ).toMatchObject({ confirmed: true, removed: 1, remaining: 0, controlsRemaining: 0 });
    await withTenantTx(agent.db, service, async (tx) => {
      const generation = (
        await tx.execute<{ generation: string | null }>(
          sql`select ai.current_material_restore_generation()::text generation`,
        )
      ).rows[0]?.generation;
      const checkpoints = await tx
        .select()
        .from(runInputCheckpoints)
        .where(inArray(runInputCheckpoints.runId, [f.runId, f.childRunId]));
      expect(checkpoints).toHaveLength(2);
      for (const checkpoint of checkpoints) {
        expect(checkpoint.payloadsPurgedAt).toBeInstanceOf(Date);
        expect(checkpoint.purgedFenceGeneration).toBe(checkpoint.fenceGeneration);
        expect(checkpoint.purgedRestoreGeneration).toBe(generation);
      }
      const stale = await tx.execute<{ n: number }>(sql`select count(*)::integer n
        from ai.record_run_closures closure join ai.agent_runs run
          on run.organization_id=closure.organization_id and run.id=closure.run_id
        where closure.organization_id=${a.organizationId}::uuid and closure.terminal_version>run.version`);
      expect(stale.rows).toEqual([{ n: 0 }]);
      const payloads = await tx.execute<{ n: number }>(sql`select count(*)::integer n
        from ai.step_payloads payload join ai.execution_steps step
          on step.organization_id=payload.organization_id and step.id=payload.step_id
        where step.organization_id=${a.organizationId}::uuid and step.run_id in(${f.runId}::uuid,${f.childRunId}::uuid)`);
      expect(payloads.rows).toEqual([{ n: 0 }]);
    });
  });

  it('[ADR028-Q12-L7] full lifecycle: a running child writes only its own Work, and not after a stop', async () => {
    const f = await genuineChildWithRecord(),
      child = await runningChild(f),
      third = await createWorkUnit(app.db, a.owner, { title: 'A third readable Work' });
    const lineageOf = (artifactId: string) =>
      withTenantTx(agent.db, createServiceContext(a.organizationId), (tx) =>
        tx.select().from(artifactLineage).where(eq(artifactLineage.artifactId, artifactId)),
      );
    // The parent's Work and any other Work are not this child's lineage (0417, as bounded by 0525).
    for (const target of [f.work.id, third.id])
      expect(await refusalOf(child.gatedHeader(target))).toEqual({
        code: 'EN119',
        message: 'RUN_OUTPUT_AUTHORITY_UNBOUND',
      });
    // Its own copied Work, while running and unstopped, behaves as 0525 lets a root run write.
    await child.generate();
    expect(await lineageOf(child.draftId)).toEqual([
      expect.objectContaining({ state: 'bound', workUnitId: f.childWorkId }),
    ]);
    // Positive control: the same hand-built header for the child's own Work is accepted while it runs,
    // so a refusal after the stop is not the header's shape or a constraint.
    const before = await child.gatedHeader(f.childWorkId);
    expect(await lineageOf(before)).toEqual([
      expect.objectContaining({ state: 'pending', workUnitId: f.childWorkId }),
    ]);
    await controlAgentRun(app.db, a.owner, { agentRunId: f.childRunId, kind: 'stop' });
    // After the stop, the same header is refused by the stop-aware output guard itself (0525: a run
    // with a 'stop' control is not a writer), not by the application's run admission, which is skipped.
    expect(await refusalOf(child.gatedHeader(f.childWorkId, { admitted: false }))).toEqual({
      code: 'EN119',
      message: 'RUN_OUTPUT_AUTHORITY_UNBOUND',
    });
    // And through the admitted path it is refused too, whichever gate comes first.
    expect(await refusalOf(child.gatedHeader(f.childWorkId))).not.toBeNull();
  });
});
