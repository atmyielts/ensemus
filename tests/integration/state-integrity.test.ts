// What a Work Unit's record says about itself: versions, events, who is told when a review closes, and
// the order of its history. Through real database roles, with a store in memory.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addArtifact,
  createInvitation,
  createWorkUnit,
  decideApproval,
  disableMember,
  getApproval,
  getWorkDetail,
  getWorkUnit,
  listMyNotifications,
  requestExecution,
  requestWorkReview,
  transitionWorkUnit,
  updateWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import type { WorkState } from '@ensemus/domain/work-unit';
import { createActivities } from '@ensemus/workflows/activities';
import { repoRoot, urls } from '../helpers/stack';

const refused = (code: string) => expect.objectContaining({ code });

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error('missing');
    return body;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}

describe('the record a Work Unit keeps', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let su: pg.Client;
  let auth: pg.Client;
  const db = () => app.db;

  async function makeUser(label: string) {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      email,
    ]);
    return { id, email };
  }

  async function newOrg(): Promise<TenantContext> {
    const user = await makeUser('owner');
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: `Integrity ${randomUUID()}`,
      commercialMode: 'byom',
    });
    return resolveTenantContext(db(), user.id, organizationId);
  }

  async function join(context: TenantContext, label: string, role: 'admin' | 'member' = 'admin') {
    const user = await makeUser(label);
    const { token } = await createInvitation(db(), context, { email: user.email, role });
    await auth.query('update identity.users set email_verified=true where id=$1', [user.id]);
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  async function move(context: TenantContext, id: string, statuses: WorkState[]) {
    let current = await getWorkUnit(db(), context, id);
    for (const to of statuses) {
      current = await transitionWorkUnit(db(), context, {
        id,
        expectedVersion: current.version,
        to,
      });
    }
    return current;
  }

  const eventsOf = async (id: string, type: string) =>
    (
      await su.query(
        `select aggregate_version::int as version, payload from platform.domain_events
         where aggregate_id = $1 and event_type = $2 order by aggregate_version`,
        [id, type],
      )
    ).rows as Array<{ version: number; payload: Record<string, unknown> }>;

  const kindsFor = async (context: TenantContext) =>
    (await listMyNotifications(db(), context)).map((n) => n.kind);

  const activities = () => createActivities({ database: db(), store: new MemoryStore() });
  const runOf = (context: TenantContext, workUnitId: string, runId = randomUUID()) => ({
    organizationId: context.organizationId,
    workUnitId,
    runId,
  });

  /** A plan with a named reviewer, requested and ready for a run to claim. */
  async function planned(context: TenantContext, reviewer: TenantContext) {
    const work = await createWorkUnit(db(), context, {
      title: 'Planned',
      executionPlan: 'checklist',
      completionCriteria: [{ kind: 'reviewer_approved' }],
    });
    await move(context, work.id, ['ready']);
    await requestExecution(db(), context, work.id, {
      reviewerMembershipId: reviewer.membershipId,
    });
    return work;
  }

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    await app?.close();
    await su?.end();
    await auth?.end();
  });

  describe('a request to run a plan', () => {
    it('moves the version, so a form rendered before it cannot withdraw it unseen', async () => {
      const a = await newOrg();
      const b = await join(a, 'b');
      const work = await createWorkUnit(db(), a, { title: 'W', executionPlan: 'checklist' });
      const ready = await move(a, work.id, ['ready']);

      const requested = await requestExecution(db(), a, work.id);
      expect(requested.version).toBe(ready.version + 1);
      expect(requested.runRequestedAt).toBeInstanceOf(Date);
      expect((await getWorkUnit(db(), a, work.id)).version).toBe(ready.version + 1);
      // Open pages refresh on the version the event carries.
      expect(await eventsOf(work.id, 'work.execution_requested')).toEqual([
        expect.objectContaining({ version: ready.version + 1 }),
      ]);

      // B's page was rendered before the request.
      await expect(
        transitionWorkUnit(db(), b, { id: work.id, expectedVersion: ready.version, to: 'running' }),
      ).rejects.toEqual(refused('VERSION_CONFLICT'));
      expect((await getWorkUnit(db(), a, work.id)).runRequestedAt).toBeInstanceOf(Date);
    });

    it('tells whoever asked when a person withdraws it by moving the work', async () => {
      const a = await newOrg();
      const b = await join(a, 'b');
      const work = await createWorkUnit(db(), a, { title: 'W', executionPlan: 'checklist' });
      await move(a, work.id, ['ready']);
      await requestExecution(db(), a, work.id);

      // B's page is fresh, and says that starting by hand cancels the request.
      await move(b, work.id, ['running']);
      expect((await getWorkUnit(db(), a, work.id)).runRequestedAt).toBeNull();
      expect(await kindsFor(a)).toContain('work.run_withdrawn');
    });

    it('tells nobody when the run itself claims it, or when the person asking moves it', async () => {
      const a = await newOrg();
      const claimed = await createWorkUnit(db(), a, { title: 'W', executionPlan: 'checklist' });
      await move(a, claimed.id, ['ready']);
      await requestExecution(db(), a, claimed.id);
      await activities().prepareWork(runOf(a, claimed.id));

      const own = await createWorkUnit(db(), a, { title: 'X', executionPlan: 'checklist' });
      await move(a, own.id, ['ready']);
      await requestExecution(db(), a, own.id);
      await move(a, own.id, ['running']);

      expect(await kindsFor(a)).not.toContain('work.run_withdrawn');
    });

    it('refuses a reviewer who cannot read the work, at the form and not in the run', async () => {
      const a = await newOrg();
      const outsider = await join(a, 'outsider', 'member');
      const work = await createWorkUnit(db(), a, {
        title: 'Restricted',
        classification: 'restricted',
        executionPlan: 'checklist',
        completionCriteria: [{ kind: 'reviewer_approved' }],
      });
      const ready = await move(a, work.id, ['ready']);

      await expect(
        requestExecution(db(), a, work.id, { reviewerMembershipId: outsider.membershipId }),
      ).rejects.toEqual(refused('INVALID_INPUT'));

      const after = await getWorkUnit(db(), a, work.id);
      expect(after.version).toBe(ready.version);
      expect(after.runRequestedAt).toBeNull();
      expect(await eventsOf(work.id, 'work.execution_requested')).toEqual([]);
    });
  });

  describe('event versions', () => {
    it('keeps a pause and a decision in step with the transitions beside them', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const running = await move(a, work.id, ['ready', 'running']);

      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: running.version,
        approverMembershipId: reviewer.membershipId,
      });
      expect(await eventsOf(work.id, 'approval.requested')).toEqual([
        expect.objectContaining({ version: running.version + 1 }),
      ]);

      await decideApproval(db(), reviewer, {
        approvalId: review.id,
        decision: 'approve',
        shownHash: review.actionHash,
      });
      const after = await getWorkUnit(db(), a, work.id);
      expect(after.status).toBe('running');
      expect(after.version).toBe(running.version + 2);
      expect(await eventsOf(work.id, 'approval.resolved')).toEqual([
        expect.objectContaining({ version: after.version }),
      ]);
    });

    it('states the version a lost reviewer ended the run at', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer');
      const work = await planned(a, reviewer);
      const run = runOf(a, work.id);
      await activities().prepareWork(run);
      await activities().requestReview(run);

      await disableMember(db(), a, { membershipId: reviewer.membershipId });

      const after = await getWorkUnit(db(), a, work.id);
      expect(after.status).toBe('failed');
      expect(await eventsOf(work.id, 'approval.resolved')).toEqual([
        expect.objectContaining({ version: after.version }),
      ]);
    });

    it('uses the version the work had when a file finished uploading', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const store = new MemoryStore();
      // Someone edits the work while the bytes are on their way.
      const moving: ObjectStore = Object.assign(Object.create(store) as MemoryStore, {
        put: async (key: string, body: Buffer) => {
          await store.put(key, body);
          await updateWorkUnit(db(), a, work.id, 1, { title: 'Edited meanwhile' });
        },
      });
      await addArtifact(db(), moving, a, {
        workUnitId: work.id,
        name: 'f.txt',
        mimeType: 'text/plain',
        body: Buffer.from('x'),
      });
      expect(await eventsOf(work.id, 'work.artifact_added')).toEqual([
        expect.objectContaining({ version: 2 }),
      ]);
    });
  });

  describe('closing an open review', () => {
    const closed = { outcome: 'cancelled' };

    it('says so and tells whoever asked, with the true reason, when the content changes', async () => {
      const a = await newOrg();
      const b = await join(a, 'b');
      const reviewer = await join(a, 'reviewer');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });

      await updateWorkUnit(db(), b, work.id, 1, { title: 'Changed' });

      expect((await getApproval(db(), a, review.id)).approval.status).toBe('cancelled');
      const after = await getWorkUnit(db(), a, work.id);
      expect(await eventsOf(work.id, 'approval.resolved')).toEqual([
        {
          version: after.version,
          payload: expect.objectContaining({ approval_id: review.id, ...closed }),
        },
      ]);
      const kinds = await kindsFor(a);
      expect(kinds).toContain('approval.outdated');
      // The reviewer did not lose access, so nothing may say that they did.
      expect(kinds).not.toContain('approval.closed');
      // Only reviews that really were cancelled by this change.
      expect(await kindsFor(reviewer)).not.toContain('approval.outdated');
    });

    it('does nothing for a review that still covers the work', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });
      await updateWorkUnit(db(), a, work.id, 1, { dueAt: new Date('2030-01-01T00:00:00.000Z') });
      expect(await eventsOf(work.id, 'approval.resolved')).toEqual([]);
    });

    it('says so when the work finishes, and tells whoever asked', async () => {
      const a = await newOrg();
      const b = await join(a, 'b');
      const reviewer = await join(a, 'reviewer');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });

      const stopped = await move(b, work.id, ['cancelled']);

      expect(await eventsOf(work.id, 'approval.resolved')).toEqual([
        {
          version: stopped.version,
          payload: expect.objectContaining({ approval_id: review.id, ...closed }),
        },
      ]);
      expect(await kindsFor(a)).toContain('approval.work_finished');
    });

    it('resolves a review once: reopening work does not cancel an approved one on the record', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer');
      const work = await createWorkUnit(db(), a, {
        title: 'W',
        completionCriteria: [{ kind: 'reviewer_approved' }],
      });
      await move(a, work.id, ['ready', 'running']);
      await move(a, work.id, ['verifying']);
      const current = await getWorkUnit(db(), a, work.id);
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: current.version,
        approverMembershipId: reviewer.membershipId,
      });
      await decideApproval(db(), reviewer, {
        approvalId: review.id,
        decision: 'approve',
        shownHash: review.actionHash,
      });
      await move(a, work.id, ['completed']);
      const done = await getWorkUnit(db(), a, work.id);
      await transitionWorkUnit(db(), a, {
        id: work.id,
        expectedVersion: done.version,
        to: 'ready',
        reason: 'Going round again',
      });

      expect((await getApproval(db(), a, review.id)).approval.status).toBe('cancelled');
      const resolved = await eventsOf(work.id, 'approval.resolved');
      expect(resolved.map((event) => event.payload.outcome)).toEqual(['approved']);
    });

    it('says so when a plan starts, with its own reason', async () => {
      const a = await newOrg();
      const carol = await join(a, 'carol');
      const reviewer = await join(a, 'reviewer');
      const work = await planned(a, reviewer);
      const asked = await getWorkUnit(db(), a, work.id);
      const manual = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: asked.version,
        approverMembershipId: carol.membershipId,
      });
      const run = runOf(a, work.id);
      await activities().prepareWork(run);
      await activities().requestReview(run);

      const resolved = await eventsOf(work.id, 'approval.resolved');
      expect(resolved).toEqual([
        {
          version: asked.version + 1,
          payload: expect.objectContaining({ approval_id: manual.id, ...closed }),
        },
      ]);
      const kinds = await kindsFor(a);
      expect(kinds).toContain('approval.superseded');
      expect(kinds).not.toContain('approval.closed');
    });
  });

  describe('history', () => {
    it('records the version each move started from, and lists moves in that order', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer');
      const work = await planned(a, reviewer);
      const run = runOf(a, work.id);
      await activities().prepareWork(run);
      await activities().requestReview(run);
      // One transaction moves it twice, so both rows carry the same time.
      await activities().markFailed(run);

      const { rows } = await su.query(
        `select from_version, from_status, to_status, occurred_at from work.work_transitions
         where work_unit_id = $1 order by from_version`,
        [work.id],
      );
      const last = rows.slice(-2) as Array<{
        from_version: number;
        from_status: string;
        to_status: string;
        occurred_at: Date;
      }>;
      expect(last.map((row) => [row.from_status, row.to_status])).toEqual([
        ['awaiting_approval', 'running'],
        ['running', 'failed'],
      ]);
      expect(last[0]?.occurred_at).toEqual(last[1]?.occurred_at);
      const failedAt = (await getWorkUnit(db(), a, work.id)).version;
      expect(last.map((row) => row.from_version)).toEqual([failedAt - 2, failedAt - 1]);

      const { history } = await getWorkDetail(db(), a, work.id);
      expect(history.slice(0, 2).map((row) => row.toStatus)).toEqual(['failed', 'running']);
    });
  });

  describe('repairing what migration 0004 left behind', () => {
    const repair = joinPath(
      repoRoot,
      'packages/database/migrations/0010_closed_review_notifications_security.sql',
    );

    it('stops reminding people of reviews that were closed, and leaves open ones alone', async () => {
      const a = await newOrg();
      const stale = await join(a, 'stale');
      const open = await join(a, 'open');
      const first = await createWorkUnit(db(), a, { title: 'Closed review' });
      const second = await createWorkUnit(db(), a, { title: 'Open review' });
      const closedReview = await requestWorkReview(db(), a, {
        workUnitId: first.id,
        expectedVersion: 1,
        approverMembershipId: stale.membershipId,
      });
      const openReview = await requestWorkReview(db(), a, {
        workUnitId: second.id,
        expectedVersion: 1,
        approverMembershipId: open.membershipId,
      });
      // What 0004 left: the approval closed, and its request still unread with a reminder due.
      await su.query(`update work.approvals set status = 'cancelled' where id = $1`, [
        closedReview.id,
      ]);

      const migrator = new pg.Client({ connectionString: urls.migrator() });
      await migrator.connect();
      try {
        await migrator.query('begin');
        for (const statement of readFileSync(repair, 'utf8').split('--> statement-breakpoint')) {
          await migrator.query(statement);
        }
        await migrator.query('commit');
      } finally {
        await migrator.end();
      }

      const notification = async (approvalId: string) =>
        (
          await su.query(
            `select read_at is not null as read, remind_at is not null as reminding
             from platform.notifications where target_ref = $1`,
            [`approval:${approvalId}`],
          )
        ).rows;
      expect(await notification(closedReview.id)).toEqual([{ read: true, reminding: false }]);
      expect(await notification(openReview.id)).toEqual([{ read: false, reminding: true }]);
    });
  });
});
