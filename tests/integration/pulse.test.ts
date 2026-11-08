// Actual tenant roles, Work ACLs and personal-state RLS. Authored only until the joined0405 DB gate.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, assignContributor, createWorkUnit, unassign } from '@ensemus/application';
import {
  getCompanyPulse,
  getPulseSignal,
  PULSE_WORK_LIMIT,
  setPulseSignalState,
} from '@ensemus/application/pulse';
import { publishReviewedProcess } from '../helpers/studio';
import { finishProcessRun, startProcessRun } from '@ensemus/application/process-runs';
import { compileProcessGraph } from '@ensemus/domain/process-spec';
import { createPulseMetadataReaders } from '@ensemus/application/pulse-metadata';
import { agentRuns, memberships, openAppDatabase, withTenantTx } from '@ensemus/database';
import { pulseSignalStates } from '@ensemus/database/product';
import { createAgentContext, withRunLookupTx } from '@ensemus/database/agent';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import { and, eq, sql } from 'drizzle-orm';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';
import { openAgentTestDatabase, seedAgentVersion, seedQueuedRun } from '../helpers/ai/fixtures';

const readers = createPulseMetadataReaders();
const refused = (code: string, action: Promise<unknown>) =>
  expect(action).rejects.toSatisfy(
    (error: unknown) => error instanceof AppError && error.code === code,
  );

