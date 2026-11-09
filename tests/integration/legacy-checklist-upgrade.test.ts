// WORK-07, ADR-024: an approval paused by one release can be decided after upgrading. A plan paused for
// review before 0208 holds the checklist that release's worker wrote as the service. 0208 left it as a
// 'pending' file with an 'unknown' / 'legacy/unknown' header, which hid it and made the paused review
// APPROVAL_STALE. 0532 requalifies exactly the files whose bytes are proven to be their own Work's
// checklist template, and nothing else. Real roles and real SQL; only the legacy rows are planted.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REVIEW_HOURS,
  acceptInvitation,
  createInvitation,
  createWorkUnit,
  decideApproval,
  getApproval,
  getWorkDetail,
  getWorkUnit,
  requestApproval,
  requestExecution,
  transitionWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { workReviewAction } from '@ensemus/domain/approval';
import type { WorkState } from '@ensemus/domain/work-unit';
import { createActivities } from '@ensemus/workflows/activities';
import { urls } from '../helpers/stack';

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
  async deleteForPurge(key: string) {
    this.objects.delete(key);
    return { transport: 'deleted' as const, capabilityVerified: true };
  }
  async isPhysicallyAbsent(key: string) {
    return !this.objects.has(key);
  }
}

type Kind = 'artifact_exists' | 'reviewer_approved';

const WORDS: Record<Kind, string> = {
  artifact_exists: 'Someone attaches the file that shows the result.',
  reviewer_approved: 'A reviewer approves this work as it stands.',
};
/** How the release that added 0004 worded a plan with no criteria. */
const OLDEST_EMPTY =
  '- [ ] Someone confirms the outcome was reached. No other evidence was asked for.';
/** How every later release before 0208 worded it. */
const LATER_EMPTY = '- [ ] The accountable owner confirms the outcome. No evidence was asked for.';

/** The checklist a release before 0208 wrote, line for line as its worker built it. */
function releaseChecklist(workId: string, kinds: readonly Kind[], empty = LATER_EMPTY) {
  return [
    '# Completion checklist',
    '',
    'Ensemus wrote this list. It has not checked any of this, and this file is not evidence.',
    'A person decides when this work is done.',
    '',
    `Work: ${workId}`,
    '',
    ...(kinds.length ? kinds.map((kind) => `- [ ] ${WORDS[kind]}`) : [empty]),
    '',
  ].join('\n');
}

const code = (name: string) => expect.objectContaining({ code: name });

