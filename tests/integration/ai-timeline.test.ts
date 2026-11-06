// AGENT-06, Journey B. Starting, steering and reading a run, as the real roles, with two tenants of the
// same name. Needs the role provisioning step in ADR-028. Written and typechecked. It has not been run yet.
import { randomUUID } from 'node:crypto';
import {
  AppError,
  addDependency,
  auditRefusal,
  createWorkUnit,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import {
  controlAgentRun,
  listRunnableAgents,
  startAgentRun,
} from '@ensemus/application/ai-run-control';
import {
  getAgentRun,
  getRunTimeline,
  listRunsForWork,
  listRunSteps,
} from '@ensemus/application/ai-timeline';
import { claimQueuedRun } from '@ensemus/application/ai-runs';
import {
  agentPublications,
  agentRuns,
  executionSteps,
  openAppDatabase,
  rateCards,
  resolveTenantContext,
  runControls,
  serviceIdentities,
  stepPayloads,
  usageLedger,
  withTenantTx,
  workUnits,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { withRunLookupTx } from '@ensemus/database/agent';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdsCanary, tenantCanary } from '../helpers/ai/canaries';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedOrganizationBudget,
  sha256Of,
  testAgentSpec,
  thisPeriod,
  type AiTenant,
  type SeededAgentVersion,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

const refusedWith = (code: string, promise: Promise<unknown>) =>
  expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof AppError && error.code === code,
  );

