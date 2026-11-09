// verifyOutput, finishRun and purgeEndedRunTranscript on the real agent role (0214, 0414, 0417, 0515).
// Synthetic text only; no provider, network or object store. Each case builds its run the way the
// runtime does: seeded queued, admitted by an actual Work read, then moved along the workflow's path.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createWorkUnit } from '@ensemus/application';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import {
  finishRun,
  purgeEndedRunTranscript,
  setRunStatus,
  storeStepPayload,
  verifyOutput,
} from '@ensemus/application/ai-runs';
import {
  agentRuns,
  executionSteps,
  openAppDatabase,
  runInputCheckpoints,
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
import { urls } from '../helpers/stack';

describe('run verification and run-end transcript erasure as actual roles', () => {
  let app: ReturnType<typeof openAppDatabase>, agent: ReturnType<typeof openAgentTestDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app(), { max: 4 });
    agent = openAgentTestDatabase(4);
  });
  afterAll(async () => {
    await Promise.all([app.close(), agent.close()]);
  });

  /** A running authority-v1 run whose Work was really read, so it holds an actual admission. */
  async function fixture() {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' }),
      work = await createWorkUnit(app.db, tenant.owner, {
        title: 'Verification target Work',
        objective: 'Synthetic verification input.',
      }),
      version = await seedAgentVersion(app.db, tenant.owner, testAgentSpec()),
      runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version });
    const context = await prepareRunInputContext(agent.db, tenant.organizationId, runId),
      service = createServiceContext(tenant.organizationId);
    await withTenantTx(agent.db, context, async (tx) => {
      await tx.update(agentRuns).set({ status: 'preparing' }).where(eq(agentRuns.id, runId));
      await tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId));
    });
    const verifications = () =>
      withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .select({ outcome: executionSteps.outcome })
          .from(executionSteps)
          .where(and(eq(executionSteps.runId, runId), eq(executionSteps.kind, 'verification'))),
      );
    const fence = () =>
      withTenantTx(agent.db, service, (tx) =>
        createRunTranscriptPurge().fenceUsing!(tx, service, { runIds: [runId] }),
      );
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
          })
          .from(runInputCheckpoints)
          .where(eq(runInputCheckpoints.runId, runId)),
      );
      return row;
    };
    return {
      ...tenant,
      work,
      runId,
      context,
      service,
      verifications,
      fence,
      payloadCount,
      checkpoint,
    };
  }

  /** A tool step and its private output, written behind the run's own admission as the runtime does. */
  async function storeToolOutput(f: Awaited<ReturnType<typeof fixture>>) {
    const stepId = randomUUID();
    await withAdmittedRunTx(agent.db, f.context, (tx) =>
      tx.insert(executionSteps).values({
        organizationId: f.organizationId,
        id: stepId,
        runId: f.runId,
        stepNumber: 1,
        kind: 'tool_call',
        state: 'in_flight',
        labelCode: 'DRAFTING_ARTIFACT',
      }),
    );
    await storeStepPayload(agent.db, f.context, {
      stepId,
      kind: 'tool_output',
      classification: 'internal',
      content: 'Synthetic private tool output',
    });
  }

  it('verifies an admitted authority-v1 run once, behind its own admission (0414, 0417)', async () => {
    const f = await fixture();
    await setRunStatus(agent.db, f.context, { agentRunId: f.runId, status: 'verifying' });
    // No final answer was ever stored, so the honest verdict is unverified. What matters is that the
    // step is written at all: 0417's authority_step_write refuses a step INSERT from an unadmitted
    // agent transaction, which is what verifyOutput used to be.
    expect(await verifyOutput(agent.db, f.context, { agentRunId: f.runId })).toBe(
      'outcome_unverified',
    );
    expect(await f.verifications()).toEqual([{ outcome: 'outcome_unverified' }]);
    // A retry answers from the step it wrote, and writes no second one.
    expect(await verifyOutput(agent.db, f.context, { agentRunId: f.runId })).toBe(
      'outcome_unverified',
    );
    expect(await f.verifications()).toEqual([{ outcome: 'outcome_unverified' }]);
  });

  it('refuses to verify a run whose inputs were fenced, and writes no step', async () => {
    const f = await fixture();
    await setRunStatus(agent.db, f.context, { agentRunId: f.runId, status: 'verifying' });
    await f.fence();
    await expect(verifyOutput(agent.db, f.context, { agentRunId: f.runId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await f.verifications()).toEqual([]);
  });

  it('refuses to verify another run on the strength of its own admission', async () => {
    const f = await fixture(),
      other = await fixture();
    await setRunStatus(agent.db, other.context, { agentRunId: other.runId, status: 'verifying' });
    await expect(
      verifyOutput(agent.db, f.context, { agentRunId: other.runId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await other.verifications()).toEqual([]);
  });

  it('refuses to replay an earlier verdict once the run is fenced, and adds nothing to it', async () => {
    const f = await fixture();
    await setRunStatus(agent.db, f.context, { agentRunId: f.runId, status: 'verifying' });
    await verifyOutput(agent.db, f.context, { agentRunId: f.runId });
    await f.fence();
    // The earlier verdict is a read of the run's steps, so it needs the same admission as the first.
    await expect(verifyOutput(agent.db, f.context, { agentRunId: f.runId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await f.verifications()).toEqual([{ outcome: 'outcome_unverified' }]);
  });

  const fail = (f: Awaited<ReturnType<typeof fixture>>) =>
    finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'failed',
      stopCode: 'MODEL_UNAVAILABLE',
    });

  it('erases an ended run’s transcript through the native service purge, and records it (FD-5, 0515)', async () => {
    const f = await fixture();
    await storeToolOutput(f);
    expect(await f.payloadCount()).toBe(1);
    await fail(f);
    // The initiator's agent transaction can neither see an authority-v1 run's payloads (0417) nor
    // delete one (0515), which is why finishRun left every transcript behind (the stack canary's tool
    // arguments). It no longer tries; the run's end leaves the transcript to this purge.
    expect(await f.payloadCount()).toBe(1);
    expect(await purgeEndedRunTranscript(agent.db, f.service, { agentRunId: f.runId })).toBe(
      'purged',
    );
    expect(await f.payloadCount()).toBe(0);
    expect(await f.checkpoint()).toEqual({
      fencedAt: expect.any(Date),
      purgedAt: expect.any(Date),
    });
    const [run] = await withTenantTx(app.db, f.owner, (tx) =>
      tx.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, f.runId)),
    );
    expect(run?.status).toBe('failed');
    // Both are safe to repeat, as an Activity retry does.
    await expect(fail(f)).resolves.toBeUndefined();
    expect(await purgeEndedRunTranscript(agent.db, f.service, { agentRunId: f.runId })).toBe(
      'purged',
    );
    expect(await f.payloadCount()).toBe(0);
  });

  it('erases nothing for a live run, nor for anyone but the service', async () => {
    const f = await fixture();
    await storeToolOutput(f);
    // A live run's transcript is its next turn's input.
    await expect(
      purgeEndedRunTranscript(agent.db, f.service, { agentRunId: f.runId }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await f.payloadCount()).toBe(1);
    await fail(f);
    // The run's own agent context is not a service, ended or not (ADR-028 FD-3).
    await expect(
      purgeEndedRunTranscript(agent.db, f.context, { agentRunId: f.runId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await f.payloadCount()).toBe(1);
    expect(await f.checkpoint()).toEqual({ fencedAt: expect.any(Date), purgedAt: null });
  });

  it('keeps an ended run’s transcript under an active legal hold, and erases it after release', async () => {
    const f = await fixture(),
      holdId = randomUUID();
    await storeToolOutput(f);
    await withTenantTx(app.db, f.owner, async (tx) => {
      await tx.execute(sql`insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
        values(${f.organizationId}::uuid,${holdId}::uuid,${randomUUID()},${f.owner.membershipId}::uuid)`);
      await tx.execute(sql`insert into lifecycle.legal_hold_scopes(organization_id,hold_id,scope_type)
        values(${f.organizationId}::uuid,${holdId}::uuid,'organization')`);
    });
    try {
      // The run still ends: a hold keeps material, it does not keep a run going.
      await fail(f);
      const [run] = await withTenantTx(app.db, f.owner, (tx) =>
        tx.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, f.runId)),
      );
      expect(run?.status).toBe('failed');
      // 0515's barrier refuses the DELETE, so the purge answers 'held', not an error the worker would
      // retry for as long as the hold lasts, and the transcript and its unpurged checkpoint remain.
      expect(await purgeEndedRunTranscript(agent.db, f.service, { agentRunId: f.runId })).toBe(
        'held',
      );
      expect(await f.payloadCount()).toBe(1);
      expect(await f.checkpoint()).toEqual({ fencedAt: expect.any(Date), purgedAt: null });
    } finally {
      await withTenantTx(app.db, f.owner, (tx) =>
        tx.execute(sql`update lifecycle.legal_holds set status='released',released_by_membership_id=${f.owner.membershipId}::uuid,
          released_at=now(),release_reason_code='TEST_RELEASE',version=version+1
          where organization_id=${f.organizationId}::uuid and id=${holdId}::uuid`),
      );
    }
    expect(await purgeEndedRunTranscript(agent.db, f.service, { agentRunId: f.runId })).toBe(
      'purged',
    );
    expect(await f.payloadCount()).toBe(0);
    expect(await f.checkpoint()).toEqual({
      fencedAt: expect.any(Date),
      purgedAt: expect.any(Date),
    });
  });
});