describe('a checklist written before 0208, on work paused for review', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  const db = () => app.db;
  const store = new MemoryStore();
  const activities = () => createActivities({ database: db(), store });

  async function makeUser(label: string) {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query(
      'insert into identity.users (id, name, email, email_verified) values ($1, $2, $3, true)',
      [id, label, email],
    );
    return { id, email };
  }

  async function newOrg() {
    const user = await makeUser('legacy-owner');
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: 'Legacy checklist',
      commercialMode: 'byom',
    });
    return resolveTenantContext(db(), user.id, organizationId);
  }

  async function join(context: TenantContext, label: string) {
    const user = await makeUser(label);
    const { token } = await createInvitation(db(), context, { email: user.email, role: 'admin' });
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  async function move(context: TenantContext, id: string, statuses: WorkState[]) {
    for (const to of statuses) {
      const current = await getWorkUnit(db(), context, id);
      await transitionWorkUnit(db(), context, { id, expectedVersion: current.version, to });
    }
  }

  /** Work a plan run holds, as the old release's worker left it before writing its checklist. */
  async function heldByPlan(owner: TenantContext, kinds: Kind[], reviewer?: TenantContext) {
    const work = await createWorkUnit(db(), owner, {
      title: `Paused across a release ${randomUUID()}`,
      executionPlan: 'checklist',
      completionCriteria: kinds.map((kind) => ({ kind })),
    });
    await move(owner, work.id, ['ready']);
    await requestExecution(
      db(),
      owner,
      work.id,
      reviewer ? { reviewerMembershipId: reviewer.membershipId } : {},
    );
    const run = { organizationId: owner.organizationId, workUnitId: work.id, runId: randomUUID() };
    expect((await activities().prepareWork(run)).status).toBe('running');
    return { work, run };
  }

  /**
   * The rows a release before 0208 left for its worker's checklist, after 0208's own backfill: the
   * file with no creator, now 'pending', its catalog row and Work link, and the 'unknown' header 0208
   * wrote. No role can write that header any more, so they are planted the way a restore of such a
   * database loads them, with triggers off for this one transaction only.
   */
  async function plantLegacyChecklist(context: TenantContext, workUnitId: string, body: string) {
    const work = await getWorkUnit(db(), context, workUnitId);
    const id = randomUUID();
    const key = `${context.organizationId}/artifacts/${id}`;
    const bytes = Buffer.from(body);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    try {
      await su.query('begin');
      await su.query('set local session_replication_role = replica');
      await su.query("select set_config('app.organization_id',$1,true)", [context.organizationId]);
      await su.query(
        `insert into work.artifacts (organization_id, id, name, object_key, sha256, mime_type,
           size_bytes, classification, provenance_state, created_by_membership_id)
         values ($1, $2, 'completion-checklist.md', $3, $4, 'text/markdown', $5, $6, 'pending', null)`,
        [context.organizationId, id, key, sha256, bytes.length, work.classification],
      );
      await su.query(
        'insert into work.work_artifacts (organization_id, work_unit_id, artifact_id) values ($1, $2, $3)',
        [context.organizationId, workUnitId, id],
      );
      await su.query(
        `insert into knowledge.artifact_acl_catalog (organization_id, artifact_id, sha256,
           classification, size_bytes, provenance_state, alive)
         values ($1, $2, $3, $4, $5, 'pending', true)`,
        [context.organizationId, id, sha256, work.classification, bytes.length],
      );
      await su.query(
        `insert into knowledge.artifact_work_links (organization_id, artifact_id, work_unit_id)
         values ($1, $2, $3)`,
        [context.organizationId, id, workUnitId],
      );
      await su.query(
        `insert into knowledge.artifact_lineage (organization_id, artifact_id, work_unit_id, object_key,
           artifact_sha256, size_bytes, classification, execution_kind, executor_ref,
           inventory_complete, state, write_id, generation, write_state)
         values ($1, $2, $3, $4, $5, $6, $7, 'unknown', 'legacy/unknown', false, 'pending',
           gen_random_uuid(), 1, 'unknown')`,
        [context.organizationId, id, workUnitId, key, sha256, bytes.length, work.classification],
      );
      await su.query('commit');
    } catch (error) {
      await su.query('rollback');
      throw error;
    } finally {
      await su.end();
    }
    await store.put(key, bytes);
    return id;
  }

  /** The review the old release's worker asked for: its reviewer, its run, and the files it held. */
  async function pausedReview(
    owner: TenantContext,
    reviewer: TenantContext,
    run: { workUnitId: string; runId: string },
    artifactIds: string[],
  ) {
    const work = await getWorkUnit(db(), owner, run.workUnitId);
    const requested = await requestApproval(db(), createServiceContext(owner.organizationId), {
      workUnitId: run.workUnitId,
      action: workReviewAction(work, artifactIds),
      approverMembershipId: reviewer.membershipId,
      requestedByMembershipId: owner.membershipId,
      runId: run.runId,
      expiresAt: new Date(Date.now() + REVIEW_HOURS * 60 * 60 * 1000),
    });
    expect((await getWorkUnit(db(), owner, run.workUnitId)).status).toBe('awaiting_approval');
    return requested;
  }

  const fileIds = async (context: TenantContext, workUnitId: string) =>
    (await getWorkDetail(db(), context, workUnitId)).files.map((file) => file.id);

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    await app?.close();
    await auth?.end();
  });

  it('is requalified, so the paused review is decided and the work reaches done', async () => {
    const owner = await newOrg();
    const reviewer = await join(owner, 'legacy-reviewer');
    const { work, run } = await heldByPlan(owner, ['reviewer_approved'], reviewer);
    const checklist = await plantLegacyChecklist(
      owner,
      work.id,
      releaseChecklist(work.id, ['reviewer_approved']),
    );
    const review = await pausedReview(owner, reviewer, run, [checklist]);

    // The upgraded worker resumes the old run and finds that run's own request, not a new one.
    expect((await activities().requestReview(run)).approvalId).toBe(review.id);
    // Both the owner and the reviewer see the file the review covers.
    expect(await fileIds(owner, work.id)).toEqual([checklist]);
    expect(await fileIds(reviewer, work.id)).toEqual([checklist]);

    await decideApproval(db(), reviewer, {
      approvalId: review.id,
      decision: 'approve',
      shownHash: review.actionHash,
    });
    expect((await getApproval(db(), owner, review.id)).approval.status).toBe('approved');
    expect((await getWorkUnit(db(), owner, work.id)).status).toBe('running');

    // The run carries on to checking, and the approved review still covers what the work holds.
    expect(await activities().verifyAndComplete(run)).toBe('verifying');
    expect((await getApproval(db(), owner, review.id)).approval.status).toBe('approved');
    const checking = await getWorkUnit(db(), owner, work.id);
    const done = await transitionWorkUnit(db(), owner, {
      id: work.id,
      expectedVersion: checking.version,
      to: 'completed',
    });
    expect(done.status).toBe('completed');
    expect(await fileIds(owner, work.id)).toEqual([checklist]);
  });

  it('is requalified in either wording a release used for a plan with no criteria', async () => {
    const owner = await newOrg();
    const oldest = await heldByPlan(owner, []);
    const later = await heldByPlan(owner, []);
    const oldestFile = await plantLegacyChecklist(
      owner,
      oldest.work.id,
      releaseChecklist(oldest.work.id, [], OLDEST_EMPTY),
    );
    const laterFile = await plantLegacyChecklist(
      owner,
      later.work.id,
      releaseChecklist(later.work.id, [], LATER_EMPTY),
    );
    expect(await fileIds(owner, oldest.work.id)).toEqual([oldestFile]);
    expect(await fileIds(owner, later.work.id)).toEqual([laterFile]);
  });

  describe('is not requalified when its bytes are not its own Work’s checklist', () => {
    it('keeps a tampered checklist hidden, so the paused review stays refused', async () => {
      const owner = await newOrg();
      const reviewer = await join(owner, 'legacy-reviewer');
      const { work, run } = await heldByPlan(owner, ['reviewer_approved'], reviewer);
      const tampered = await plantLegacyChecklist(
        owner,
        work.id,
        `${releaseChecklist(work.id, ['reviewer_approved'])}- [x] Already approved.\n`,
      );
      const review = await pausedReview(owner, reviewer, run, [tampered]);

      expect(await fileIds(owner, work.id)).toEqual([]);
      expect(await fileIds(reviewer, work.id)).toEqual([]);
      await expect(
        decideApproval(db(), reviewer, {
          approvalId: review.id,
          decision: 'approve',
          shownHash: review.actionHash,
        }),
      ).rejects.toEqual(code('APPROVAL_STALE'));
      expect((await getApproval(db(), owner, review.id)).approval.status).toBe('pending');
      expect((await getWorkUnit(db(), owner, work.id)).status).toBe('awaiting_approval');
    });

    it('keeps hidden a checklist that names another Work', async () => {
      const owner = await newOrg();
      const { work } = await heldByPlan(owner, ['reviewer_approved'], await join(owner, 'r'));
      const other = await createWorkUnit(db(), owner, {
        title: 'Another',
        executionPlan: 'checklist',
      });
      await plantLegacyChecklist(owner, work.id, releaseChecklist(other.id, ['reviewer_approved']));
      expect(await fileIds(owner, work.id)).toEqual([]);
    });

    it('keeps hidden a checklist whose criteria no longer match its Work', async () => {
      const owner = await newOrg();
      const { work } = await heldByPlan(owner, ['reviewer_approved'], await join(owner, 'r'));
      await plantLegacyChecklist(
        owner,
        work.id,
        releaseChecklist(work.id, ['artifact_exists', 'reviewer_approved']),
      );
      expect(await fileIds(owner, work.id)).toEqual([]);
    });

    it('keeps hidden the same bytes on work no plan runs', async () => {
      const owner = await newOrg();
      const work = await createWorkUnit(db(), owner, { title: 'By hand' });
      await plantLegacyChecklist(owner, work.id, releaseChecklist(work.id, [], LATER_EMPTY));
      expect(await fileIds(owner, work.id)).toEqual([]);
    });
  });
});
