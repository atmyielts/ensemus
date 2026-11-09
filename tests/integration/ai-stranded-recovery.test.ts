// Real-role checks for the join between base upkeep and agent runs. The unit tests hold the Activity's
// ordering; these hold SQL selection, tenant denial and rollback. Run by the integration suite, not by
// a slice that has no database.
import { randomUUID } from 'node:crypto';
import {
  createWorkUnit,
  failRun,
  getWorkUnit,
  loadChangeable,
  transitionWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import {
  claimQueuedRun,
  closeStrandedRun,
  closeStrandedRunInTx,
  contextForRun,
  reclaimRun,
} from '@ensemus/application/ai-runs';
import { agentRuns, openAppDatabase, withTenantTx, workUnits } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createActivities } from '@ensemus/workflows/activities';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openAgentTestDatabase,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  type AiTenant,
  type SeededAgentVersion,
} from '../helpers/ai/fixtures';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { urls } from '../helpers/stack';

const objects: ObjectStore = {
  put: async () => undefined,
  get: async () => Buffer.alloc(0),
  delete: async () => undefined,
  exists: async () => false,
};

describe('stranded agent recovery, under the real roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let su: pg.Client;
  let a: AiTenant;
  let b: AiTenant;
  let version: SeededAgentVersion;

  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 3 });
    agent = openAgentTestDatabase(3);
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
    version = await seedAgentVersion(app.db, a.owner);
  });

  afterAll(async () => {
    await app?.close();
    await agent?.close();
    await su?.end();
  });

  async function running(initiator = a.owner) {
    const work = await createWorkUnit(app.db, initiator, { title: 'Recover this generated work' });
    await transitionWorkUnit(app.db, initiator, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    const agentRunId = await seedQueuedRun(app.db, initiator, { workUnitId: work.id, version });
    const temporalRunId = randomUUID();
    expect(
      await claimQueuedRun(agent.db, {
        organizationId: a.organizationId,
        workUnitId: work.id,
        temporalRunId,
      }),
    ).not.toBeNull();
    return { workUnitId: work.id, agentRunId, temporalRunId };
  }

  async function stored(runId: string) {
    const [row] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select({
          status: agentRuns.status,
          stopCode: agentRuns.stopCode,
          temporalRunId: agentRuns.temporalRunId,
          version: agentRuns.version,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    );
    return row;
  }

  /** The workflow run that holds the Work now, read as the tenant's owner. */
  async function heldBy(workUnitId: string) {
    const [row] = await withTenantTx(app.db, a.owner, (tx) =>
      tx.select({ runId: workUnits.runId }).from(workUnits).where(eq(workUnits.id, workUnitId)),
    );
    return row?.runId;
  }

  /** As the superuser, bound to the row's own tenant, as the membership triggers need. */
  const setMemberStatus = (membershipId: string, status: 'active' | 'disabled') =>
    inFixtureTenant(su, a.organizationId, () =>
      su.query('update org.memberships set status = $2 where id = $1', [membershipId, status]),
    );

  /** Ages the held Work as the superuser, bound to the row's own tenant for the epoch triggers. */
  const age = (workUnitId: string) =>
    inFixtureTenant(su, a.organizationId, () =>
      su.query(
        "update work.work_units set updated_at = now() - interval '1 hour' where organization_id = $1 and id = $2",
        [a.organizationId, workUnitId],
      ),
    );

  it('fails held work and its exact agent run together through real upkeep', async () => {
    const run = await running();
    await age(run.workUnitId);
    await createActivities({
      database: app.db,
      store: objects,
      probeWorkflow: async () => 'closed',
    }).sendReminders({ organizationId: a.organizationId });
    expect((await getWorkUnit(app.db, a.owner, run.workUnitId)).status).toBe('failed');
    expect(await stored(run.agentRunId)).toMatchObject({ status: 'failed', stopCode: 'STRANDED' });
  });

  it('does not close a newer workflow run with a stale workflow ID', async () => {
    const run = await running();
    const context = await contextForRun(agent.db, {
      organizationId: a.organizationId,
      agentRunId: run.agentRunId,
    });
    const newerId = randomUUID();
    expect(await reclaimRun(agent.db, context, { ...run, temporalRunId: newerId })).not.toBeNull();
    const before = await stored(run.agentRunId);
    await closeStrandedRun(app.db, createServiceContext(a.organizationId), run);
    expect(await stored(run.agentRunId)).toEqual(before);
    expect(before?.temporalRunId).toBe(newerId);
    expect((await getWorkUnit(app.db, a.owner, run.workUnitId)).status).toBe('running');
  });

  it('moves the hold only behind the run’s own admission, and takes nothing over when it cannot be admitted', async () => {
    // Admitted: the newer workflow run takes the run and the Work's hold over. Without the run's own
    // read-scope and authority-v1 admission, 0417's authority_work_body hides the Work from this
    // agent transaction and continue-as-new could never move a hold.
    const admitted = await running();
    const admittedContext = await contextForRun(agent.db, {
      organizationId: a.organizationId,
      agentRunId: admitted.agentRunId,
    });
    const newerId = randomUUID();
    expect(
      await reclaimRun(agent.db, admittedContext, { ...admitted, temporalRunId: newerId }),
    ).toMatchObject({ agentRunId: admitted.agentRunId });
    expect(await stored(admitted.agentRunId)).toMatchObject({ temporalRunId: newerId });
    expect(await heldBy(admitted.workUnitId)).toBe(newerId);

    // Refused: the initiator is disabled after the context was made. 0414's preflight refuses the
    // admission, and reclaimRun answers null without throwing and without moving anything.
    const refused = await running(a.member);
    const refusedContext = await contextForRun(agent.db, {
      organizationId: a.organizationId,
      agentRunId: refused.agentRunId,
    });
    const before = await stored(refused.agentRunId);
    await setMemberStatus(a.member.membershipId, 'disabled');
    try {
      expect(
        await reclaimRun(agent.db, refusedContext, { ...refused, temporalRunId: randomUUID() }),
      ).toBeNull();
    } finally {
      await setMemberStatus(a.member.membershipId, 'active');
    }
    expect(await stored(refused.agentRunId)).toEqual(before);
    expect(before?.temporalRunId).toBe(refused.temporalRunId);
    expect(await heldBy(refused.workUnitId)).toBe(refused.temporalRunId);
  });

  it('rechecks the locked work after continue-as-new wins while Temporal is being asked', async () => {
    const run = await running();
    const context = await contextForRun(agent.db, {
      organizationId: a.organizationId,
      agentRunId: run.agentRunId,
    });
    const newerId = randomUUID();
    await age(run.workUnitId);
    await createActivities({
      database: app.db,
      store: objects,
      probeWorkflow: async () => {
        expect(
          await reclaimRun(agent.db, context, { ...run, temporalRunId: newerId }),
        ).not.toBeNull();
        return 'closed';
      },
    }).sendReminders({ organizationId: a.organizationId });
    expect(await stored(run.agentRunId)).toMatchObject({
      status: 'preparing',
      temporalRunId: newerId,
    });
    expect((await getWorkUnit(app.db, a.owner, run.workUnitId)).status).toBe('running');
  });

  it('rolls both effects back if the recovery transaction cannot commit', async () => {
    const run = await running();
    const before = await stored(run.agentRunId);
    const context = createServiceContext(a.organizationId);
    await expect(
      withTenantTx(app.db, context, async (tx) => {
        const work = await loadChangeable(tx, context, run.workUnitId);
        await failRun(tx, context, work);
        await closeStrandedRunInTx(tx, context, run);
        throw new Error('ROLLBACK_CONTROL');
      }),
    ).rejects.toThrow('ROLLBACK_CONTROL');
    expect(await stored(run.agentRunId)).toEqual(before);
    expect((await getWorkUnit(app.db, a.owner, run.workUnitId)).status).toBe('running');
  });

  it("cannot close another tenant's run, even with its work and workflow IDs", async () => {
    const run = await running();
    const before = await stored(run.agentRunId);
    await closeStrandedRun(app.db, createServiceContext(b.organizationId), run);
    expect(await stored(run.agentRunId)).toEqual(before);
  });

  it('does not let a person call the worker-only cleanup', async () => {
    const run = await running();
    const before = await stored(run.agentRunId);
    await expect(closeStrandedRun(app.db, a.owner, run)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await stored(run.agentRunId)).toEqual(before);
  });

  it('does not rewrite a terminal run when a sweep is repeated', async () => {
    const run = await running();
    const context = createServiceContext(a.organizationId);
    await closeStrandedRun(app.db, context, run);
    const after = await stored(run.agentRunId);
    expect(after).toMatchObject({ status: 'failed', stopCode: 'STRANDED' });
    await closeStrandedRun(app.db, context, run);
    expect(await stored(run.agentRunId)).toEqual(after);
  });
});
