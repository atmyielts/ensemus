// Slice 1, WORK-07: create work → outbox → dispatcher → workflow → artifact → verified completion,
// against real containers, with real restarts and outages along the way.
import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addArtifact,
  createInvitation,
  createWorkUnit,
  decideApproval,
  getWorkDetail,
  getWorkUnit,
  listMyPendingApprovals,
  readArtifact,
  requestExecution,
  transitionWorkUnit,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
import { compose, secret, urls } from '../helpers/stack';

const TIMEOUT = 45_000;

describe('durable work execution', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let context: TenantContext;
  let reviewer: TenantContext;
  let su: pg.Client;
  const store = () =>
    new S3ObjectStore({
      endpoint: 'http://127.0.0.1:58333',
      bucket: 'ensemus',
      accessKey: secret('objects_access_key'),
      secretKey: secret('objects_secret_key'),
    });

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    const auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'Executor',
      `${userId}@example.invalid`,
    ]);
    const reviewerId = randomUUID();
    const reviewerEmail = `${reviewerId}@example.invalid`;
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      reviewerId,
      'Reviewer',
      reviewerEmail,
    ]);
    await auth.end();
    const { organizationId } = await createOrganization(app.db, {
      userId,
      name: 'Execution',
      commercialMode: 'sovereign',
    });
    context = await resolveTenantContext(app.db, userId, organizationId);
    const { token } = await createInvitation(app.db, context, {
      email: reviewerEmail,
      role: 'admin',
    });
    await acceptInvitation(app.db, {
      token,
      userId: reviewerId,
      email: reviewerEmail,
      emailVerified: true,
    });
    reviewer = await resolveTenantContext(app.db, reviewerId, organizationId);
  });

  afterAll(async () => {
    await app?.close();
    await su?.end();
  });

  async function startWork(criteria: Array<{ kind: 'artifact_exists' | 'reviewer_approved' }>) {
    const work = await createWorkUnit(app.db, context, {
      title: 'Durable',
      executionPlan: 'checklist',
      completionCriteria: criteria,
    });
    await transitionWorkUnit(app.db, context, { id: work.id, expectedVersion: 1, to: 'ready' });
    await requestExecution(app.db, context, work.id, {
      reviewerMembershipId: reviewer.membershipId,
    });
    return work.id;
  }

  const pendingFor = async (id: string) =>
    (await listMyPendingApprovals(app.db, reviewer)).filter((p) => p.workUnitId === id);

  const decide = async (id: string, decision: 'approve' | 'deny') => {
    const [pending] = await pendingFor(id);
    expect(pending).toBeDefined();
    const { rows } = await su.query('select action_hash from work.approvals where id = $1', [
      pending!.id,
    ]);
    await decideApproval(app.db, reviewer, {
      approvalId: pending!.id,
      decision,
      shownHash: rows[0].action_hash,
    });
  };

  /** A person accepts what the plan left for checking, which is the only way it gets done. */
  const accept = async (id: string) => {
    const { version } = await getWorkUnit(app.db, context, id);
    await transitionWorkUnit(app.db, context, { id, expectedVersion: version, to: 'completed' });
  };

  const statusOf = async (id: string) => (await getWorkUnit(app.db, context, id)).status;
  const waitForStatus = (id: string, status: string) =>
    expect.poll(() => statusOf(id), { timeout: TIMEOUT, interval: 300 }).toBe(status);

  it('runs a plan up to checking, with the artifact really stored, and stops there', async () => {
    const id = await startWork([{ kind: 'artifact_exists' }]);
    await waitForStatus(id, 'verifying');
    const { files, evidence } = await getWorkDetail(app.db, context, id);
    expect(files.map((f) => f.name)).toEqual(['completion-checklist.md']);
    const file = await readArtifact(app.db, store(), context, {
      workUnitId: id,
      artifactId: files[0]!.id,
    });
    expect(file.body.toString()).toContain('Completion checklist');
    expect(file.body.toString()).toContain(id);

    // Its own checklist proves nothing. A person attaches the result, and marks it done.
    expect(evidence.artifactCount).toBe(0);
    await expect(accept(id)).rejects.toEqual(expect.objectContaining({ code: 'EVIDENCE_MISSING' }));
    await addArtifact(app.db, store(), context, {
      workUnitId: id,
      name: 'result.txt',
      mimeType: 'text/plain',
      body: Buffer.from('the result'),
    });
    await accept(id);
    expect(await statusOf(id)).toBe('completed');
  });

  it('survives a worker restart during an approval wait (WORK-07, QA-014)', async () => {
    const id = await startWork([{ kind: 'artifact_exists' }, { kind: 'reviewer_approved' }]);
    await waitForStatus(id, 'awaiting_approval');

    compose('restart', 'worker');

    await decide(id, 'approve');
    await waitForStatus(id, 'verifying');

    // Nothing was repeated: one artifact, one approval.
    const detail = await getWorkDetail(app.db, context, id);
    expect(detail.files).toHaveLength(1);
    expect(detail.reviews).toHaveLength(1);
  });

  it('stops when the approver denies', async () => {
    const id = await startWork([{ kind: 'reviewer_approved' }]);
    await waitForStatus(id, 'awaiting_approval');
    await decide(id, 'deny');
    await waitForStatus(id, 'cancelled');
  });

  it('keeps waiting when woken by a signal that is not about its review', async () => {
    const id = await startWork([{ kind: 'reviewer_approved' }]);
    await waitForStatus(id, 'awaiting_approval');
    const connection = await Connection.connect({ address: '127.0.0.1:57233' });
    try {
      const client = new Client({ connection, namespace: 'default' });
      const handle = client.workflow.getHandle(`work-${context.organizationId}-${id}`);
      await handle.signal('approvalResolved');
      await new Promise((done) => setTimeout(done, 3_000));
      // Still running, still waiting, and the review still open.
      expect((await handle.describe()).status.name).toBe('RUNNING');
    } finally {
      await connection.close();
    }
    expect(await statusOf(id)).toBe('awaiting_approval');
    expect(await pendingFor(id)).toHaveLength(1);
    await decide(id, 'approve');
    await waitForStatus(id, 'verifying');
  });

  it('stops running work when a person cancels it', async () => {
    const id = await startWork([{ kind: 'reviewer_approved' }]);
    await waitForStatus(id, 'awaiting_approval');
    const current = await getWorkUnit(app.db, context, id);
    await transitionWorkUnit(app.db, context, {
      id,
      expectedVersion: current.version,
      to: 'cancelled',
    });
    await new Promise((done) => setTimeout(done, 3_000));
    expect(await statusOf(id)).toBe('cancelled');
    const { files } = await getWorkDetail(app.db, context, id);
    expect(files.length).toBeLessThanOrEqual(1);
  });

  it('keeps working through a dispatcher outage, and catches up', async () => {
    compose('stop', 'dispatcher');
    let id: string;
    try {
      id = await startWork([{ kind: 'artifact_exists' }]);
      await new Promise((done) => setTimeout(done, 1_500));
      // The business write committed, and the work simply waits.
      expect(await statusOf(id)).toBe('ready');
    } finally {
      compose('start', 'dispatcher');
    }
    await waitForStatus(id, 'verifying');
  });

  it('keeps ordinary edits working through a Temporal outage, then runs the work', async () => {
    compose('stop', 'temporal');
    let id: string;
    try {
      id = await startWork([{ kind: 'artifact_exists' }]);
      expect(await statusOf(id)).toBe('ready');
      const other = await createWorkUnit(app.db, context, { title: 'Manual work carries on' });
      expect(other.status).toBe('queued');
    } finally {
      compose('start', 'temporal');
    }
    await waitForStatus(id, 'verifying');
  }, 120_000);

  it('does nothing new when an event is delivered twice (WORK-06)', async () => {
    const id = await startWork([{ kind: 'artifact_exists' }]);
    await waitForStatus(id, 'verifying');
    const version = (await getWorkUnit(app.db, context, id)).version;
    await su.query(
      `update platform.outbox_events o set state = 'queued', next_attempt_at = now()
       from platform.domain_events e
       where e.id = o.event_id and e.organization_id = o.organization_id
         and e.aggregate_id = $1 and e.event_type = 'work.execution_requested'`,
      [id],
    );
    await new Promise((done) => setTimeout(done, 4_000));
    const after = await getWorkDetail(app.db, context, id);
    expect(after.work.status).toBe('verifying');
    expect(after.work.version).toBe(version);
    expect(after.files).toHaveLength(1);
  });

  it('never sends work titles or objectives through Temporal', async () => {
    const canary = `CANARYWORK${randomUUID().replaceAll('-', '')}`;
    const work = await createWorkUnit(app.db, context, {
      title: canary,
      objective: canary,
      executionPlan: 'checklist',
    });
    await transitionWorkUnit(app.db, context, { id: work.id, expectedVersion: 1, to: 'ready' });
    await requestExecution(app.db, context, work.id);
    await waitForStatus(work.id, 'verifying');
    const dump = ['temporal', 'temporal_visibility']
      .map((db) => compose('exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', db))
      .join('\n');
    expect(dump).not.toContain(canary);
    expect(dump.toLowerCase()).not.toContain(Buffer.from(canary).toString('hex'));
  });
});