describe('Pulse fresh viewer access and own personal state', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app(), { max: 4 });
    agent = openAgentTestDatabase();
  });
  afterAll(async () => {
    await app?.close();
    await agent?.close();
  });

  async function fixture(classification: 'internal' | 'restricted' = 'internal') {
    const people = await makeTwoTenants(app.db);
    const work = await createWorkUnit(app.db, people.a.owner.context, {
      title: 'Same generated deadline',
      objective: 'Check this actual generated work.',
      classification,
      dueAt: new Date(Date.now() - 3 * 86_400_000),
    });
    const foreignWork = await createWorkUnit(app.db, people.b.owner.context, {
      title: 'Same generated deadline',
      objective: 'Check this actual generated work.',
      classification,
      dueAt: new Date(Date.now() - 3 * 86_400_000),
    });
    return {
      ...people,
      work,
      foreignWork,
      key: `work_overdue:${work.id}`,
      foreignKey: `work_overdue:${foreignWork.id}`,
    };
  }

  it('derives actual evidence-backed risk and limits all facts/counts to readable Work', async () => {
    const f = await fixture('restricted');
    const owner = await getCompanyPulse(app.db, f.a.owner.context, readers);
    expect(owner.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: f.key,
          work: { id: f.work.id, title: 'Same generated deadline' },
        }),
      ]),
    );
    const member = await getCompanyPulse(app.db, f.a.member.context, readers);
    expect(member.signals).toEqual([]);
    expect(member.summary).toMatchObject({
      openWork: 0,
      overdue: 0,
      waitingOnApproval: 0,
      needsDecision: 0,
    });
    const admin = await getCompanyPulse(app.db, f.a.admin.context, readers);
    expect(admin.signals).toEqual([]);
    expect(JSON.stringify(owner)).not.toContain(f.foreignWork.id);
    for (const key of Object.keys(owner.summary))
      expect(key).not.toMatch(/person|member|employee|score|rank/i);
  });

  it('lets a member dismiss and reopen only their own current signal, with no MFA requirement', async () => {
    const f = await fixture();
    await setPulseSignalState(app.db, f.a.member.context, readers, {
      signalKey: f.key,
      state: 'dismissed',
    });
    expect((await getCompanyPulse(app.db, f.a.member.context, readers)).signals).toEqual([]);
    expect(
      (await getCompanyPulse(app.db, f.a.member.context, readers, { includeDismissed: true }))
        .signals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: f.key, personalState: 'dismissed' })]),
    );
    expect((await getCompanyPulse(app.db, f.a.owner.context, readers)).signals).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: f.key, personalState: 'open' })]),
    );
    await setPulseSignalState(app.db, f.a.member.context, readers, {
      signalKey: f.key,
      state: 'open',
    });
    expect((await getCompanyPulse(app.db, f.a.member.context, readers)).signals).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: f.key, personalState: 'open' })]),
    );
  });

  it('requires a future snooze within 30 days and automatically treats an ended snooze as open', async () => {
    const f = await fixture();
    for (const until of [
      new Date(Date.now() - 1000),
      new Date(Date.now() + 31 * 86_400_000),
      new Date(NaN),
    ])
      await refused(
        'INVALID_INPUT',
        setPulseSignalState(app.db, f.a.member.context, readers, {
          signalKey: f.key,
          state: 'snoozed',
          until,
        }),
      );
    await setPulseSignalState(app.db, f.a.member.context, readers, {
      signalKey: f.key,
      state: 'snoozed',
      until: new Date(Date.now() + 86_400_000),
    });
    expect(
      (await getCompanyPulse(app.db, f.a.member.context, readers)).signals[0]?.personalState,
    ).toBe('snoozed');
    await withTenantTx(app.db, f.a.member.context, (tx) =>
      tx
        .update(pulseSignalStates)
        .set({ until: new Date(Date.now() - 1000) })
        .where(
          and(
            eq(pulseSignalStates.membershipId, f.a.member.context.membershipId),
            eq(pulseSignalStates.signalKey, f.key),
          ),
        ),
    );
    expect(
      (await getCompanyPulse(app.db, f.a.member.context, readers)).signals[0]?.personalState,
    ).toBe('open');
  });

  it('refuses foreign keys, a non-current risk and access lost after an earlier read', async () => {
    const f = await fixture('restricted');
    await refused(
      'NOT_FOUND',
      setPulseSignalState(app.db, f.a.owner.context, readers, {
        signalKey: f.foreignKey,
        state: 'dismissed',
      }),
    );
    await refused(
      'NOT_FOUND',
      setPulseSignalState(app.db, f.a.owner.context, readers, {
        signalKey: `work_due_soon:${f.work.id}`,
        state: 'dismissed',
      }),
    );
    await assignContributor(app.db, f.a.owner.context, {
      id: f.work.id,
      membershipId: f.a.member.context.membershipId,
    });
    expect(
      (await getCompanyPulse(app.db, f.a.member.context, readers)).signals.some(
        (signal) => signal.key === f.key,
      ),
    ).toBe(true);
    await unassign(app.db, f.a.owner.context, {
      id: f.work.id,
      membershipId: f.a.member.context.membershipId,
    });
    expect((await getCompanyPulse(app.db, f.a.member.context, readers)).summary.openWork).toBe(0);
    await refused(
      'NOT_FOUND',
      setPulseSignalState(app.db, f.a.member.context, readers, {
        signalKey: f.key,
        state: 'dismissed',
      }),
    );
  });

  it('denies delegated/service reads and state changes before any viewer impersonation', async () => {
    const f = await fixture();
    const delegated = await createDelegatedContext(
      app.db,
      f.a.organizationId,
      f.a.owner.context.membershipId,
    );
    for (const context of [delegated, createServiceContext(f.a.organizationId)]) {
      await refused('FORBIDDEN', getCompanyPulse(app.db, context, readers));
      await refused(
        'FORBIDDEN',
        setPulseSignalState(app.db, context, readers, { signalKey: f.key, state: 'dismissed' }),
      );
    }
  });

  it('refreshes a cached administrator role before counts or preference effects', async () => {
    const f = await fixture();
    const confidential = await createWorkUnit(app.db, f.a.owner.context, {
      title: 'Generated confidential deadline',
      objective: 'Private generated fact.',
      classification: 'confidential',
      dueAt: new Date(Date.now() - 3 * 86_400_000),
    });
    const key = `work_overdue:${confidential.id}`;
    expect(
      (await getCompanyPulse(app.db, f.a.admin.context, readers)).signals.some(
        (signal) => signal.key === key,
      ),
    ).toBe(true);
    await withTenantTx(app.db, f.a.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'member' })
        .where(eq(memberships.id, f.a.admin.context.membershipId)),
    );
    const refreshed = await getCompanyPulse(app.db, f.a.admin.context, readers);
    expect(refreshed.signals.some((signal) => signal.key === key)).toBe(false);
    expect(refreshed.summary.openWork).toBe(1);
    await refused(
      'NOT_FOUND',
      setPulseSignalState(app.db, f.a.admin.context, readers, {
        signalKey: key,
        state: 'dismissed',
      }),
    );
  });

  it('enforces actual per-person SQL policy for foreign, delegated and disabled callers', async () => {
    const f = await fixture();
    await setPulseSignalState(app.db, f.a.member.context, readers, {
      signalKey: f.key,
      state: 'dismissed',
    });
    const other = await withTenantTx(app.db, f.a.owner.context, (tx) =>
      tx.select().from(pulseSignalStates),
    );
    expect(other).toEqual([]);
    const delegated = await createDelegatedContext(
      app.db,
      f.a.organizationId,
      f.a.member.context.membershipId,
    );
    const direct = async (context: typeof delegated) => {
      const visible = await withTenantTx(app.db, context, (tx) =>
        tx.select().from(pulseSignalStates),
      );
      expect(visible).toEqual([]);
      expect(
        await withTenantTx(app.db, context, (tx) =>
          tx.update(pulseSignalStates).set({ state: 'dismissed', until: null }).returning(),
        ),
      ).toEqual([]);
      expect(
        await withTenantTx(app.db, context, (tx) => tx.delete(pulseSignalStates).returning()),
      ).toEqual([]);
      await expect(
        withTenantTx(app.db, context, (tx) =>
          tx.insert(pulseSignalStates).values({
            organizationId: f.a.organizationId,
            membershipId: f.a.member.context.membershipId,
            signalKey: `work_overdue:${randomUUID()}`,
            state: 'dismissed',
          }),
        ),
      ).rejects.toThrow();
    };
    await direct(delegated);
    await direct(createServiceContext(f.a.organizationId));
    await direct(f.b.owner.context);
    await withTenantTx(app.db, f.a.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'disabled' })
        .where(eq(memberships.id, f.a.member.context.membershipId)),
    );
    await direct(f.a.member.context);
    await refused('FORBIDDEN', getCompanyPulse(app.db, f.a.member.context, readers));
    const retained = await withTenantTx(app.db, f.a.owner.context, (tx) =>
      tx.execute<{ count: number }>(
        sql`select count(*)::int as count from experience.pulse_signal_states where membership_id=${f.a.member.context.membershipId}::uuid`,
      ),
    );
    expect(retained.rows[0]?.count).toBe(0); // Owner cannot inspect another person's hidden preference.
  });

  it('denies an actual agent role/context its initiating person’s preferences, even with inherited app grants', async () => {
    const f = await fixture();
    await setPulseSignalState(app.db, f.a.owner.context, readers, {
      signalKey: f.key,
      state: 'dismissed',
    });
    await proveSecondFactor(f.a.owner);
    const version = await seedAgentVersion(app.db, f.a.owner.context);
    const runId = await seedQueuedRun(app.db, f.a.owner.context, {
      workUnitId: f.work.id,
      version,
    });
    const context = await createAgentContext(agent.db, {
      organizationId: f.a.organizationId,
      initiatorMembershipId: f.a.owner.context.membershipId,
      agentRunId: runId,
    });
    expect(
      await withTenantTx(agent.db, context, (tx) => tx.select().from(pulseSignalStates)),
    ).toEqual([]);
    expect(
      await withTenantTx(agent.db, context, (tx) =>
        tx.update(pulseSignalStates).set({ state: 'dismissed', until: null }).returning(),
      ),
    ).toEqual([]);
    expect(
      await withTenantTx(agent.db, context, (tx) => tx.delete(pulseSignalStates).returning()),
    ).toEqual([]);
    await expect(
      withTenantTx(agent.db, context, (tx) =>
        tx.insert(pulseSignalStates).values({
          organizationId: f.a.organizationId,
          membershipId: f.a.owner.context.membershipId,
          signalKey: `work_overdue:${randomUUID()}`,
          state: 'dismissed',
        }),
      ),
    ).rejects.toThrow();
    await refused('FORBIDDEN', getCompanyPulse(app.db, context, readers));
  });

  it('reads real M4 stop metadata on readable company work without copying private reason text', async () => {
    const f = await fixture();
    await proveSecondFactor(f.a.owner);
    const version = await seedAgentVersion(app.db, f.a.owner.context);
    const runId = await seedQueuedRun(app.db, f.a.owner.context, {
      workUnitId: f.work.id,
      version,
    });
    await withRunLookupTx(agent.db, f.a.organizationId, (tx) =>
      tx
        .update(agentRuns)
        .set({ status: 'failed', stopCode: 'PRIVATE_PROVIDER_SENTENCE' })
        .where(eq(agentRuns.id, runId)),
    );
    const view = await getCompanyPulse(app.db, f.a.member.context, readers);
    const signal = view.signals.find((item) => item.key === `agent_run_stopped:${runId}`);
    expect(signal?.evidence[1]?.reasonCode).toBe('AGENT_RUN_STOPPED');
    expect(view.partial).not.toContain('agent_runs');
    expect(JSON.stringify(view)).not.toContain('PRIVATE_PROVIDER_SENTENCE');
  });

  it('marks unavailable metadata partial and propagates real infrastructure faults', async () => {
    const f = await fixture();
    const unavailable = {
      ...readers,
      stoppedAgentRuns: async () => {
        throw new AppError('CAPABILITY_UNAVAILABLE');
      },
    };
    const view = await getCompanyPulse(app.db, f.a.owner.context, unavailable);
    expect(view.signals.some((item) => item.key === f.key)).toBe(true);
    expect(view.partial).toContain('agent_runs');
    const outage = new Error('Synthetic database outage');
    await expect(
      getCompanyPulse(app.db, f.a.owner.context, {
        ...readers,
        stoppedAgentRuns: async () => {
          throw outage;
        },
      }),
    ).rejects.toBe(outage);
  });

  it('reads an actual failed process and provides a fresh focused source record', async () => {
    const f = await fixture();
    const graph = {
      schemaVersion: 1 as const,
      nodes: [
        { id: 'start', kind: 'start' as const, label: 'Start', x: 0, y: 0 },
        { id: 'task', kind: 'work_item' as const, label: 'Generated task', x: 1, y: 0 },
        { id: 'end', kind: 'end' as const, label: 'End', x: 2, y: 0 },
      ],
      edges: [
        { from: 'start', to: 'task' },
        { from: 'task', to: 'end' },
      ],
    };
    const compiled = compileProcessGraph(
      graph,
      {
        classification: 'internal',
        agentDefinitionIds: new Set<string>(),
        toolIds: new Set<string>(),
      },
      (body) => createHash('sha256').update(body).digest('hex'),
    );
    if (!compiled.ok) throw new Error('TEST_PROCESS_COMPILATION_REFUSED');
    const published = await publishReviewedProcess(
      app.db,
      f.a.owner.context,
      graph,
      'Generated Pulse process',
    );
    const run = await startProcessRun(app.db, f.a.owner.context, {
      specId: published.specId,
      title: 'Generated process work',
    });
    await finishProcessRun(app.db, createServiceContext(f.a.organizationId), {
      runId: run.id,
      code: 'STEP_FAILED',
    });
    const view = await getCompanyPulse(app.db, f.a.member.context, readers);
    const key = `process_run_failed:${run.id}`;
    expect(view.signals.find((signal) => signal.key === key)?.evidence[0]).toMatchObject({
      id: run.id,
      kind: 'process_run',
      reasonCode: 'STEP_FAILED',
    });
    expect(view.partial).not.toContain('process_runs');
    expect((await getPulseSignal(app.db, f.a.member.context, readers, key)).work.id).toBe(
      run.rootWorkUnitId,
    );
    await refused('NOT_FOUND', getPulseSignal(app.db, f.b.owner.context, readers, key));
  });

  it('filters private Work before its bounded overview and explicitly marks real truncation', async () => {
    const f = await fixture();
    for (let index = 0; index <= PULSE_WORK_LIMIT; index++)
      await createWorkUnit(app.db, f.a.owner.context, {
        title: `Generated hidden work ${index}`,
        objective: 'Private generated work.',
        classification: 'restricted',
        dueAt: new Date(Date.now() - 10 * 86_400_000),
      });
    const member = await getCompanyPulse(app.db, f.a.member.context, readers);
    expect(member.summary.openWork).toBe(1);
    expect(member.partial).not.toContain('work');
    expect(member.signals.some((signal) => signal.key === f.key)).toBe(true);
    const owner = await getCompanyPulse(app.db, f.a.owner.context, readers);
    expect(owner.summary.openWork).toBe(PULSE_WORK_LIMIT);
    expect(owner.partial).toContain('work');
    await setPulseSignalState(app.db, f.a.owner.context, readers, {
      signalKey: f.key,
      state: 'dismissed',
    });
    expect((await getPulseSignal(app.db, f.a.owner.context, readers, f.key)).personalState).toBe(
      'dismissed',
    );
  });
});
