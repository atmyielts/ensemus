// 0417 actual role cases. Source-only until the parent's joined fresh-PostgreSQL gate.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createClient,
  createProject,
  createWorkUnit,
  disableMember,
  failRun,
  getClientSharing,
  getWorkUnit,
  loadChangeable,
  requestApproval,
  setClientReaders,
  transitionWorkUnit,
} from '@ensemus/application';
import { createContextSource } from '@ensemus/application/ai-context-source';
import { createToolStepStore } from '@ensemus/application/ai-tool-steps';
import { currentRunInputClass } from '@ensemus/application/ai-model-admission';
import {
  claimQueuedRun,
  closeRunWithoutContext,
  createTurnStore,
  finishRun,
} from '@ensemus/application/ai-runs';
import {
  agentRuns,
  approvals,
  clientReaders,
  domainEvents,
  executionSteps,
  notifications,
  openAppDatabase,
  outboxEvents,
  projects,
  runAuthorityCheckpoints,
  runInputObservations,
  runReadAuthorities,
  withTenantTx,
  workTransitions,
  workUnits,
  type TenantContext,
} from '@ensemus/database';
import { createAgentContext } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { canonicalJson, workReviewAction } from '@ensemus/domain/approval';
import { pgCode } from '../../packages/application/src/errors';
import { loadAgentReadScopeInTx } from '../../packages/application/src/ai/read-scope';
import { makeTwoTenants, nativePersonContext, proveSecondFactor } from '../helpers/product';
import {
  openAgentTestDatabase,
  seedAgentVersion,
  seedQueuedRun,
  testAgentSpec,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

describe('actual read-time authority and rolling admission (0417)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  let people: Awaited<ReturnType<typeof makeTwoTenants>>,
    owner: TenantContext,
    admin: TenantContext;
  beforeAll(async () => {
    people = await makeTwoTenants(app.db);
    await proveSecondFactor(people.a.owner);
    await proveSecondFactor(people.a.admin);
    owner = await nativePersonContext(app.db, people.a.owner, people.a.organizationId);
    admin = await nativePersonContext(app.db, people.a.admin, people.a.organizationId);
  });
  afterAll(async () => {
    await agent.close();
    await app.close();
  });
  const source = () =>
    createContextSource({
      database: agent.db,
      readObject: async () => {
        throw new Error('TEST_UNEXPECTED_BYTES');
      },
    });
  async function fixture(projectId?: string, scopes = ['work.read'], initiator = owner) {
    const work = await createWorkUnit(app.db, initiator, {
      title: 'Read-time authority fixture',
      objective: 'Use the actual current authority.',
      classification: 'public',
      ...(projectId ? { projectId } : {}),
    });
    const version = await seedAgentVersion(
      app.db,
      initiator,
      testAgentSpec({ context: { allowed_scopes: scopes, memory_write_policy: 'none' } }),
    );
    const runId = await seedQueuedRun(app.db, initiator, {
      workUnitId: work.id,
      version,
      classification: 'public',
    });
    const context = await createAgentContext(agent.db, {
      organizationId: initiator.organizationId,
      initiatorMembershipId: initiator.membershipId,
      agentRunId: runId,
    });
    return { work, version, runId, context };
  }
  async function running(initiator = owner, scopes = ['work.read']) {
    const f = await fixture(undefined, scopes, initiator);
    await transitionWorkUnit(app.db, initiator, {
      id: f.work.id,
      expectedVersion: f.work.version,
      to: 'ready',
    });
    const temporalRunId = randomUUID();
    expect(
      await claimQueuedRun(agent.db, {
        organizationId: initiator.organizationId,
        workUnitId: f.work.id,
        temporalRunId,
      }),
    ).not.toBeNull();
    await source().loadWork(f.context, f.work.id);
    return { ...f, temporalRunId };
  }
  const toolStore = () =>
    createToolStepStore({
      database: agent.db,
      objects: { put: async () => { throw new Error('TEST_UNEXPECTED_PUT'); } },
    });
  it('remints the actual scoped tool transaction before its Work inspection and clears it at the transaction boundary', async () => {
    const f = await running(owner, ['work.read', 'data.public.read']);
    const store = toolStore();
    await store.withTx(f.context, async (tx) => {
      const before = await tx.execute<{ scope: string; authority: string }>(sql`select
        current_setting('app.agent_scope_protocol',true) scope,
        current_setting('app.agent_authority_protocol',true) authority`);
      expect(before.rows[0]).toEqual({ scope: '', authority: '' });
      expect(await store.readRun(tx, f.context, f.runId, { lock: true })).toMatchObject({
        status: 'running', inputsOpen: true, workStopped: false,
      });
      const admitted = await tx.execute<{ scope: string; authority: string }>(sql`select
        current_setting('app.agent_scope_protocol',true) scope,
        current_setting('app.agent_authority_protocol',true) authority`);
      expect(admitted.rows[0]).toEqual({
        scope: `scoped-v1:${f.runId}`, authority: `authority-v1:${f.runId}`,
      });
      expect(await tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)))
        .toEqual([{ id: f.work.id }]);
    });
    await store.withTx(f.context, async (tx) => {
      expect(await tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)))
        .toEqual([]);
    });
  });
  it('returns metadata-only tool facts after a current class exceeds its immutable ceiling, without leaving admission behind', async () => {
    const f = await running(owner, ['work.read', 'data.public.read']);
    await withTenantTx(app.db, owner, (tx) => tx.update(workUnits)
      .set({ classification: 'confidential' }).where(eq(workUnits.id, f.work.id)));
    const store = toolStore();
    await store.withTx(f.context, async (tx) => {
      expect(await store.readRun(tx, f.context, f.runId, { lock: true })).toMatchObject({
        status: 'running', inputsOpen: false, workStopped: true, allow: null, deny: null,
      });
      const state = await tx.execute<{ scope: string; authority: string }>(sql`select
        current_setting('app.agent_scope_protocol',true) scope,
        current_setting('app.agent_authority_protocol',true) authority`);
      expect(state.rows[0]).toEqual({ scope: '', authority: '' });
      expect(await tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)))
        .toEqual([]);
    });
  });
  it('keeps terminal tool reconciliation metadata-only even after an earlier admission in the same transaction', async () => {
    const f = await running(owner, ['work.read', 'data.public.read']);
    await finishRun(agent.db, f.context, { agentRunId: f.runId, status: 'cancelled', stopCode: 'STOPPED_BY_PERSON' });
    const store = toolStore();
    await store.withTx(f.context, async (tx) => {
      // A previous nested operation cannot lend its version markers to terminal reconciliation.
      await tx.execute(sql`select set_config('app.agent_scope_protocol',${`scoped-v1:${f.runId}`},true),
        set_config('app.agent_authority_protocol',${`authority-v1:${f.runId}`},true)`);
      expect(await store.readRun(tx, f.context, f.runId, { lock: true })).toMatchObject({
        status: 'cancelled', inputsOpen: false, workStopped: true, allow: null, deny: null,
      });
      const state = await tx.execute<{ scope: string; authority: string }>(sql`select
        current_setting('app.agent_scope_protocol',true) scope,
        current_setting('app.agent_authority_protocol',true) authority`);
      expect(state.rows[0]).toEqual({ scope: '', authority: '' });
      // A successful metadata result must leave this Tx usable, without exposing the terminal Work.
      expect(await tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)))
        .toEqual([]);
    });
  });
  it('propagates the actual NOWAIT lock error rather than continuing in an aborted tool transaction', async () => {
    const f = await running(owner, ['work.read', 'data.public.read']);
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const driver = withTenantTx(agent.db, f.context, async (tx) => {
      await tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, f.runId)).for('update');
      signalLocked();
      await released;
    });
    try {
      await locked;
      const store = toolStore();
      await expect(store.withTx(f.context, (tx) => store.readRun(tx, f.context, f.runId, { lock: true })))
        .rejects.toSatisfy((error: unknown) => pgCode(error) === '55P03');
    } finally {
      release();
      await driver;
    }
  });
  it('binds genuine new-run birth and refuses old unscoped Work/model-step writers before material', async () => {
    const f = await fixture();
    const [checkpoint] = await withTenantTx(app.db, owner, (tx) =>
      tx.select().from(runAuthorityCheckpoints).where(eq(runAuthorityCheckpoints.runId, f.runId)),
    );
    expect(checkpoint).toMatchObject({
      protocolVersion: 'authority-v1',
      historyComplete: true,
      workUnitId: f.work.id,
      agentVersionId: f.version.versionId,
      initiatorMembershipId: owner.membershipId,
    });
    await withTenantTx(agent.db, f.context, async (tx) => {
      expect(
        await tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)),
      ).toEqual([]);
      await expect(
        tx.transaction(async (inner) => {
          // Actual old main-runtime marker, without the new before-material authority admission.
          await inner.execute(
            sql`select set_config('app.knowledge_model_protocol','main-runtime-v1',true)`,
          );
          await inner.insert(executionSteps).values({
            organizationId: owner.organizationId,
            runId: f.runId,
            stepNumber: 1,
            kind: 'model_turn',
            state: 'in_flight',
            labelCode: 'THINKING',
          });
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    });
    expect((await source().loadWork(f.context, f.work.id)).id).toBe(f.work.id);
    expect(
      (await createTurnStore(agent.db).beginTurn(f.context, { runId: f.runId, stepNumber: 1 }))
        .kind,
    ).toBe('begin');
    const [receipt] = await withTenantTx(agent.db, f.context, (tx) =>
      tx.select().from(runReadAuthorities).where(eq(runReadAuthorities.runId, f.runId)),
    );
    expect(receipt?.authorityInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'work_unit',
          id: f.work.id,
          ownerMembershipId: owner.membershipId,
        }),
      ]),
    );
    expect(receipt?.authoritySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await withTenantTx(
        agent.db,
        f.context,
        async (tx) =>
          (
            await tx.execute<{ value: string }>(
              sql`select current_setting('app.agent_authority_protocol',true) value`,
            )
          ).rows[0]?.value,
      ),
    ).toBe('');
  });
  it('retains the exact original private parent after reparenting and refuses its later revocation under a stale native context', async () => {
    const privateClient = await createClient(app.db, admin, {
      displayName: 'Actual private parent',
      classification: 'restricted',
    });
    if (!privateClient) throw new Error('TEST_CLIENT_REFUSED');
    await setClientReaders(app.db, admin, {
      clientId: privateClient.id,
      expectedVersion: privateClient.accessVersion,
      readerMembershipIds: [owner.membershipId],
    });
    const project = await createProject(app.db, admin, {
      name: 'Actual private project',
      clientId: privateClient.id,
    });
    if (!project) throw new Error('TEST_PROJECT_REFUSED');
    const f = await fixture(project.id, ['data.restricted.read']);
    await source().loadWork(f.context, f.work.id);
    const original = await withTenantTx(agent.db, f.context, (tx) =>
      tx.select().from(runReadAuthorities).where(eq(runReadAuthorities.runId, f.runId)),
    );
    expect(original[0]?.authorityInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'client',
          id: privateClient.id,
          ownerMembershipId: admin.membershipId,
        }),
      ]),
    );
    await withTenantTx(app.db, admin, (tx) =>
      tx.update(projects).set({ clientId: null }).where(eq(projects.id, project.id)),
    );
    await source().loadWork(f.context, f.work.id);
    const reread = await withTenantTx(agent.db, f.context, (tx) =>
      tx.select().from(runReadAuthorities).where(eq(runReadAuthorities.runId, f.runId)),
    );
    expect(new Set(reread.map((row) => row.inputSha256)).size).toBe(1);
    expect(new Set(reread.map((row) => row.authoritySha256)).size).toBe(2);
    const frozen = await withTenantTx(agent.db, f.context, (tx) =>
      tx.execute<{ inventory: unknown[] }>(
        sql`select ai.current_main_input_inventory(${f.runId}::uuid) inventory`,
      ),
    );
    expect(frozen.rows[0]?.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'read_authority',
          inputKind: 'work_unit',
          id: f.work.id,
          authorityInventory: expect.arrayContaining([
            expect.objectContaining({
              kind: 'client',
              id: privateClient.id,
              ownerMembershipId: admin.membershipId,
            }),
          ]),
        }),
      ]),
    );
    const sharing = await getClientSharing(app.db, admin, privateClient.id);
    await setClientReaders(app.db, admin, {
      clientId: privateClient.id,
      expectedVersion: sharing.version,
      readerMembershipIds: [],
    });
    expect((await getWorkUnit(app.db, owner, f.work.id)).id).toBe(f.work.id);
    await expect(currentRunInputClass(agent.db, f.context)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    await expect(source().loadWork(f.context, f.work.id)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(
      (
        await withTenantTx(agent.db, f.context, (tx) =>
          tx.select().from(runReadAuthorities).where(eq(runReadAuthorities.runId, f.runId)),
        )
      ).length,
    ).toBe(2);
  });
  it('does not grant app mutation or cross-tenant metadata and cannot promote a checkpoint', async () => {
    const f = await fixture();
    await source().loadWork(f.context, f.work.id);
    expect(
      await withTenantTx(app.db, people.b.owner.context, (tx) =>
        tx.select().from(runAuthorityCheckpoints).where(eq(runAuthorityCheckpoints.runId, f.runId)),
      ),
    ).toEqual([]);
    await expect(
      withTenantTx(app.db, owner, (tx) =>
        tx.insert(runReadAuthorities).values({
          organizationId: owner.organizationId,
          runId: f.runId,
          inputKind: 'work_unit',
          inputId: f.work.id,
          inputSha256: 'a'.repeat(64),
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(agent.db, f.context, (tx) =>
        tx
          .update(runAuthorityCheckpoints)
          .set({ protocolVersion: 'legacy', historyComplete: false })
          .where(eq(runAuthorityCheckpoints.runId, f.runId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });
  it('rejects an unreceipted observation at commit rather than claiming complete empty authority', async () => {
    const f = await fixture();
    await source().loadWork(f.context, f.work.id);
    await expect(
      withTenantTx(agent.db, f.context, async (tx) => {
        await loadAgentReadScopeInTx(tx, f.context);
        await tx.insert(runInputObservations).values({
          organizationId: owner.organizationId,
          runId: f.runId,
          inputKind: 'work_unit',
          inputId: f.work.id,
          inputSha256: 'b'.repeat(64),
          classification: 'public',
        });
      }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    const all = await withTenantTx(agent.db, f.context, (tx) =>
      tx.select().from(runInputObservations).where(eq(runInputObservations.runId, f.runId)),
    );
    expect(all.some((row) => row.inputSha256 === 'b'.repeat(64))).toBe(false);
  });
  it.each(['cancelled', 'completed'] as const)(
    'releases %s runs through the same Work effects while terminal body serving remains closed',
    async (status) => {
      const f = await running();
      await finishRun(agent.db, f.context, {
        agentRunId: f.runId,
        status,
        stopCode: status === 'cancelled' ? 'STOPPED_BY_PERSON' : null,
      });
      const work = await getWorkUnit(app.db, owner, f.work.id);
      expect(work.status).toBe(status === 'completed' ? 'verifying' : 'failed');
      expect(work.runId).toBeNull();
      const transitions = await withTenantTx(app.db, owner, (tx) =>
        tx.select().from(workTransitions).where(eq(workTransitions.workUnitId, f.work.id)),
      );
      const events = await withTenantTx(app.db, owner, (tx) =>
        tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, f.work.id)),
      );
      expect(
        transitions.some((row) => row.toStatus === work.status && row.fromStatus === 'running'),
      ).toBe(true);
      expect(
        events.some(
          (row) => row.eventType === 'work.transitioned' && row.aggregateVersion === work.version,
        ),
      ).toBe(true);
      await withTenantTx(agent.db, f.context, async (tx) => {
        await tx.execute(sql`select set_config('app.terminal_work_control_run',${f.runId},true)`);
        expect(
          await tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, f.work.id)),
        ).toEqual([]);
      });
      await finishRun(agent.db, f.context, { agentRunId: f.runId, status, stopCode: null });
      expect((await getWorkUnit(app.db, owner, f.work.id)).version).toBe(work.version);
      expect(
        (
          await withTenantTx(app.db, owner, (tx) =>
            tx.select().from(workTransitions).where(eq(workTransitions.workUnitId, f.work.id)),
          )
        ).length,
      ).toBe(transitions.length);
    },
  );
  it('repairs an actual already-terminal run without reusing body-read authority, preserving rollback and exact binding', async () => {
    const f = await running();
    await withTenantTx(agent.db, f.context, (tx) =>
      tx
        .update(agentRuns)
        .set({
          status: 'cancelled',
          stopCode: 'STOPPED_BY_PERSON',
          endedAt: new Date(),
          version: sql`${agentRuns.version}+1`,
        })
        .where(eq(agentRuns.id, f.runId)),
    );
    const before = await getWorkUnit(app.db, owner, f.work.id);
    expect(before.status).toBe('running');
    const service = createServiceContext(owner.organizationId);
    await expect(
      withTenantTx(agent.db, service, async (tx) => {
        await tx.execute(
          sql`select set_config('app.terminal_work_control_run','prior-selector',true)`,
        );
        const rows = await tx.execute(
          sql`select * from work.agent_terminal_control_facts(${f.runId}::uuid)`,
        );
        expect(Object.keys(rows.rows[0] ?? {}).sort()).toEqual(
          [
            'classification',
            'contentSha256',
            'hasExecutionPlan',
            'id',
            'initiatorMembershipId',
            'ownerMembershipId',
            'runId',
            'runRequestedAt',
            'runRequestedByMembershipId',
            'runStatus',
            'status',
            'version',
          ].sort(),
        );
        expect(rows.rows[0]?.contentSha256).toBe(
          createHash('sha256')
            .update(canonicalJson({ title: f.work.title, objective: f.work.objective ?? '' }))
            .digest('hex'),
        );
        expect(
          (
            await tx.execute<{ value: string }>(
              sql`select current_setting('app.terminal_work_control_run',true) value`,
            )
          ).rows[0]?.value,
        ).toBe('prior-selector');
        await expect(
          tx.transaction((inner) =>
            inner.execute(
              sql`select * from work.agent_terminal_control_transition(${f.runId}::uuid,${before.version}::bigint,'running','completed')`,
            ),
          ),
        ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
        expect(
          (
            await tx.execute<{ value: string }>(
              sql`select current_setting('app.terminal_work_control_run',true) value`,
            )
          ).rows[0]?.value,
        ).toBe('prior-selector');
        await tx.execute(
          sql`select * from work.agent_terminal_control_transition(${f.runId}::uuid,${before.version}::bigint,'running','failed')`,
        );
        throw new Error('TEST_TERMINAL_ROLLBACK');
      }),
    ).rejects.toThrow('TEST_TERMINAL_ROLLBACK');
    expect((await getWorkUnit(app.db, owner, f.work.id)).version).toBe(before.version);
    await expect(
      withTenantTx(app.db, owner, (tx) =>
        tx.execute(sql`select * from work.agent_terminal_control_facts(${f.runId}::uuid)`),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(agent.db, createServiceContext(people.b.organizationId), (tx) =>
        tx.execute(sql`select * from work.agent_terminal_control_facts(${f.runId}::uuid)`),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    expect((await getWorkUnit(app.db, owner, f.work.id)).status).toBe('failed');
  });
  it('conservatively releases the exact Work when the real initiator has been disabled, without fabricating an agent context', async () => {
    const fresh = await makeTwoTenants(app.db);
    await proveSecondFactor(fresh.a.owner);
    await proveSecondFactor(fresh.a.admin);
    const manager = await nativePersonContext(app.db, fresh.a.owner, fresh.a.organizationId);
    const initiator = await nativePersonContext(app.db, fresh.a.admin, fresh.a.organizationId);
    const f = await running(initiator);
    await disableMember(app.db, manager, { membershipId: initiator.membershipId });
    await expect(
      createAgentContext(agent.db, {
        organizationId: initiator.organizationId,
        initiatorMembershipId: initiator.membershipId,
        agentRunId: f.runId,
      }),
    ).rejects.toThrow();
    await closeRunWithoutContext(agent.db, {
      organizationId: initiator.organizationId,
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'INITIATOR_INACTIVE',
    });
    const work = await getWorkUnit(app.db, manager, f.work.id);
    expect(work.status).toBe('failed');
    expect(work.runId).toBeNull();
    await expect(source().loadWork(f.context, f.work.id)).rejects.toThrow();
    await closeRunWithoutContext(agent.db, {
      organizationId: initiator.organizationId,
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'INITIATOR_INACTIVE',
    });
    expect((await getWorkUnit(app.db, manager, f.work.id)).version).toBe(work.version);
  });
  it('closes an actual paused review and its reminders/notifications/outbox through the shared terminal effects', async () => {
    const f = await running();
    const review = await requestApproval(app.db, owner, {
      workUnitId: f.work.id,
      action: workReviewAction(f.work, []),
      approverMembershipId: admin.membershipId,
      expiresAt: new Date(Date.now() + 60000),
      runId: f.temporalRunId,
    });
    const before = await withTenantTx(app.db, admin, (tx) =>
      tx
        .select()
        .from(notifications)
        .where(eq(notifications.targetRef, `approval:${review.id}`)),
    );
    expect(before).toHaveLength(1);
    expect(before[0]?.remindAt).toBeInstanceOf(Date);
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    const [closed] = await withTenantTx(app.db, owner, (tx) =>
      tx.select().from(approvals).where(eq(approvals.id, review.id)),
    );
    expect(closed).toMatchObject({ status: 'cancelled' });
    expect(closed?.decidedAt).toBeInstanceOf(Date);
    const after = await withTenantTx(app.db, admin, (tx) =>
      tx
        .select()
        .from(notifications)
        .where(eq(notifications.targetRef, `approval:${review.id}`)),
    );
    expect(after[0]?.readAt).toBeInstanceOf(Date);
    expect(after[0]?.remindAt).toBeNull();
    const ownerNotices = await withTenantTx(app.db, owner, (tx) =>
      tx
        .select()
        .from(notifications)
        .where(eq(notifications.targetRef, `work_unit:${f.work.id}`)),
    );
    expect(ownerNotices.map((row) => row.kind)).toEqual(
      expect.arrayContaining(['approval.work_finished', 'work.failed']),
    );
    const published = await withTenantTx(app.db, owner, (tx) =>
      tx
        .select({
          eventType: domainEvents.eventType,
          payload: domainEvents.payload,
          state: outboxEvents.state,
        })
        .from(domainEvents)
        .innerJoin(outboxEvents, eq(outboxEvents.eventId, domainEvents.id))
        .where(eq(domainEvents.aggregateId, f.work.id)),
    );
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'approval.resolved',
          payload: { approval_id: review.id, work_unit_id: f.work.id, outcome: 'cancelled' },
        }),
      ]),
    );
    expect(
      published
        .filter((row) => row.eventType === 'approval.resolved')
        .every((row) => ['queued', 'published'].includes(row.state)),
    ).toBe(true);
    expect((await getWorkUnit(app.db, owner, f.work.id)).status).toBe('failed');
  });
  it('never releases a newer workflow hold when retrying an older terminal run', async () => {
    const f = await running();
    await withTenantTx(agent.db, f.context, (tx) =>
      tx
        .update(agentRuns)
        .set({
          status: 'cancelled',
          stopCode: 'STOPPED_BY_PERSON',
          endedAt: new Date(),
          version: sql`${agentRuns.version}+1`,
        })
        .where(eq(agentRuns.id, f.runId)),
    );
    const failed = await withTenantTx(app.db, owner, async (tx) =>
      failRun(tx, owner, await loadChangeable(tx, owner, f.work.id)),
    );
    await transitionWorkUnit(app.db, owner, {
      id: f.work.id,
      expectedVersion: failed.version,
      to: 'ready',
    });
    const newerRunId = await seedQueuedRun(app.db, owner, {
      workUnitId: f.work.id,
      version: f.version,
    });
    const newerTemporalId = randomUUID();
    expect(
      await claimQueuedRun(agent.db, {
        organizationId: owner.organizationId,
        workUnitId: f.work.id,
        temporalRunId: newerTemporalId,
      }),
    ).not.toBeNull();
    const before = await getWorkUnit(app.db, owner, f.work.id);
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    const after = await getWorkUnit(app.db, owner, f.work.id);
    expect(after).toMatchObject({
      version: before.version,
      status: 'running',
      runId: newerTemporalId,
    });
    const [newer] = await withTenantTx(app.db, owner, (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, newerRunId)),
    );
    expect(newer).toMatchObject({ status: 'preparing', temporalRunId: newerTemporalId });
  });
  it('pins original-parent authority against the actual concurrent revocation driver until the read transaction ends', async () => {
    const client = await createClient(app.db, admin, {
      displayName: 'Read barrier parent',
      classification: 'restricted',
    });
    if (!client) throw new Error('TEST_CLIENT_REFUSED');
    await setClientReaders(app.db, admin, {
      clientId: client.id,
      expectedVersion: client.accessVersion,
      readerMembershipIds: [owner.membershipId],
    });
    const project = await createProject(app.db, admin, {
      name: 'Read barrier project',
      clientId: client.id,
    });
    if (!project) throw new Error('TEST_PROJECT_REFUSED');
    const f = await fixture(project.id, ['data.restricted.read']);
    await source().loadWork(f.context, f.work.id);
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const leave = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = withTenantTx(agent.db, f.context, async (tx) => {
      await loadAgentReadScopeInTx(tx, f.context);
      entered();
      await leave;
    });
    try {
      await Promise.race([
        inside,
        reader.then(() => {
          throw new Error('TEST_READ_BARRIER_ENDED_EARLY');
        }),
      ]);
      await expect(
        withTenantTx(app.db, admin, async (tx) => {
          await tx.execute(sql`set local lock_timeout='200ms'`);
          await tx.delete(clientReaders).where(eq(clientReaders.clientId, client.id));
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '55P03');
    } finally {
      release();
      await reader;
    }
    const sharing = await getClientSharing(app.db, admin, client.id);
    await setClientReaders(app.db, admin, {
      clientId: client.id,
      expectedVersion: sharing.version,
      readerMembershipIds: [],
    });
    await expect(source().loadWork(f.context, f.work.id)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });
});
