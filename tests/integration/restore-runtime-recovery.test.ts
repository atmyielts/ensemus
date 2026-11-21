// ADR-026 / ADR-030 D11 against the real roles: the M4 and M5 restore contributors bound to the runtimes,
// as restore-reconcile composes them. A run whose workflow a restore lost is closed as STRANDED, its holds
// settled and its transcript fenced and purged by the agent role, and a tenant with nothing in flight comes
// out with no attention; a run Temporal still has open, or cannot answer for, stays attention. Generated
// values only. Written, not yet run: owed to the first stack run.
import { randomUUID } from 'node:crypto';
import {
  createRestoreContributors,
  createWorkUnit,
  transitionWorkUnit,
  type RestoreContributor,
  type RunProbe,
} from '@ensemus/application';
import { claimQueuedRun } from '@ensemus/application/ai-runs';
import { createRuntimeRestoreRecoveryBindings } from '@ensemus/application/saas/restore-recovery';
import { openAppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openAgentTestDatabase,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { memoryTransport, nativeKnowledgeStore } from '../helpers/knowledge-native';
import { urls } from '../helpers/stack';

const RUNTIME = [
  'm4-runs-and-budgets',
  'm4-private-transcripts',
  'm5-sources-and-indexes',
] as const;

describe('runtime restore contributors (ADR-030 D11)', () => {
  // restore-reconcile runs in the platform worker's image, under its login (ADR-039).
  const app = openAppDatabase(urls.worker(), { max: 4 }),
    agent = openAgentTestDatabase(4),
    su = new pg.Client({ connectionString: urls.superuser() });
  beforeAll(async () => {
    await su.connect();
  });
  afterAll(async () => {
    await su.end();
    await agent.close();
    await app.close();
  });

  const contributors = (probeRun: RunProbe, withAgent = true): RestoreContributor[] =>
    createRestoreContributors(
      createRuntimeRestoreRecoveryBindings({
        ...(withAgent ? { agentDatabase: agent.db } : {}),
        probeRun,
        knowledgeStore: nativeKnowledgeStore(app.db, memoryTransport()),
      }),
    ).filter(({ name }) => (RUNTIME as readonly string[]).includes(name));

  const reportsFor = async (tenant: AiTenant, list: RestoreContributor[]) => {
    const context = createServiceContext(tenant.organizationId);
    const reports = [];
    // In the command's order: runs before transcripts, so a closed run's transcript is purged the same pass.
    for (const contributor of list) reports.push(await contributor.reconcile(app.db, context));
    return reports;
  };

  /** A run claimed by a workflow run that the restore then lost. */
  async function claimedRun(tenant: AiTenant) {
    const work = await createWorkUnit(app.db, tenant.owner, {
      title: 'Generated restore fixture',
      objective: 'Nothing.',
    });
    await transitionWorkUnit(app.db, tenant.owner, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    const version = await seedAgentVersion(app.db, tenant.owner);
    const runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version });
    const temporalRunId = randomUUID();
    const claimed = await claimQueuedRun(agent.db, {
      organizationId: tenant.organizationId,
      workUnitId: work.id,
      temporalRunId,
    });
    if (!claimed) throw new Error('TEST_RUN_NOT_CLAIMED');
    return { runId, workUnitId: work.id, temporalRunId };
  }

  it('reports a tenant with nothing in flight clean, each from a real check', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const reports = await reportsFor(
      tenant,
      contributors(async () => {
        throw new Error('NO_RUN_TO_PROBE');
      }),
    );
    expect(reports.map(({ name }) => name)).toEqual([...RUNTIME]);
    expect(reports.every((report) => report.needsAttention === 0)).toBe(true);
    const transcripts = reports.find(({ name }) => name === 'm4-private-transcripts')!;
    expect(transcripts.runInputs?.runs).toBe(0);
  });

  it('closes a run whose workflow is gone, and fences and purges its transcript', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const run = await claimedRun(tenant);
    const probed: string[] = [];
    const reports = await reportsFor(
      tenant,
      contributors(async ({ runId }) => {
        probed.push(runId);
        return 'closed';
      }),
    );
    expect(probed).toEqual([run.temporalRunId]);
    const {
      rows: [row],
    } = await su.query(
      `select r.status, r.stop_code, c.fenced_at, c.fence_generation, c.payloads_purged_at
         from ai.agent_runs r left join ai.run_input_checkpoints c on c.organization_id=r.organization_id and c.run_id=r.id
        where r.organization_id=$1 and r.id=$2`,
      [tenant.organizationId, run.runId],
    );
    expect(row).toMatchObject({ status: 'failed', stop_code: 'STRANDED', fence_generation: 1 });
    expect(row.fenced_at).not.toBeNull();
    expect(row.payloads_purged_at).not.toBeNull();
    const {
      rows: [held],
    } = await su.query(
      `select count(*)::int as n from platform.budget_reservations where organization_id=$1 and status='held'`,
      [tenant.organizationId],
    );
    expect(held.n).toBe(0);
    const [runs, transcripts] = reports;
    expect(runs).toMatchObject({ name: 'm4-runs-and-budgets', needsAttention: 0 });
    expect(runs!.changed).toBeGreaterThanOrEqual(1);
    expect(transcripts).toMatchObject({ name: 'm4-private-transcripts', needsAttention: 0 });
  });

  it('leaves a run Temporal has open, or cannot answer for, live and reported', async () => {
    for (const answer of ['open', 'unknown'] as const) {
      const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
      const run = await claimedRun(tenant);
      const [runs] = await reportsFor(
        tenant,
        contributors(async () => {
          if (answer === 'unknown') throw new Error('TEMPORAL_UNREACHABLE');
          return 'open';
        }),
      );
      expect(runs!.needsAttention).toBeGreaterThanOrEqual(1);
      const {
        rows: [row],
      } = await su.query('select status from ai.agent_runs where organization_id=$1 and id=$2', [
        tenant.organizationId,
        run.runId,
      ]);
      expect(row.status).not.toBe('failed');
    }
  });

  it('without the agent role, neither M4 contributor can report a tenant clean', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const reports = await reportsFor(
      tenant,
      contributors(async () => 'closed', false),
    );
    for (const name of ['m4-runs-and-budgets', 'm4-private-transcripts'])
      expect(reports.find((report) => report.name === name)!.needsAttention).toBeGreaterThan(0);
  });
});
