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
import { agentRuns, openAppDatabase, withTenantTx } from '@ensemus/database';
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

  async function running() {
    const work = await createWorkUnit(app.db, a.owner, { title: 'Recover this generated work' });
    await transitionWorkUnit(app.db, a.owner, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    const agentRunId = await seedQueuedRun(app.db, a.owner, { workUnitId: work.id, version });
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

  it('fails held work and its exact agent run together through real upkeep', async () => {
    const run = await running();
    await su.query(
      "update work.work_units set updated_at = now() - interval '1 hour' where organization_id = $1 and id = $2",
      [a.organizationId, run.workUnitId],
    );
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

  it('rechecks the locked work after continue-as-new wins while Temporal is being asked', async () => {
    const run = await running();
    const context = await contextForRun(agent.db, {
      organizationId: a.organizationId,
      agentRunId: run.agentRunId,
    });
    const newerId = randomUUID();
    await su.query(
      "update work.work_units set updated_at = now() - interval '1 hour' where organization_id = $1 and id = $2",
      [a.organizationId, run.workUnitId],
    );
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
