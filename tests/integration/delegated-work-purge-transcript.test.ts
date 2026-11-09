// The delegated Work purge's control path erases the transcript of each source consumer it ends, on
// the real app/agent roles (0214, 0419, 0515). closeRunWithoutContext no longer deletes step payloads
// (its lookup Tx is no service actor, which 0515's barrier requires), so purgeSource now erases them
// through purgeEndedRunTranscript after that end has committed (FD-5), and only then records the
// closure 0419's guard_source_run_closure requires a purged checkpoint for. Synthetic text only: no
// provider, network or object store.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createWorkUnit } from '@ensemus/application';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { storeStepPayload } from '@ensemus/application/ai-runs';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { createDelegatedWorkPurge } from '@ensemus/application/knowledge/delegated-work-purge';
import { purgeRunTranscriptsForSource, revokeSource } from '@ensemus/application/knowledge/purge';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import {
  agentRuns,
  executionSteps,
  openAppDatabase,
  runInputCheckpoints,
  sourceRunClosures,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  testAgentSpec,
  withAdmittedRunTx,
} from '../helpers/ai/fixtures';
import { seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('delegated Work purge erases the transcripts of the runs it closes (FD-5, 0419, 0515)', () => {
  let app: ReturnType<typeof openAppDatabase>, agent: ReturnType<typeof openAgentTestDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app(), { max: 4 });
    agent = openAgentTestDatabase(4);
  });
  afterAll(async () => {
    await Promise.all([app.close(), agent.close()]);
  });

  /**
   * A live run that really consumed a Knowledge source (the compiler's evidence package names it, so
   * ai.source_input_runs finds it) and holds a private tool output, then the source is revoked. Its
   * transcript has not been through the source transcript purge, so only purgeSource can erase it.
   */
  async function fixture() {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' }),
      word = `purgeclosure${randomUUID().replaceAll('-', '')}`;
    const source = await seedSearchableSource(app.db, tenant.owner, {
      passages: [`${word} is genuine compiler material.`],
      grants: [{ kind: 'organization' }],
    });
    const work = await createWorkUnit(app.db, tenant.owner, {
        title: 'Source consumer Work',
        objective: 'Synthetic delegated purge input.',
      }),
      version = await seedAgentVersion(
        app.db,
        tenant.owner,
        testAgentSpec({
          context: {
            allowed_scopes: [
              'work.read',
              'data.internal.read',
              `knowledge.${source.sourceId}.read`,
            ],
            memory_write_policy: 'none',
          },
        }),
      ),
      runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version });
    const context = await prepareRunInputContext(agent.db, tenant.organizationId, runId),
      service = createServiceContext(tenant.organizationId);
    await withTenantTx(agent.db, context, async (tx) => {
      await tx.update(agentRuns).set({ status: 'preparing' }).where(eq(agentRuns.id, runId));
      await tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId));
    });
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
        question: word,
        queryClassification: 'internal',
        workUnitId: work.id,
        runId,
        sourceIds: [source.sourceId],
        budgetTokens: 1000,
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!compiled.ok) throw new Error(`TEST_COMPILE_REFUSED:${compiled.code}`);
    const stepId = randomUUID();
    await withAdmittedRunTx(agent.db, context, (tx) =>
      tx.insert(executionSteps).values({
        organizationId: tenant.organizationId,
        id: stepId,
        runId,
        stepNumber: 1,
        kind: 'tool_call',
        state: 'in_flight',
        labelCode: 'DRAFTING_ARTIFACT',
      }),
    );
    await storeStepPayload(agent.db, context, {
      stepId,
      kind: 'tool_output',
      classification: 'internal',
      content: `Synthetic private tool output about ${word}`,
    });
    const consumers = await withTenantTx(agent.db, service, (tx) =>
      tx.execute<{ id: string }>(sql`select ai.source_input_runs(${source.sourceId}::uuid) as id`),
    );
    expect(consumers.rows.map((row) => row.id)).toContain(runId);
    await revokeSource(app.db, tenant.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Synthetic delegated purge closure.',
    });
    const payloadCount = () =>
      withTenantTx(
        agent.db,
        service,
        async (tx) =>
          (
            await tx.execute<{ count: number }>(
              sql`select count(*)::integer count from ai.step_payloads payload join ai.execution_steps step
                on step.organization_id=payload.organization_id and step.id=payload.step_id
                where step.organization_id=${tenant.organizationId}::uuid and step.run_id=${runId}::uuid`,
            )
          ).rows[0]!.count,
      );
    const checkpoint = async () => {
      const [row] = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .select({
            fencedAt: runInputCheckpoints.fencedAt,
            purgedAt: runInputCheckpoints.payloadsPurgedAt,
            fenceGeneration: runInputCheckpoints.fenceGeneration,
            purgedFenceGeneration: runInputCheckpoints.purgedFenceGeneration,
          })
          .from(runInputCheckpoints)
          .where(eq(runInputCheckpoints.runId, runId)),
      );
      return row;
    };
    const closures = () =>
      withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .select()
          .from(sourceRunClosures)
          .where(
            and(
              eq(sourceRunClosures.sourceId, source.sourceId),
              eq(sourceRunClosures.runId, runId),
            ),
          ),
      );
    const runStatus = async () => {
      const [run] = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, runId)),
      );
      return run?.status;
    };
    const works = createDelegatedWorkPurge({
      database: agent.db,
      accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
    });
    const purge = () => works.purgeSource(service, { sourceId: source.sourceId, limit: 25 });
    return {
      ...tenant,
      source,
      runId,
      service,
      payloadCount,
      checkpoint,
      closures,
      runStatus,
      purge,
    };
  }

  it('ends the consumer, erases its payloads, marks its checkpoint purged and only then records the closure', async () => {
    const f = await fixture();
    expect(await f.payloadCount()).toBe(1);
    expect(await f.checkpoint()).toMatchObject({ purgedAt: null });
    expect(await f.closures()).toEqual([]);

    expect(await f.purge()).toMatchObject({ controlsRemaining: 0, remaining: 0, unproven: 0 });
    expect(await f.runStatus()).toBe('cancelled');
    expect(await f.payloadCount()).toBe(0);
    expect(await f.checkpoint()).toEqual({
      fencedAt: expect.any(Date),
      purgedAt: expect.any(Date),
      fenceGeneration: 1,
      purgedFenceGeneration: 1,
    });
    const [witness] = await f.closures();
    expect(witness).toMatchObject({
      sourceVersion: 2,
      fenceGeneration: 1,
      terminalStatus: 'cancelled',
    });
    expect(witness?.closedAt).toBeInstanceOf(Date);

    // The production order (the source transcript purge, then this adapter) now confirms, and the
    // closure is recorded once.
    await purgeRunTranscriptsForSource(
      agent.db,
      f.service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId: f.source.sourceId },
    );
    expect(await f.purge()).toMatchObject({
      confirmed: true,
      remaining: 0,
      controlsRemaining: 0,
      unproven: 0,
    });
    expect(await f.closures()).toEqual([witness]);
  });

  it('keeps a held consumer’s payloads and records no closure, then erases and closes after release', async () => {
    const f = await fixture(),
      holdId = randomUUID();
    await withTenantTx(app.db, f.owner, async (tx) => {
      await tx.execute(sql`insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
        values(${f.organizationId}::uuid,${holdId}::uuid,${randomUUID()},${f.owner.membershipId}::uuid)`);
      await tx.execute(sql`insert into lifecycle.legal_hold_scopes(organization_id,hold_id,scope_type)
        values(${f.organizationId}::uuid,${holdId}::uuid,'organization')`);
    });
    try {
      expect(await f.purge()).toMatchObject({ confirmed: false, controlsRemaining: 1 });
      // A hold keeps material, not a run going: the consumer is ended and fenced all the same.
      expect(await f.runStatus()).toBe('cancelled');
      // 0515's barrier refused the DELETE, so purgeEndedRunTranscript answered 'held'.
      expect(await f.payloadCount()).toBe(1);
      expect(await f.checkpoint()).toMatchObject({ fencedAt: expect.any(Date), purgedAt: null });
      expect(await f.closures()).toEqual([]);
      // A retry under the same hold changes nothing either (the first wraps the cursor).
      await f.purge();
      await f.purge();
      expect(await f.payloadCount()).toBe(1);
      expect(await f.closures()).toEqual([]);
    } finally {
      await withTenantTx(app.db, f.owner, (tx) =>
        tx.execute(sql`update lifecycle.legal_holds set status='released',released_by_membership_id=${f.owner.membershipId}::uuid,
          released_at=now(),release_reason_code='TEST_RELEASE',version=version+1
          where organization_id=${f.organizationId}::uuid and id=${holdId}::uuid`),
      );
    }
    // The cursor has moved past the run, so the next cycle wraps it and the one after retries it.
    let result = await f.purge();
    if (result.controlsRemaining !== 0) result = await f.purge();
    expect(result).toMatchObject({ controlsRemaining: 0 });
    expect(await f.payloadCount()).toBe(0);
    expect(await f.checkpoint()).toMatchObject({ purgedAt: expect.any(Date) });
    expect(await f.closures()).toHaveLength(1);
  });
});
