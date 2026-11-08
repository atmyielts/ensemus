//0418 actual-role regression source. No execution evidence until the joined migration gate runs.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  memberships,
  openAppDatabase,
  withTenantTx,
  workUnits,
  approvals,
  approvalDecisions,
} from '@ensemus/database';
import { createServiceContext, createDelegatedContext } from '@ensemus/database/service';
import { processRuns, processRunSteps } from '@ensemus/database/product';
import {
  openDispatcherDatabase,
  processWakeTargets,
  type DispatchableEvent,
} from '@ensemus/database/dispatcher';
import {
  startProcessRun,
  advanceProcessRun,
  getProcessRun,
  requestStopProcessRun,
} from '@ensemus/application/process-runs';
import { createProcessDraft, updateProcessDraft } from '@ensemus/application/process-specs';
import { requestSimulation, runSimulationStep } from '@ensemus/application/simulations';
import {
  requestPublishReview,
  decidePublishReview,
  publishApproved,
} from '@ensemus/application/publish-reviews';
import { decideApproval, getApproval } from '@ensemus/application';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import {
  getWorkUnit,
  createWorkUnitInTx,
  transitionWorkUnit,
} from '../../packages/application/src/work';
import { databaseInTransaction } from '../../packages/application/src/transaction-database';
import { withProcessBirth } from '../../packages/application/src/product/process-run-authority';
import { pgCode } from '../../packages/application/src/errors';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';
import { testAgentSpec } from '../helpers/ai/fixtures';
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import { agentSpecSha256, publishAgentVersion } from '@ensemus/application/ai-agents';