describe('starting, steering and reading a run, as the real roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let su: pg.Client;
  let a: AiTenant;
  let b: AiTenant;
  let versionA: SeededAgentVersion;
  let versionB: SeededAgentVersion;

  const publish = (context: TenantContext, version: SeededAgentVersion) =>
    withTenantTx(app.db, context, (tx) =>
      tx.insert(agentPublications).values({
        organizationId: context.organizationId,
        definitionId: version.definitionId,
        versionId: version.versionId,
      }),
    );

  /** A version, published, with a model and a budget: everything the early check looks for. */
  const prepared = async (tenant: AiTenant, spec = testAgentSpec()) => {
    const version = await seedAgentVersion(app.db, tenant.owner, spec);
    await publish(tenant.owner, version);
    await seedActiveProfile(app.db, agent.db, tenant.owner);
    await seedOrganizationBudget(app.db, tenant.owner, 1_000_000);
    return version;
  };

  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 4 });
    agent = openAgentTestDatabase();
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
    versionA = await prepared(a);
    versionB = await prepared(b);
  });

  afterAll(async () => {
    await su.end();
    await app.close();
    await agent.close();
  });

  const work = async (
    tenant: AiTenant,
    classification: 'public' | 'internal' | 'confidential' | 'restricted' = 'internal',
  ) =>
    (
      await createWorkUnit(app.db, tenant.owner, {
        title: 'Same title in both',
        objective: 'Do it.',
        classification,
      })
    ).id;

  const start = (tenant: AiTenant, workUnitId: string, version = versionA) =>
    startAgentRun(app.db, tenant.owner, {
      work_unit_id: workUnitId,
      agent_version_id: version.versionId,
    });

  /** Moves a run the way a worker does, as the agent role, through the real state machine. */
  const moveRun = (tenant: AiTenant, runId: string, ...to: string[]) =>
    withRunLookupTx(agent.db, tenant.organizationId, async (tx) => {
      for (const status of to) {
        await tx.update(agentRuns).set({ status }).where(eq(agentRuns.id, runId));
      }
    });

  const eventsFor = async (aggregateId: string, eventType: string) =>
    (
      await su.query(
        `select e.id, e.payload, e.classification, o.event_id as queued
           from platform.domain_events e
           left join platform.outbox_events o
             on o.event_id = e.id and o.organization_id = e.organization_id
          where e.aggregate_id = $1 and e.event_type = $2`,
        [aggregateId, eventType],
      )
    ).rows;

  const controlsOf = (tenant: AiTenant, runId: string) =>
    withTenantTx(app.db, tenant.owner, (tx) =>
      tx.select().from(runControls).where(eq(runControls.runId, runId)),
    );

  describe('starting', () => {
    it('accepts queued work and prepares it only when the real agent role claims it', async () => {
      const workUnitId = await work(a);
      const view = await start(a, workUnitId);
      const [preparedWork] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(workUnits).where(eq(workUnits.id, workUnitId)),
      );
      expect(preparedWork?.status).toBe('queued');
      const temporalRunId = randomUUID();
      const claimed = await claimQueuedRun(agent.db, {
        organizationId: a.organizationId,
        workUnitId,
        temporalRunId,
      });
      expect(claimed).not.toBeNull();
      expect(await getAgentRun(app.db, a.owner, view.id)).toMatchObject({ status: 'preparing' });
    });

    it('does not bypass unfinished prerequisites when preparing queued work', async () => {
      const workUnitId = await work(a);
      const prerequisiteId = await work(a);
      await addDependency(app.db, a.owner, { dependentId: workUnitId, prerequisiteId });
      await refusedWith('PREREQUISITES_INCOMPLETE', start(a, workUnitId));
      expect(await listRunsForWork(app.db, a.owner, workUnitId)).toEqual([]);
      expect(await eventsFor(workUnitId, 'agent_run.requested')).toEqual([]);
      const [unchanged] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(workUnits).where(eq(workUnits.id, workUnitId)),
      );
      expect(unchanged?.status).toBe('queued');
    });

    it('commits the run, its outbox event and its audit row, with terms from the version', async () => {
      const workUnitId = await work(a, 'confidential');
      const view = await start(a, workUnitId);

      expect(view.status).toBe('queued');
      expect(view.effective_classification).toBe('confidential');
      expect(view.cost_micros).toBe(0);
      expect(view.cost_is_estimate).toBe(true);

      const [row] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(agentRuns).where(eq(agentRuns.id, view.id)),
      );
      expect(row).toMatchObject({
        initiatorMembershipId: a.owner.membershipId,
        serviceIdentityId: versionA.serviceIdentityId,
        maxModelTurns: 5,
        maxToolCalls: 5,
        maxTotalTokens: 10_000,
        maxCostMicros: 1_000_000,
        timeoutSeconds: 60,
        maxDelegationDepth: 0,
      });
      expect(row?.delegatedScopes).toEqual({
        tools: ['work.read', 'artifact.read_text', 'artifact.draft.create'],
      });

      const events = await eventsFor(workUnitId, 'agent_run.requested');
      expect(events).toHaveLength(1);
      expect(events[0].queued).toBeTruthy();
      // Identifiers only: the dispatcher reads none of this, and events travel further than documents.
      expect(events[0].payload).toEqual({ agent_run_id: view.id, work_unit_id: workUnitId });
      expect(events[0].classification).toBe('confidential');

      const { rows: audit } = await su.query(
        `select action from governance.audit_events where target_ref = $1`,
        [`agent_run:${view.id}`],
      );
      expect(audit).toEqual([{ action: 'agent_run.requested' }]);
    });

    it('leaves neither a run nor an event when the transaction fails at the end', async () => {
      const workUnitId = await work(a);
      const failing = {
        transaction(bindings: Record<string, string>, fn: (tx: never) => Promise<unknown>) {
          return app.db.transaction(bindings, async (tx) => {
            await fn(tx as never);
            throw new Error('The commit did not happen');
          });
        },
      } as unknown as AppDatabase;
      await expect(
        startAgentRun(failing, a.owner, {
          work_unit_id: workUnitId,
          agent_version_id: versionA.versionId,
        }),
      ).rejects.toThrow('The commit did not happen');
      expect(await listRunsForWork(app.db, a.owner, workUnitId)).toEqual([]);
      expect(await eventsFor(workUnitId, 'agent_run.requested')).toEqual([]);
    });

    it('refuses a second live run on one Work Unit', async () => {
      const workUnitId = await work(a);
      await start(a, workUnitId);
      await refusedWith('AGENT_RUN_ACTIVE', start(a, workUnitId));
    });

    it('lets one of two simultaneous starts win', async () => {
      const workUnitId = await work(a);
      const results = await Promise.allSettled([start(a, workUnitId), start(a, workUnitId)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((result) => result.status === 'rejected');
      expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: 'AGENT_RUN_ACTIVE' });
      expect(await eventsFor(workUnitId, 'agent_run.requested')).toHaveLength(1);
    });

    it('allows a new run once the last has ended, and the failed one stays failed', async () => {
      const workUnitId = await work(a);
      const first = await start(a, workUnitId);
      await moveRun(a, first.id, 'failed');
      const second = await start(a, workUnitId);
      expect(second.id).not.toBe(first.id);
      expect((await getAgentRun(app.db, a.owner, first.id)).status).toBe('failed');
    });

    it('refuses a member, who has no agent.run, on work they can read', async () => {
      await refusedWith(
        'FORBIDDEN',
        startAgentRun(app.db, a.member, {
          work_unit_id: await work(a),
          agent_version_id: versionA.versionId,
        }),
      );
    });

    it('reports work someone may not read as not found, whatever their role', async () => {
      const hidden = await work(a, 'restricted');
      await refusedWith(
        'NOT_FOUND',
        startAgentRun(app.db, a.member, {
          work_unit_id: hidden,
          agent_version_id: versionA.versionId,
        }),
      );
    });

    it('reports another tenant’s work as not found', async () => {
      await refusedWith('NOT_FOUND', start(a, await work(b), versionA));
    });

    it('refuses another tenant’s version, and the audit log says what it was', async () => {
      const error = await start(a, await work(a), versionB).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_INPUT');
      expect(isAuditedRefusal(error)).toBe(true);
      expect(refusalCode(error as AppError)).toBe('FOREIGN_REFERENCE');
    });

    it('refuses a version whose publication has ended', async () => {
      const spec = testAgentSpec({ id: 'retired-agent' });
      const version = await seedAgentVersion(app.db, a.owner, spec);
      await publish(a.owner, version);
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .update(agentPublications)
          .set({ activeUntil: new Date() })
          .where(
            and(
              eq(agentPublications.versionId, version.versionId),
              isNull(agentPublications.activeUntil),
            ),
          ),
      );
      await refusedWith('INVALID_STATE', start(a, await work(a), version));
      const offered = await listRunnableAgents(app.db, a.owner);
      expect(offered.map((agentRow) => agentRow.versionId)).not.toContain(version.versionId);
    });

    it('refuses a version that was never published', async () => {
      const version = await seedAgentVersion(app.db, a.owner);
      await refusedWith('INVALID_STATE', start(a, await work(a), version));
    });

    it('refuses an agent whose identity has been disabled', async () => {
      const version = await seedAgentVersion(app.db, a.owner);
      await publish(a.owner, version);
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .update(serviceIdentities)
          .set({ status: 'disabled' })
          .where(eq(serviceIdentities.id, version.serviceIdentityId)),
      );
      await refusedWith('INVALID_STATE', start(a, await work(a), version));
    });

    it('says early when no model is active, and when no budget applies', async () => {
      const bare = await seedAiTenant(app.db);
      const version = await seedAgentVersion(app.db, bare.owner);
      await publish(bare.owner, version);
      const workUnitId = await work(bare);
      await refusedWith('MODEL_PROFILE_NOT_ACTIVE', start(bare, workUnitId, version));
      await seedActiveProfile(app.db, agent.db, bare.owner);
      await refusedWith('BUDGET_NOT_CONFIGURED', start(bare, workUnitId, version));
      // Neither refusal left a thing behind.
      expect(await listRunsForWork(app.db, bare.owner, workUnitId)).toEqual([]);
    });

    it('refuses work a plan has already been asked to run', async () => {
      const workUnitId = await work(a);
      await su.query(
        `update work.work_units set execution_plan = 'checklist', run_requested_at = now()
          where id = $1`,
        [workUnitId],
      );
      await refusedWith('RUN_ALREADY_REQUESTED', start(a, workUnitId));
    });

    it('refuses work that has finished', async () => {
      const workUnitId = await work(a);
      await su.query(`update work.work_units set status = 'cancelled' where id = $1`, [workUnitId]);
      await refusedWith('INVALID_STATE', start(a, workUnitId));
    });

    it('offers a member no list of agents', async () => {
      await refusedWith('FORBIDDEN', listRunnableAgents(app.db, a.member));
    });
  });

  describe('steering', () => {
    const running = async (tenant: AiTenant = a, version = versionA) => {
      const workUnitId = await work(tenant);
      const view = await start(tenant, workUnitId, version);
      await moveRun(tenant, view.id, 'preparing', 'running');
      return { workUnitId, runId: view.id };
    };

    /** A second owner or admin, or a member, with their context read afresh. */
    const withRole = async (tenant: AiTenant, context: TenantContext, role: string) => {
      await su.query(`update org.memberships set role = $2 where id = $1`, [
        context.membershipId,
        role,
      ]);
      return resolveTenantContext(app.db, context.userId, tenant.organizationId);
    };

    it('commits a stop and its event together, and changes nothing about the run itself', async () => {
      const { workUnitId, runId } = await running();
      await controlAgentRun(app.db, a.owner, { agentRunId: runId, kind: 'stop' });
      const rows = await controlsOf(a, runId);
      expect(rows).toMatchObject([{ kind: 'stop', byMembershipId: a.owner.membershipId }]);
      const events = await eventsFor(workUnitId, 'agent_run.control_requested');
      expect(events).toHaveLength(1);
      expect(events[0].queued).toBeTruthy();
      expect(events[0].payload).toEqual({ agent_run_id: runId, kind: 'stop' });
      // The worker ends the run. Web's role could not do it even if this code tried.
      expect((await getAgentRun(app.db, a.owner, runId)).status).toBe('running');
    });

    it('records a repeated stop once', async () => {
      const { workUnitId, runId } = await running();
      await controlAgentRun(app.db, a.owner, { agentRunId: runId, kind: 'stop' });
      await controlAgentRun(app.db, a.owner, { agentRunId: runId, kind: 'stop' });
      expect(await controlsOf(a, runId)).toHaveLength(1);
      expect(await eventsFor(workUnitId, 'agent_run.control_requested')).toHaveLength(1);
    });

    it('does not let a pause overtake a stop', async () => {
      const { runId } = await running();
      await controlAgentRun(app.db, a.owner, { agentRunId: runId, kind: 'stop' });
      await refusedWith(
        'INVALID_STATE',
        controlAgentRun(app.db, a.owner, { agentRunId: runId, kind: 'pause' }),
      );
    });

    it('keeps two people’s controls in the order they were decided', async () => {
      const { runId } = await running();
      await Promise.all([
        controlAgentRun(app.db, a.owner, { agentRunId: runId, kind: 'pause' }),
        controlAgentRun(app.db, a.owner, { agentRunId: runId, kind: 'stop' }),
      ]).catch(() => undefined);
      const rows = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(runControls).where(eq(runControls.runId, runId)),
      );
      const times = rows.map((row) => row.createdAt.getTime());
      expect(new Set(times).size).toBe(times.length);
      // Whatever came first, a stop is on record and nothing came after it.
      const last = [...rows].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).at(-1);
      expect(last?.kind).toBe('stop');
    });

    it('refuses a finished run', async () => {
      const { runId } = await running();
      await moveRun(a, runId, 'failed');
      for (const kind of ['stop', 'pause', 'resume'] as const) {
        await refusedWith(
          'AGENT_RUN_NOT_CONTROLLABLE',
          controlAgentRun(app.db, a.owner, { agentRunId: runId, kind }),
        );
      }
    });

    it('refuses a member who did not start it, and that refusal goes on the record', async () => {
      const { runId } = await running();
      const error = await controlAgentRun(app.db, a.member, {
        agentRunId: runId,
        kind: 'stop',
      }).catch((caught: unknown) => caught);
      expect((error as AppError).code).toBe('FORBIDDEN');
      expect(isAuditedRefusal(error)).toBe(true);
      await auditRefusal(app.db, a.member, {
        code: refusalCode(error as AppError),
        surface: 'web',
      });
      const { rows } = await su.query(
        `select safe_reason, decision from governance.audit_events
          where actor_id = $1 and decision = 'deny'`,
        [a.member.membershipId],
      );
      expect(rows).toContainEqual({ safe_reason: 'FORBIDDEN', decision: 'deny' });
      expect(await controlsOf(a, runId)).toEqual([]);
    });

    it('lets an admin with the capability stop someone else’s run', async () => {
      const tenant = await seedAiTenant(app.db);
      const version = await prepared(tenant);
      const { runId } = await running(tenant, version);
      const admin = await withRole(tenant, tenant.member, 'admin');
      await controlAgentRun(app.db, admin, { agentRunId: runId, kind: 'stop' });
      expect(await controlsOf(tenant, runId)).toHaveLength(1);
    });

    it('lets someone who has lost their role stop their own run, and not resume it', async () => {
      const tenant = await seedAiTenant(app.db);
      const version = await prepared(tenant);
      const admin = await withRole(tenant, tenant.member, 'admin');
      const workUnitId = await work(tenant);
      const view = await startAgentRun(app.db, admin, {
        work_unit_id: workUnitId,
        agent_version_id: version.versionId,
      });
      await moveRun(tenant, view.id, 'preparing', 'running');
      const demoted = await withRole(tenant, tenant.member, 'member');
      await controlAgentRun(app.db, demoted, { agentRunId: view.id, kind: 'pause' });
      await refusedWith(
        'FORBIDDEN',
        controlAgentRun(app.db, demoted, { agentRunId: view.id, kind: 'resume' }),
      );
      await controlAgentRun(app.db, demoted, { agentRunId: view.id, kind: 'stop' });
    });

    it('reports a run on work someone may not read as not found', async () => {
      const workUnitId = await work(a, 'restricted');
      const view = await start(a, workUnitId);
      await refusedWith(
        'NOT_FOUND',
        controlAgentRun(app.db, a.member, { agentRunId: view.id, kind: 'stop' }),
      );
    });

    it('reports another tenant’s run as not found, and writes nothing', async () => {
      const { runId } = await running();
      await refusedWith(
        'NOT_FOUND',
        controlAgentRun(app.db, b.owner, { agentRunId: runId, kind: 'stop' }),
      );
      expect(await controlsOf(a, runId)).toEqual([]);
    });
  });

  describe('reading', () => {
    /** A run with a step, whose payload holds a canary only the agent role can read. */
    const runWithPayload = async (tenant: AiTenant, version: SeededAgentVersion) => {
      const canary = tenantCanary();
      const workUnitId = await work(tenant);
      const view = await start(tenant, workUnitId, version);
      await moveRun(tenant, view.id, 'preparing', 'running');
      const stepId = randomUUID();
      const context = await prepareRunInputContext(agent.db, tenant.organizationId, view.id);
      await withTenantTx(agent.db, context, async (tx) => {
        await tx.insert(executionSteps).values({
          organizationId: tenant.organizationId,
          id: stepId,
          runId: view.id,
          stepNumber: 0,
          kind: 'model_turn',
          state: 'completed',
          labelCode: 'THINKING',
          outcome: 'tool_proposed',
        });
        for (const kind of ['prompt', 'completion'] as const) {
          await tx.insert(stepPayloads).values({
            organizationId: tenant.organizationId,
            stepId,
            kind,
            classification: 'internal',
            content: `The model says ${canary}`,
            contentSha256: sha256Of(canary),
          });
        }
      });
      return { workUnitId, runId: view.id, canary };
    };

    it('shows codes and counters, and no surface holds the model’s words', async () => {
      const { workUnitId, runId, canary } = await runWithPayload(a, versionA);
      const answers = await Promise.all([
        getAgentRun(app.db, a.owner, runId),
        listRunSteps(app.db, a.owner, runId),
        listRunsForWork(app.db, a.owner, workUnitId),
        getRunTimeline(app.db, a.owner, workUnitId),
      ]);
      const everything = JSON.stringify(answers);
      expect(holdsCanary(everything, canary)).toBe(false);
      const steps = answers[1];
      expect(steps).toMatchObject([
        { step_number: 0, kind: 'model_turn', label_code: 'THINKING', outcome: 'tool_proposed' },
      ]);
    });

    it('cannot read the payload under web’s role, even by asking directly', async () => {
      await runWithPayload(a, versionA);
      await expect(
        withTenantTx(app.db, a.owner, (tx) => tx.select().from(stepPayloads)),
      ).rejects.toThrow();
    });

    it('reports a run as not found to a member who may not read its work', async () => {
      const workUnitId = await work(a, 'restricted');
      const view = await start(a, workUnitId);
      await refusedWith('NOT_FOUND', getAgentRun(app.db, a.member, view.id));
      await refusedWith('NOT_FOUND', listRunSteps(app.db, a.member, view.id));
      await refusedWith('NOT_FOUND', listRunsForWork(app.db, a.member, workUnitId));
      await refusedWith('NOT_FOUND', getRunTimeline(app.db, a.member, workUnitId));
    });

    it('stops showing a run the moment access to its work is lost', async () => {
      const workUnitId = await work(a);
      const view = await start(a, workUnitId);
      await expect(getAgentRun(app.db, a.member, view.id)).resolves.toBeTruthy();
      await su.query(`update work.work_units set classification = 'restricted' where id = $1`, [
        workUnitId,
      ]);
      await refusedWith('NOT_FOUND', getAgentRun(app.db, a.member, view.id));
    });

    it('reports another tenant’s run as not found on every read', async () => {
      const { workUnitId, runId } = await runWithPayload(a, versionA);
      await refusedWith('NOT_FOUND', getAgentRun(app.db, b.owner, runId));
      await refusedWith('NOT_FOUND', listRunSteps(app.db, b.owner, runId));
      await refusedWith('NOT_FOUND', listRunsForWork(app.db, b.owner, workUnitId));
      await refusedWith('NOT_FOUND', getRunTimeline(app.db, b.owner, workUnitId));
    });

    it('does not show a run through a Work Unit it is not on', async () => {
      const { runId } = await runWithPayload(a, versionA);
      await refusedWith('NOT_FOUND', getRunTimeline(app.db, a.owner, await work(a), { runId }));
    });

    it('gives the true state from another connection, as another replica would', async () => {
      const { runId } = await runWithPayload(a, versionA);
      const replica = openAppDatabase(urls.app(), { max: 1 });
      try {
        expect((await getAgentRun(replica.db, a.owner, runId)).status).toBe('running');
        await moveRun(a, runId, 'paused');
        expect((await getAgentRun(replica.db, a.owner, runId)).status).toBe('paused');
        expect((await getAgentRun(app.db, a.owner, runId)).status).toBe('paused');
      } finally {
        await replica.close();
      }
    });

    it('reports an unverified outcome as that, with its code', async () => {
      const { runId } = await runWithPayload(a, versionA);
      await withRunLookupTx(agent.db, a.organizationId, (tx) =>
        tx
          .update(agentRuns)
          .set({ status: 'outcome_unverified', stopCode: 'UNKNOWN_EXTERNAL_STATE' })
          .where(eq(agentRuns.id, runId)),
      );
      const view = await getAgentRun(app.db, a.owner, runId);
      expect(view.status).toBe('outcome_unverified');
      expect(view.stop_code).toBe('UNKNOWN_EXTERNAL_STATE');
      expect(view.ended_at).not.toBeNull();
    });

    it('shows steps oldest first, and a run’s latest control', async () => {
      const { workUnitId, runId } = await runWithPayload(a, versionA);
      const context = await prepareRunInputContext(agent.db, a.organizationId, runId);
      await withTenantTx(agent.db, context, (tx) =>
        tx.insert(executionSteps).values({
          organizationId: a.organizationId,
          runId,
          stepNumber: 1,
          kind: 'tool_call',
          state: 'in_flight',
          labelCode: 'READING_WORK',
        }),
      );
      await controlAgentRun(app.db, a.owner, { agentRunId: runId, kind: 'pause' });
      const timeline = await getRunTimeline(app.db, a.owner, workUnitId);
      expect(timeline.steps.map((step) => step.step_number)).toEqual([0, 1]);
      expect(timeline.latestControl).toBe('pause');
      expect(timeline.selected?.view.id).toBe(runId);
      expect(timeline.selected?.agentName).toBe('Work brief');
      expect(timeline.canChangeWork).toBe(true);
    });

    it('has nothing selected for work no agent has run on', async () => {
      const timeline = await getRunTimeline(app.db, a.owner, await work(a));
      expect(timeline.selected).toBeNull();
      expect(timeline.runs).toEqual([]);
      expect(timeline.steps).toEqual([]);
    });

    describe('what a cost is called', () => {
      const ledgerRow = (
        tenant: AiTenant,
        workUnitId: string,
        runId: string,
        overrides: Partial<typeof usageLedger.$inferInsert>,
      ) =>
        withRunLookupTx(agent.db, tenant.organizationId, (tx) =>
          tx.insert(usageLedger).values({
            organizationId: tenant.organizationId,
            idempotencyKey: `test:${randomUUID()}`,
            meter: 'model_input_tokens',
            quantity: 100,
            unit: 'token',
            costMicros: 500,
            billingPeriod: thisPeriod(),
            commercialMode: 'byom',
            workUnitId,
            runId,
            status: 'final',
            billable: false,
            ...overrides,
          }),
        );

      const card = async (tenant: AiTenant, profileId: string, source: string) => {
        const id = randomUUID();
        await withTenantTx(app.db, tenant.owner, (tx) =>
          tx.insert(rateCards).values({
            organizationId: tenant.organizationId,
            id,
            profileId,
            version: Math.floor(Math.random() * 1_000_000) + 1,
            inputMicrosPerMtok: 1,
            outputMicrosPerMtok: 1,
            source,
          }),
        );
        return id;
      };

      it('calls it an estimate in BYOM, even with an Ensemus card on the entry', async () => {
        const { workUnitId, runId } = await runWithPayload(a, versionA);
        const profileId = await seedActiveProfile(app.db, agent.db, a.owner);
        await ledgerRow(a, workUnitId, runId, {
          rateCardId: await card(a, profileId, 'ensemus_card'),
        });
        expect((await getAgentRun(app.db, a.owner, runId)).cost_is_estimate).toBe(true);
      });

      it('calls it a cost only when every entry is final and on an Ensemus card', async () => {
        const cloud = await seedAiTenant(app.db, { commercialMode: 'cloud' });
        const version = await prepared(cloud);
        const { workUnitId, runId } = await runWithPayload(cloud, version);
        const profileId = await seedActiveProfile(app.db, agent.db, cloud.owner);
        const rateCardId = await card(cloud, profileId, 'ensemus_card');
        const entry = { commercialMode: 'cloud', rateCardId, billable: true };
        await ledgerRow(cloud, workUnitId, runId, entry);
        expect((await getAgentRun(app.db, cloud.owner, runId)).cost_is_estimate).toBe(false);

        // A lost answer charged at its reserved amount makes the whole figure an estimate.
        await ledgerRow(cloud, workUnitId, runId, { ...entry, status: 'estimated' });
        expect((await getAgentRun(app.db, cloud.owner, runId)).cost_is_estimate).toBe(true);
      });

      it('does not let a free tool call count either way', async () => {
        const { workUnitId, runId } = await runWithPayload(a, versionA);
        await ledgerRow(a, workUnitId, runId, {
          meter: 'tool_call',
          unit: 'call',
          quantity: 1,
          costMicros: 0,
        });
        expect((await getAgentRun(app.db, a.owner, runId)).cost_is_estimate).toBe(true);
      });
    });
  });

  it('leaves the work itself alone: a run does not change a Work Unit’s version', async () => {
    const workUnitId = await work(a);
    const read = async () => {
      const [row] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(workUnits).where(eq(workUnits.id, workUnitId)),
      );
      return row?.version;
    };
    const before = await read();
    await start(a, workUnitId);
    expect(await read()).toBe(before);
  });
});