describe('workflow execution has actual native intent, birth and completion authority', () => {
  let app: ReturnType<typeof openAppDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app());
  });
  afterAll(async () => {
    await app?.close();
  });
  async function fixture(mode: 'work' | 'approval' | 'agent' = 'work') {
    const { a, b } = await makeTwoTenants(app.db),
      ports = createRuntimeProductPorts(app.db);
    await proveSecondFactor(a.admin);
    let agentVersion: { definitionId: string; versionId: string } | null = null;
    if (mode === 'agent') {
      const spec = agentSpecV1Schema.parse(
        testAgentSpec({ id: 'generated-process-stop-agent', version: 1 }),
      );
      const published = await publishAgentVersion(app.db, a.admin.context, {
        spec,
        policyVersion: 'default',
        evaluationReport: {
          report_version: 1,
          spec_sha256: agentSpecSha256(spec),
          policy_version: 'default',
          suite_ref: spec.evaluation.suite_ref,
          dataset_version: 'generated-stop-race-1',
          model_label: 'scripted',
          pass_rate: 1,
          cases: 1,
          passed: true,
          scripted_model: true,
        },
      });
      agentVersion = { definitionId: published.definition_id, versionId: published.id };
    }
    let draft = await createProcessDraft(app.db, a.admin.context, {
      name: 'Generated two-person work',
      classification: 'internal',
    });
    draft = await updateProcessDraft(app.db, a.admin.context, ports, {
      draftId: draft.id,
      expectedVersion: draft.version,
      graph: {
        schemaVersion: 1,
        nodes: [
          { id: 'start', kind: 'start', label: 'Start', x: 0, y: 0 },
          {
            id: 'first',
            kind:
              mode === 'agent' ? 'agent_task' : mode === 'work' ? 'work_item' : 'human_approval',
            ...(agentVersion ? { agentDefinitionId: agentVersion.definitionId } : {}),
            ...(mode === 'approval' ? { approverRole: 'process_owner' as const } : {}),
            label: 'Check the first task',
            x: 100,
            y: 0,
          },
          {
            id: 'second',
            kind: mode === 'approval' ? 'evidence_check' : 'work_item',
            ...(mode === 'approval' ? { evidence: 'reviewer_approved' as const } : {}),
            label: 'Check the second task',
            x: 200,
            y: 0,
          },
          { id: 'end', kind: 'end', label: 'End', x: 300, y: 0 },
        ],
        edges: [
          { from: 'start', to: 'first' },
          { from: 'first', to: 'second' },
          { from: 'second', to: 'end' },
        ],
      },
    });
    const simulation = await requestSimulation(app.db, a.admin.context, {
      subject: { kind: 'process_draft', draftId: draft.id },
      scenarioKey: 'standard.process',
    });
    await runSimulationStep(app.db, createServiceContext(a.organizationId), {
      simulationId: simulation.id,
    });
    let review = await requestPublishReview(app.db, a.admin.context, {
      subjectKind: 'process_draft',
      subjectId: draft.id,
      simulationRunId: simulation.id,
    });
    const reviewer = mode === 'agent' ? a.owner : a.admin;
    if (mode === 'agent') await proveSecondFactor(reviewer);
    review = await decidePublishReview(
      app.db,
      reviewer.context,
      { sessionId: reviewer.sessionId },
      {
        reviewId: review.id,
        expectedVersion: review.version,
        decision: 'approved',
      },
    );
    const { publishedRef: specId } = await publishApproved(
      app.db,
      a.admin.context,
      ports,
      { sessionId: a.admin.sessionId },
      {
        reviewId: review.id,
        expectedVersion: review.version,
      },
    );
    const run = await startProcessRun(app.db, a.admin.context, {
      specId,
      title: 'Generated actual workflow',
      requestKey: randomUUID(),
    });
    return {
      a,
      b,
      ports,
      specId,
      run,
      agentVersion,
      service: createServiceContext(a.organizationId),
    };
  }
  const refusal = (operation: Promise<unknown>) => operation.then(() => null, pgCode);
  it('refuses delayed real M4 admission after a native stop has committed', async () => {
    const f = await fixture('agent');
    let entered!: () => void, release!: () => void;
    const atAdmission = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = {
      agentRuns: {
        ...f.ports.agentRuns,
        start: async (...args: Parameters<typeof f.ports.agentRuns.start>) => {
          entered();
          await resume;
          return f.ports.agentRuns.start(...args);
        },
      },
    };
    const advancing = advanceProcessRun(app.db, f.service, delayed, {
      runId: f.run.id,
      temporalRunId: 'generated-stop-race',
    });
    try {
      await Promise.race([
        atAdmission,
        advancing.then(async () => {
          const stopped = await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id);
          throw new Error(
            `TEST_ADMISSION_NOT_REACHED:${JSON.stringify({ status: stopped.status, code: stopped.stopCode, steps: stopped.steps.map((step) => ({ key: step.key, status: step.status, code: step.stopCode })) })}`,
          );
        }),
      ]);
      const current = await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id);
      await requestStopProcessRun(app.db, f.a.admin.context, {
        runId: f.run.id,
        expectedVersion: current.version,
      });
      const delegated = await createDelegatedContext(
        app.db,
        f.a.organizationId,
        f.a.admin.context.membershipId,
      );
      const direct = await withTenantTx(app.db, delegated, (tx) =>
        tx
          .update(processRunSteps)
          .set({ agentRunId: randomUUID(), status: 'waiting' })
          .where(and(eq(processRunSteps.runId, f.run.id), eq(processRunSteps.stepKey, 'first'))),
      ).then(
        () => null,
        (error) => error,
      );
      // The SQL guard must stop at the freshly stopped parent, before even considering a new run
      // reference. A missing/foreign run failure would not prove that independent stop predicate.
      expect(direct).toMatchObject({
        cause: { code: 'EN406', message: 'PROCESS_BIND_PARENT_CHANGED' },
      });
    } finally {
      release();
    }
    await advancing;
    const counts = await withTenantTx(app.db, f.a.admin.context, (tx) =>
      tx.execute<{ runs: number; bound: number }>(sql`select
      (select count(*)::int from ai.agent_runs a join studio.process_run_steps x on x.organization_id=a.organization_id and x.work_unit_id=a.work_unit_id where x.run_id=${f.run.id}::uuid) as runs,
      (select count(*)::int from studio.process_run_steps where run_id=${f.run.id}::uuid and agent_run_id is not null) as bound`),
    );
    expect(counts.rows[0]).toEqual({ runs: 0, bound: 0 });
  });
  it('maps only actual event headers to current process IDs without granting the dispatcher bodies', async () => {
    const f = await fixture();
    await transitionWorkUnit(app.db, f.a.admin.context, {
      id: f.run.rootWorkUnitId,
      expectedVersion: 1,
      to: 'ready',
    });
    const headers = await withTenantTx(app.db, f.a.admin.context, (tx) =>
      tx.execute<{ id: string; event_type: string }>(sql`
      select id,event_type from platform.domain_events where aggregate_type='work_unit' and aggregate_id=${f.run.rootWorkUnitId}::uuid
      and event_type in('work.created','work.transitioned')`),
    );
    const changed = headers.rows.find((header) => header.event_type === 'work.transitioned');
    const created = headers.rows.find((header) => header.event_type === 'work.created');
    if (!changed || !created) throw new Error('TEST_PROCESS_EVENT_MISSING');
    const event: DispatchableEvent = {
      organizationId: f.a.organizationId,
      eventId: changed.id,
      eventType: 'work.transitioned',
      aggregateType: 'work_unit',
      aggregateId: f.run.rootWorkUnitId,
      occurredAt: new Date(),
      attempts: 0,
    };
    const dispatcher = openDispatcherDatabase(urls.dispatcher());
    try {
      expect(await processWakeTargets(dispatcher.db, event)).toEqual([f.run.id]);
      expect(await processWakeTargets(dispatcher.db, event)).toEqual([f.run.id]);
      expect(
        await processWakeTargets(dispatcher.db, { ...event, organizationId: f.b.organizationId }),
      ).toEqual([]);
      expect(await processWakeTargets(dispatcher.db, { ...event, eventId: randomUUID() })).toEqual(
        [],
      );
      expect(
        (
          await dispatcher.db.execute(
            sql`select * from studio.process_wake_targets(${f.a.organizationId}::uuid,${created.id}::uuid)`,
          )
        ).rows,
      ).toEqual([]);
      for (const statement of [
        sql`select spec from studio.process_specs`,
        sql`select title from work.work_units`,
        sql`select payload from platform.domain_events`,
      ]) {
        await expect(dispatcher.db.execute(statement)).rejects.toThrow();
      }
      await dispatcher.db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('studio.process_wake_organization_id','previous-scope',true),set_config('studio.process_wake_event_id','previous-event',true)`,
        );
        await tx.execute(
          sql`select * from studio.process_wake_targets(${f.a.organizationId}::uuid,${changed.id}::uuid)`,
        );
        expect(
          (
            await tx.execute<{ organization: string; event: string }>(
              sql`select current_setting('studio.process_wake_organization_id',true) as organization,current_setting('studio.process_wake_event_id',true) as event`,
            )
          ).rows[0],
        ).toEqual({ organization: 'previous-scope', event: 'previous-event' });
      });
    } finally {
      await dispatcher.close();
    }
    await expect(
      withTenantTx(app.db, f.a.admin.context, (tx) =>
        tx.execute(
          sql`select * from studio.process_wake_targets(${f.a.organizationId}::uuid,${changed.id}::uuid)`,
        ),
      ),
    ).rejects.toThrow();
  });
  async function confirm(f: Awaited<ReturnType<typeof fixture>>, id: string) {
    for (let count = 0; count < 4; count++) {
      const work = await getWorkUnit(app.db, f.a.admin.context, id);
      if (work.status === 'completed') return;
      const to = (
        { queued: 'ready', ready: 'running', running: 'verifying', verifying: 'completed' } as const
      )[work.status as 'queued' | 'ready' | 'running' | 'verifying'];
      if (!to) throw new Error('TEST_UNEXPECTED_WORK_STATE');
      await transitionWorkUnit(app.db, f.a.admin.context, {
        id,
        expectedVersion: work.version,
        to,
      });
    }
  }
  it('denies foreign reads, service/delegated stop and stale-version stop', async () => {
    const f = await fixture();
    await expect(getProcessRun(app.db, f.b.owner.context, f.ports, f.run.id)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    const delegate = await createDelegatedContext(
      app.db,
      f.a.organizationId,
      f.a.admin.context.membershipId,
    );
    for (const context of [f.service, delegate])
      await expect(
        requestStopProcessRun(app.db, context, { runId: f.run.id, expectedVersion: 1 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      requestStopProcessRun(app.db, f.a.admin.context, { runId: f.run.id, expectedVersion: 9 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id)).stopCode).toBeNull();
  });
  it('rechecks actual role after demotion instead of accepting a stale administrator context', async () => {
    const f = await fixture();
    await withTenantTx(app.db, f.a.owner.context, async (tx) => {
      await tx
        .update(workUnits)
        .set({ ownerMembershipId: f.a.owner.context.membershipId })
        .where(eq(workUnits.id, f.run.rootWorkUnitId));
      await tx
        .update(memberships)
        .set({ role: 'member' })
        .where(eq(memberships.id, f.a.admin.context.membershipId));
    });
    await expect(
      requestStopProcessRun(app.db, f.a.admin.context, { runId: f.run.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('allows the actual current member who manages the root to stop it without an added MFA rule', async () => {
    const f = await fixture();
    await withTenantTx(app.db, f.a.owner.context, (tx) =>
      tx
        .update(workUnits)
        .set({ ownerMembershipId: f.a.member.context.membershipId })
        .where(eq(workUnits.id, f.run.rootWorkUnitId)),
    );
    await requestStopProcessRun(app.db, f.a.member.context, {
      runId: f.run.id,
      expectedVersion: 1,
    });
    const view = await getProcessRun(app.db, f.a.member.context, f.ports, f.run.id);
    expect(view.stopCode).toBe('STOP_REQUESTED');
    expect(view.version).toBe(2);
  });
  it('denies stop after the membership is disabled', async () => {
    const f = await fixture();
    await withTenantTx(app.db, f.a.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'disabled' })
        .where(eq(memberships.id, f.a.admin.context.membershipId)),
    );
    await expect(
      requestStopProcessRun(app.db, f.a.admin.context, { runId: f.run.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('does not adopt old Work created even earlier in the SAME genuine outer transaction', async () => {
    const f = await fixture();
    expect(
      await refusal(
        withTenantTx(app.db, f.a.admin.context, async (tx) => {
          const old = await createWorkUnitInTx(tx, f.a.admin.context, {
            title: 'Generated unrelated work',
            classification: 'internal',
          });
          await startProcessRun(databaseInTransaction(tx), f.a.admin.context, {
            specId: f.specId,
            title: 'Generated normal sibling',
          });
          await tx.insert(processRuns).values({
            organizationId: f.a.organizationId,
            id: randomUUID(),
            specId: f.specId,
            rootWorkUnitId: old.id,
            startedByMembershipId: f.a.admin.context.membershipId,
          });
        }),
      ),
    ).toBe('EN418');
  });
  it('refuses app writes to protected birth receipts and an unbound actual birth', async () => {
    const f = await fixture();
    expect(
      await refusal(
        withTenantTx(app.db, f.a.admin.context, (tx) =>
          tx.execute(sql`insert into studio.process_run_intents(organization_id,run_id,spec_id,root_work_unit_id,started_by_membership_id,spec_sha256)
   select organization_id,${randomUUID()}::uuid,spec_id,root_work_unit_id,started_by_membership_id,spec_sha256 from studio.process_run_intents where run_id=${f.run.id}::uuid`),
        ),
      ),
    ).toBe('42501');
    expect(
      await refusal(
        withTenantTx(app.db, f.a.admin.context, (tx) =>
          withProcessBirth(tx, { runId: randomUUID(), specId: f.specId }, () =>
            createWorkUnitInTx(tx, f.a.admin.context, {
              title: 'Generated orphan receipt',
              classification: 'internal',
            }),
          ),
        ),
      ),
    ).toBe('EN418');
  });
  it('restores every birth selector when a caught application effect fails', async () => {
    const f = await fixture(),
      failure = new Error('GENERATED_EFFECT_FAILURE');
    await withTenantTx(app.db, f.a.admin.context, async (tx) => {
      await expect(
        withProcessBirth(tx, { runId: randomUUID(), specId: f.specId }, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      const bindings = await tx.execute<{
        start: string;
        spec: string;
        step: string;
        key: string;
      }>(sql`select
       current_setting('app.process_start_run_id',true) as start,current_setting('app.process_start_spec_id',true) as spec,
       current_setting('app.process_step_run_id',true) as step,current_setting('app.process_step_key',true) as key`);
      expect(bindings.rows[0]).toEqual({ start: '', spec: '', step: '', key: '' });
      const ordinary = await createWorkUnitInTx(tx, f.a.admin.context, {
        title: 'Generated independent task',
        classification: 'internal',
      });
      const adopted = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from studio.process_run_intents where root_work_unit_id=${ordinary.id}::uuid`,
      );
      expect(adopted.rows[0]?.n).toBe(0);
    });
  });
  it('refuses an extra spec key and forged done before its real Work exists', async () => {
    const f = await fixture();
    expect(
      await refusal(
        withTenantTx(app.db, f.service, (tx) =>
          tx
            .insert(processRunSteps)
            .values({ organizationId: f.a.organizationId, runId: f.run.id, stepKey: 'forged' }),
        ),
      ),
    ).toBe('EN418');
    expect(
      await refusal(
        withTenantTx(app.db, f.service, (tx) =>
          tx
            .update(processRunSteps)
            .set({ status: 'done' })
            .where(eq(processRunSteps.runId, f.run.id)),
        ),
      ),
    ).toBe('EN418');
  });
  it('refuses direct completed run status with partial step inventory and no actual completion', async () => {
    const f = await fixture();
    expect(
      await refusal(
        withTenantTx(app.db, f.service, async (tx) => {
          await tx
            .update(processRuns)
            .set({ status: 'completed', version: 2, finishedAt: new Date() })
            .where(eq(processRuns.id, f.run.id));
          // An event/outbox pair alone must not turn an unperformed process into completed Work.
          const eventId = randomUUID();
          await tx.execute(sql`insert into platform.domain_events(organization_id,id,event_type,aggregate_type,aggregate_id,aggregate_version,actor_type,classification,payload)
   values(${f.a.organizationId}::uuid,${eventId}::uuid,'process_run.finished','process_run',${f.run.id}::uuid,2,'system','internal',jsonb_build_object('process_run_id',${f.run.id}::uuid,'status','completed','stop_code',null))`);
          await tx.execute(
            sql`insert into platform.outbox_events(organization_id,event_id) values(${f.a.organizationId}::uuid,${eventId}::uuid)`,
          );
        }),
      ),
    ).toBe('EN418');
    expect((await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id)).status).toBe(
      'queued',
    );
  });
  it('refuses fake completion of a real waiting step and raw Work completed without its kernel receipt', async () => {
    const f = await fixture();
    await advanceProcessRun(app.db, f.service, f.ports, {
      runId: f.run.id,
      temporalRunId: randomUUID(),
    });
    const view = await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id),
      first = view.steps.find((s) => s.key === 'first');
    if (!first?.workUnitId) throw new Error('TEST_STEP_WORK_MISSING');
    expect(
      await refusal(
        withTenantTx(app.db, f.service, (tx) =>
          tx
            .update(processRunSteps)
            .set({ status: 'done' })
            .where(eq(processRunSteps.workUnitId, first.workUnitId!)),
        ),
      ),
    ).toBe('EN418');
    const work = await getWorkUnit(app.db, f.a.admin.context, first.workUnitId);
    expect(
      await refusal(
        withTenantTx(app.db, f.service, (tx) =>
          tx
            .update(workUnits)
            .set({ status: 'completed', version: work.version + 1 })
            .where(eq(workUnits.id, work.id)),
        ),
      ),
    ).toBe('EN418');
    await transitionWorkUnit(app.db, f.a.admin.context, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    const ready = await getWorkUnit(app.db, f.a.admin.context, work.id);
    await transitionWorkUnit(app.db, f.a.admin.context, {
      id: work.id,
      expectedVersion: ready.version,
      to: 'running',
    });
    const running = await getWorkUnit(app.db, f.a.admin.context, work.id);
    await transitionWorkUnit(app.db, f.a.admin.context, {
      id: work.id,
      expectedVersion: running.version,
      to: 'verifying',
    });
    const checking = await getWorkUnit(app.db, f.a.admin.context, work.id);
    expect(
      await refusal(
        withTenantTx(app.db, f.a.admin.context, (tx) =>
          tx
            .update(workUnits)
            .set({ status: 'completed', version: checking.version + 1 })
            .where(eq(workUnits.id, work.id)),
        ),
      ),
    ).toBe('EN418');
  });
  it('cannot fabricate a process person approval or approval receipt as service', async () => {
    const f = await fixture('approval');
    await advanceProcessRun(app.db, f.service, f.ports, {
      runId: f.run.id,
      temporalRunId: 'generated-approval-workflow',
    });
    const view = await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id),
      first = view.steps.find((s) => s.key === 'first');
    if (!first?.approvalId) throw new Error('TEST_APPROVAL_MISSING');
    const shown = await getApproval(app.db, f.a.owner.context, first.approvalId);
    expect(
      await refusal(
        withTenantTx(app.db, f.service, (tx) =>
          tx
            .update(approvals)
            .set({ status: 'approved', decidedAt: new Date() })
            .where(eq(approvals.id, shown.approval.id)),
        ),
      ),
    ).toBe('EN418');
    expect(
      await refusal(
        withTenantTx(app.db, f.service, (tx) =>
          tx.insert(approvalDecisions).values({
            organizationId: f.a.organizationId,
            approvalId: shown.approval.id,
            actorMembershipId: f.a.owner.context.membershipId,
            decision: 'approve',
            actionHash: shown.approval.actionHash,
          }),
        ),
      ),
    ).toBe('EN418');
    expect((await getApproval(app.db, f.a.owner.context, first.approvalId)).approval.status).toBe(
      'pending',
    );
  });
  it('uses the exact real approval, then waits for actual task confirmation and refuses a revoked reviewer proof', async () => {
    const f = await fixture('approval');
    await advanceProcessRun(app.db, f.service, f.ports, {
      runId: f.run.id,
      temporalRunId: 'generated-approval-workflow',
    });
    let view = await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id);
    const first = view.steps.find((s) => s.key === 'first');
    if (!first?.approvalId || !first.workUnitId) throw new Error('TEST_APPROVAL_MISSING');
    const shown = await getApproval(app.db, f.a.owner.context, first.approvalId);
    await decideApproval(app.db, f.a.owner.context, {
      approvalId: first.approvalId,
      decision: 'approve',
      shownHash: shown.approval.actionHash,
    });
    await advanceProcessRun(app.db, f.service, f.ports, {
      runId: f.run.id,
      temporalRunId: 'generated-approval-workflow',
    });
    view = await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id);
    expect(view.steps.find((s) => s.key === 'first')?.stopCode).toBe('WORK_CONFIRMATION_REQUIRED');
    await confirm(f, first.workUnitId);
    await advanceProcessRun(app.db, f.service, f.ports, {
      runId: f.run.id,
      temporalRunId: 'generated-approval-workflow',
    });
    view = await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id);
    expect(view.steps.find((s) => s.key === 'first')?.status).toBe('done');
    // Raising this actual task to restricted removes the unrelated company owner's read permission.
    // An old approved status must not authorize the dependent evidence check after that loss.
    await withTenantTx(app.db, f.a.admin.context, (tx) =>
      tx
        .update(workUnits)
        .set({ classification: 'restricted' })
        .where(eq(workUnits.id, first.workUnitId!)),
    );
    expect(
      await advanceProcessRun(app.db, f.service, f.ports, {
        runId: f.run.id,
        temporalRunId: 'generated-approval-workflow',
      }),
    ).toEqual({ next: 'finished', status: 'failed' });
    view = await getProcessRun(app.db, f.a.admin.context, f.ports, f.run.id);
    expect(view.stopCode).toBe('STEP_PROOF_CHANGED');
  });
  it('one committed intent survives concurrent retries, owner-confirmed steps, root confirmation and a lost response', async () => {
    const f = await fixture(),
      requestKey = randomUUID(),
      input = { specId: f.specId, title: 'Generated retried workflow', requestKey };
    const [one, two] = await Promise.all([
      startProcessRun(app.db, f.a.admin.context, input),
      startProcessRun(app.db, f.a.admin.context, input),
    ]);
    expect(one.id).toBe(two.id);
    expect(one.rootWorkUnitId).toBe(two.rootWorkUnitId);
    expect(one.steps).toHaveLength(2);
    for (const key of ['first', 'second']) {
      await advanceProcessRun(app.db, f.service, f.ports, {
        runId: one.id,
        temporalRunId: 'generated-workflow-attempt',
      });
      const view = await getProcessRun(app.db, f.a.admin.context, f.ports, one.id),
        step = view.steps.find((s) => s.key === key);
      if (!step?.workUnitId) throw new Error('TEST_STEP_WORK_MISSING');
      expect(step.status).toBe('waiting');
      await confirm(f, step.workUnitId);
    }
    expect(
      await advanceProcessRun(app.db, f.service, f.ports, {
        runId: one.id,
        temporalRunId: 'generated-workflow-attempt',
      }),
    ).toEqual({ next: 'wait' });
    const waiting = await getProcessRun(app.db, f.a.admin.context, f.ports, one.id);
    expect(waiting.status).toBe('waiting');
    expect(waiting.stopCode).toBe('ROOT_CONFIRMATION_REQUIRED');
    expect(waiting.steps.every((s) => s.status === 'done')).toBe(true);
    await confirm(f, one.rootWorkUnitId);
    expect(
      await advanceProcessRun(app.db, f.service, f.ports, {
        runId: one.id,
        temporalRunId: 'generated-workflow-attempt',
      }),
    ).toEqual({ next: 'finished', status: 'completed' });
    const replay = await startProcessRun(app.db, f.a.admin.context, input);
    expect(replay.id).toBe(one.id);
    expect(replay.status).toBe('completed');
    const counts = await withTenantTx(app.db, f.a.admin.context, (tx) =>
      tx.execute<{ intents: number; births: number }>(sql`select
   (select count(*)::int from studio.process_run_intents where run_id=${one.id}::uuid) as intents,
   (select count(*)::int from studio.process_step_births where run_id=${one.id}::uuid) as births`),
    );
    expect(counts.rows[0]).toEqual({ intents: 1, births: 2 });
  });
});
