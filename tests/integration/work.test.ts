// WORK-01 to WORK-05, ID-02, LIFE-01, UX-15, UX-16, QA-001 to QA-007, Gate B. Real roles, real SQL.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addArtifact,
  addDependency,
  assignContributor,
  createClient,
  createInvitation,
  createTeam,
  createWorkUnit,
  decideApproval,
  deleteArtifact,
  disableMember,
  expireApproval,
  getApproval,
  getWorkDetail,
  getWorkUnit,
  listClients,
  listMyNotifications,
  listMyPendingApprovals,
  listWorkUnits,
  readArtifact,
  requestApproval,
  revokeInvitation,
  sendDueReminders,
  setMemberRole,
  setOwner,
  setTeamParent,
  transitionWorkUnit,
  updateWorkUnit,
  verifyApprovalForExecution,
  type ObjectStore,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { actionHash, type ProposedAction } from '@ensemus/domain/approval';
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
}

const code = (name: string) => expect.objectContaining({ code: name });

describe('work', () => {
  let app: ReturnType<typeof openAppDatabase>;
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

  async function join(context: TenantContext, label: string, role: 'admin' | 'member' = 'member') {
    const user = await makeUser(label);
    const { token } = await createInvitation(db(), context, { email: user.email, role });
    await acceptInvitation(db(), { token, userId: user.id, email: user.email });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  async function newOrg(label = 'org') {
    const user = await makeUser(`${label}-owner`);
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: label,
      commercialMode: 'byom',
    });
    return resolveTenantContext(db(), user.id, organizationId);
  }

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    await app?.close();
    await auth?.end();
  });

  describe('tenant isolation', () => {
    it('hides a Work Unit from another tenant, even with its exact ID (QA-001)', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'Private to A' });
      await expect(getWorkUnit(db(), b, work.id)).rejects.toEqual(code('NOT_FOUND'));
      expect((await listWorkUnits(db(), b)).items).toEqual([]);
    });

    it('keeps same-named clients apart (QA-002)', async () => {
      const a = await newOrg();
      const b = await newOrg();
      await createClient(db(), a, { displayName: 'Acme Ltd' });
      await createClient(db(), b, { displayName: 'Acme Ltd' });
      const [fromA] = await listClients(db(), a);
      const [fromB] = await listClients(db(), b);
      expect(await listClients(db(), a)).toHaveLength(1);
      expect(fromA?.id).not.toBe(fromB?.id);
    });

    it('cannot link work across tenants, because the database refuses it', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const inA = await createWorkUnit(db(), a, { title: 'A' });
      const inB = await createWorkUnit(db(), b, { title: 'B' });
      await expect(
        addDependency(db(), a, { dependentId: inA.id, prerequisiteId: inB.id }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        withTenantTx(db(), a, (tx) =>
          tx.execute(
            `insert into work.work_dependencies (organization_id, prerequisite_id, dependent_id)
             values ('${a.organizationId}', '${inB.id}', '${inA.id}')`,
          ),
        ),
      ).rejects.toThrow();
    });
  });

  describe('versions', () => {
    it('rejects a stale edit instead of overwriting (Gate B)', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'First' });
      const updated = await updateWorkUnit(db(), a, work.id, 1, { title: 'Second' });
      expect(updated.version).toBe(2);
      await expect(updateWorkUnit(db(), a, work.id, 1, { title: 'Stale' })).rejects.toEqual(
        code('VERSION_CONFLICT'),
      );
      expect((await getWorkUnit(db(), a, work.id)).title).toBe('Second');
    });

    it('lets exactly one of two simultaneous edits win', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'Race' });
      const results = await Promise.allSettled([
        updateWorkUnit(db(), a, work.id, 1, { title: 'One' }),
        updateWorkUnit(db(), a, work.id, 1, { title: 'Two' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await getWorkUnit(db(), a, work.id)).version).toBe(2);
    });

    it('rejects a stale status change', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await transitionWorkUnit(db(), a, { id: work.id, expectedVersion: 1, to: 'ready' });
      await expect(
        transitionWorkUnit(db(), a, { id: work.id, expectedVersion: 1, to: 'running' }),
      ).rejects.toEqual(code('VERSION_CONFLICT'));
    });
  });

  describe('dependencies', () => {
    it('rejects a direct cycle (QA-004)', async () => {
      const a = await newOrg();
      const x = await createWorkUnit(db(), a, { title: 'X' });
      const y = await createWorkUnit(db(), a, { title: 'Y' });
      await addDependency(db(), a, { dependentId: y.id, prerequisiteId: x.id });
      await expect(
        addDependency(db(), a, { dependentId: x.id, prerequisiteId: y.id }),
      ).rejects.toEqual(code('DEPENDENCY_CYCLE'));
    });

    it('rejects a long cycle and a self-edge', async () => {
      const a = await newOrg();
      const [x, y, z] = await Promise.all(
        ['X', 'Y', 'Z'].map((title) => createWorkUnit(db(), a, { title })),
      );
      await addDependency(db(), a, { dependentId: y!.id, prerequisiteId: x!.id });
      await addDependency(db(), a, { dependentId: z!.id, prerequisiteId: y!.id });
      await expect(
        addDependency(db(), a, { dependentId: x!.id, prerequisiteId: z!.id }),
      ).rejects.toEqual(code('DEPENDENCY_CYCLE'));
      await expect(
        addDependency(db(), a, { dependentId: x!.id, prerequisiteId: x!.id }),
      ).rejects.toEqual(code('DEPENDENCY_CYCLE'));
    });

    it('cannot form a cycle from simultaneous opposite inserts, repeated (QA-005)', async () => {
      const a = await newOrg();
      for (let i = 0; i < 12; i++) {
        const x = await createWorkUnit(db(), a, { title: `X${i}` });
        const y = await createWorkUnit(db(), a, { title: `Y${i}` });
        const results = await Promise.allSettled([
          addDependency(db(), a, { dependentId: y.id, prerequisiteId: x.id }),
          addDependency(db(), a, { dependentId: x.id, prerequisiteId: y.id }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      }
    });

    it('holds work until its prerequisites complete, then releases it', async () => {
      const a = await newOrg();
      const first = await createWorkUnit(db(), a, { title: 'First' });
      const second = await createWorkUnit(db(), a, { title: 'Second' });
      await addDependency(db(), a, { dependentId: second.id, prerequisiteId: first.id });
      await expect(
        transitionWorkUnit(db(), a, { id: second.id, expectedVersion: 1, to: 'ready' }),
      ).rejects.toEqual(code('PREREQUISITES_INCOMPLETE'));

      let current = await transitionWorkUnit(db(), a, {
        id: first.id,
        expectedVersion: 1,
        to: 'ready',
      });
      for (const to of ['running', 'verifying', 'completed'] as const) {
        current = await transitionWorkUnit(db(), a, {
          id: first.id,
          expectedVersion: current.version,
          to,
        });
      }
      expect((await getWorkUnit(db(), a, second.id)).status).toBe('ready');
    });
  });

  describe('evidence', () => {
    async function toVerifying(context: TenantContext, id: string) {
      let version = 1;
      for (const to of ['ready', 'running', 'verifying'] as const) {
        version = (await transitionWorkUnit(db(), context, { id, expectedVersion: version, to }))
          .version;
      }
      return version;
    }

    it('will not complete without the required artifact (QA-006)', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, {
        title: 'Needs a file',
        completionCriteria: [{ kind: 'artifact_exists' }],
      });
      const version = await toVerifying(a, work.id);
      await expect(
        transitionWorkUnit(db(), a, { id: work.id, expectedVersion: version, to: 'completed' }),
      ).rejects.toEqual(code('EVIDENCE_MISSING'));
      await addArtifact(db(), store, a, {
        workUnitId: work.id,
        name: 'report.pdf',
        mimeType: 'application/pdf',
        body: Buffer.from('evidence'),
      });
      const done = await transitionWorkUnit(db(), a, {
        id: work.id,
        expectedVersion: version,
        to: 'completed',
      });
      expect(done.status).toBe('completed');
    });

    it('reopens completed work only with a reason, keeping history', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'Reopen me' });
      let version = await toVerifying(a, work.id);
      version = (
        await transitionWorkUnit(db(), a, {
          id: work.id,
          expectedVersion: version,
          to: 'completed',
        })
      ).version;
      await expect(
        transitionWorkUnit(db(), a, { id: work.id, expectedVersion: version, to: 'ready' }),
      ).rejects.toEqual(code('REASON_REQUIRED'));
      const reopened = await transitionWorkUnit(db(), a, {
        id: work.id,
        expectedVersion: version,
        to: 'ready',
        reason: 'Client changed scope',
      });
      expect(reopened.status).toBe('ready');
    });
  });

  describe('resource permissions', () => {
    it('lets a member read internal work but not change it', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const work = await createWorkUnit(db(), a, { title: 'Internal' });
      expect((await getWorkUnit(db(), member, work.id)).title).toBe('Internal');
      await expect(updateWorkUnit(db(), member, work.id, 1, { title: 'No' })).rejects.toEqual(
        code('FORBIDDEN'),
      );
    });

    it('hides confidential work from uninvolved members, in reads and lists', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const work = await createWorkUnit(db(), a, {
        title: 'Secret',
        classification: 'confidential',
      });
      await expect(getWorkUnit(db(), member, work.id)).rejects.toEqual(code('NOT_FOUND'));
      expect((await listWorkUnits(db(), member)).items).toEqual([]);
      await assignContributor(db(), a, { id: work.id, membershipId: member.membershipId });
      expect((await getWorkUnit(db(), member, work.id)).id).toBe(work.id);
      expect((await listWorkUnits(db(), member)).items.map((w) => w.id)).toEqual([work.id]);
    });

    it('keeps restricted work from the organization owner unless involved', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const work = await createWorkUnit(db(), member, {
        title: 'HR matter',
        classification: 'restricted',
      });
      await expect(getWorkUnit(db(), a, work.id)).rejects.toEqual(code('NOT_FOUND'));
      expect((await listWorkUnits(db(), a)).items).toEqual([]);
    });

    it('does not reveal a hidden prerequisite through a visible Work Unit', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const hidden = await createWorkUnit(db(), a, {
        title: 'Hidden',
        classification: 'restricted',
      });
      const open = await createWorkUnit(db(), a, { title: 'Open' });
      await addDependency(db(), a, { dependentId: open.id, prerequisiteId: hidden.id });
      const detail = await getWorkDetail(db(), member, open.id);
      expect(detail.prerequisites).toEqual([]);
    });

    it('keeps one accountable owner, who must be an active member', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'Owned' });
      await expect(
        setOwner(db(), a, {
          id: work.id,
          expectedVersion: 1,
          ownerMembershipId: b.membershipId,
        }),
      ).rejects.toEqual(code('INVALID_INPUT'));
      const member = await join(a, 'member');
      const moved = await setOwner(db(), a, {
        id: work.id,
        expectedVersion: 1,
        ownerMembershipId: member.membershipId,
      });
      expect(moved.ownerMembershipId).toBe(member.membershipId);
    });

    it('stops access once a member is disabled', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      await disableMember(db(), a, { membershipId: member.membershipId });
      await expect(resolveTenantContext(db(), member.userId, a.organizationId)).rejects.toThrow(
        'Not found or not permitted',
      );
    });
  });

  describe('approvals', () => {
    const action = (to = 'client@example.invalid'): ProposedAction => ({
      toolName: 'email.send',
      toolVersion: '1',
      targetRef: 'connection:abc',
      payload: { to: [to], subject: 'Kickoff' },
    });
    const hour = () => new Date(Date.now() + 60 * 60 * 1000);

    async function setup() {
      const a = await newOrg();
      const approver = await join(a, 'approver', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'Send it' });
      let version = 1;
      for (const to of ['ready', 'running'] as const) {
        version = (await transitionWorkUnit(db(), a, { id: work.id, expectedVersion: version, to }))
          .version;
      }
      return { a, approver, work };
    }

    it('pauses the work and tells the approver', async () => {
      const { a, approver, work } = await setup();
      const { id } = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
      expect((await listMyPendingApprovals(db(), approver)).map((p) => p.id)).toEqual([id]);
      expect((await listMyNotifications(db(), approver))[0]?.targetRef).toBe(`approval:${id}`);
    });

    it('resumes the work when approved, and clears the notification', async () => {
      const { a, approver, work } = await setup();
      const created = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      await decideApproval(db(), approver, {
        approvalId: created.id,
        decision: 'approve',
        shownHash: created.actionHash,
      });
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('running');
      expect(await listMyPendingApprovals(db(), approver)).toEqual([]);
      expect((await listMyNotifications(db(), approver))[0]?.readAt).toBeTruthy();
    });

    it('cancels the work when denied', async () => {
      const { a, approver, work } = await setup();
      const created = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      await decideApproval(db(), approver, {
        approvalId: created.id,
        decision: 'deny',
        shownHash: created.actionHash,
      });
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('cancelled');
    });

    it('refuses a decision on a changed action (QA-007)', async () => {
      const { a, approver, work } = await setup();
      const created = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      await expect(
        decideApproval(db(), approver, {
          approvalId: created.id,
          decision: 'approve',
          shownHash: actionHash(action('attacker@example.invalid')),
        }),
      ).rejects.toEqual(code('APPROVAL_HASH_MISMATCH'));
    });

    it('voids an approval at execution if the action changed afterwards (QA-007)', async () => {
      const { a, approver, work } = await setup();
      const created = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      await decideApproval(db(), approver, {
        approvalId: created.id,
        decision: 'approve',
        shownHash: created.actionHash,
      });
      expect(
        await verifyApprovalForExecution(db(), a, { approvalId: created.id, action: action() }),
      ).toEqual({ ok: true });
      expect(
        await verifyApprovalForExecution(db(), a, {
          approvalId: created.id,
          action: action('attacker@example.invalid'),
        }),
      ).toEqual({ ok: false, reason: 'HASH_MISMATCH' });
    });

    it('cannot have its bound action edited, even by direct SQL as the app role', async () => {
      const { a, approver, work } = await setup();
      const created = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      for (const column of [
        "action = '{}'",
        "action_hash = 'x'",
        'approver_membership_id = null',
      ]) {
        await expect(
          withTenantTx(db(), a, (tx) =>
            tx.execute(`update work.approvals set ${column} where id = '${created.id}'`),
          ),
          column,
        ).rejects.toThrow();
      }
    });

    it('refuses the wrong person, a repeat decision and self-approval', async () => {
      const { a, approver, work } = await setup();
      const other = await join(a, 'other', 'admin');
      const created = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      const attempt = (who: TenantContext) =>
        decideApproval(db(), who, {
          approvalId: created.id,
          decision: 'approve',
          shownHash: created.actionHash,
        });
      await expect(attempt(other)).rejects.toEqual(code('APPROVAL_WRONG_APPROVER'));
      await attempt(approver);
      await expect(attempt(approver)).rejects.toEqual(code('APPROVAL_NOT_PENDING'));

      const second = await requestApproval(db(), approver, {
        workUnitId: work.id,
        action: action('x@example.invalid'),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      await expect(
        decideApproval(db(), approver, {
          approvalId: second.id,
          decision: 'approve',
          shownHash: second.actionHash,
        }),
      ).rejects.toEqual(code('APPROVAL_SELF_APPROVAL'));
    });

    it('expires, cancelling the work, and then refuses decisions', async () => {
      const { a, approver, work } = await setup();
      const created = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        decideApproval(db(), approver, {
          approvalId: created.id,
          decision: 'approve',
          shownHash: created.actionHash,
        }),
      ).rejects.toEqual(code('APPROVAL_EXPIRED'));
      expect(await expireApproval(db(), a, { approvalId: created.id })).toBe(true);
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('cancelled');
    });

    it('will not assign an approver who cannot see the work', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const work = await createWorkUnit(db(), a, { title: 'R', classification: 'restricted' });
      await expect(
        requestApproval(db(), a, {
          workUnitId: work.id,
          action: action(),
          approverMembershipId: member.membershipId,
          expiresAt: hour(),
        }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('hides an approval from someone who cannot see its work', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const approver = await join(a, 'approver', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'C', classification: 'confidential' });
      const created = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      await expect(getApproval(db(), member, created.id)).rejects.toEqual(code('NOT_FOUND'));
    });

    it('sends reminders up to a limit, and only for unread items', async () => {
      const { a, approver, work } = await setup();
      await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        expiresAt: hour(),
      });
      const future = new Date(Date.now() + 5 * 60 * 60 * 1000);
      expect(await sendDueReminders(db(), a, future)).toBe(1);
      expect((await listMyNotifications(db(), approver))[0]?.remindersSent).toBe(1);
      expect(await sendDueReminders(db(), a, future)).toBe(0);
    });
  });

  describe('invitations', () => {
    it('joins the stated organization only, in the stated role', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const user = await makeUser('invitee');
      const { token } = await createInvitation(db(), a, { email: user.email, role: 'admin' });
      await acceptInvitation(db(), { token, userId: user.id, email: user.email });
      const context = await resolveTenantContext(db(), user.id, a.organizationId);
      expect(context.role).toBe('admin');
      await expect(resolveTenantContext(db(), user.id, b.organizationId)).rejects.toThrow();
    });

    it('works once', async () => {
      const a = await newOrg();
      const user = await makeUser('invitee');
      const { token } = await createInvitation(db(), a, { email: user.email });
      await acceptInvitation(db(), { token, userId: user.id, email: user.email });
      await expect(
        acceptInvitation(db(), { token, userId: user.id, email: user.email }),
      ).rejects.toEqual(code('INVITATION_INVALID'));
    });

    it('refuses a guessed token, the wrong person and a revoked invitation alike', async () => {
      const a = await newOrg();
      const invited = await makeUser('invited');
      const stranger = await makeUser('stranger');
      const { id, token } = await createInvitation(db(), a, { email: invited.email });
      const bad = code('INVITATION_INVALID');
      await expect(
        acceptInvitation(db(), { token: 'guess', userId: invited.id, email: invited.email }),
      ).rejects.toEqual(bad);
      await expect(
        acceptInvitation(db(), { token, userId: stranger.id, email: stranger.email }),
      ).rejects.toEqual(bad);
      await revokeInvitation(db(), a, { invitationId: id });
      await expect(
        acceptInvitation(db(), { token, userId: invited.id, email: invited.email }),
      ).rejects.toEqual(bad);
    });

    it('stores only a hash of the token', async () => {
      const a = await newOrg();
      const { token } = await createInvitation(db(), a, { email: 'x@example.invalid' });
      const rows = await withTenantTx(db(), a, (tx) =>
        tx.execute('select token_hash from org.invitations'),
      );
      expect(JSON.stringify(rows.rows)).not.toContain(token);
    });

    it('lets only admins and owners invite', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      await expect(createInvitation(db(), member, { email: 'y@example.invalid' })).rejects.toEqual(
        code('FORBIDDEN'),
      );
    });
  });

  describe('members and teams', () => {
    it('never loses the last owner', async () => {
      const a = await newOrg();
      await expect(
        setMemberRole(db(), a, { membershipId: a.membershipId, role: 'member' }),
      ).rejects.toEqual(code('LAST_OWNER'));
      await expect(disableMember(db(), a, { membershipId: a.membershipId })).rejects.toEqual(
        code('LAST_OWNER'),
      );
    });

    it('stops an admin from promoting anyone to owner', async () => {
      const a = await newOrg();
      const admin = await join(a, 'admin', 'admin');
      await expect(
        setMemberRole(db(), admin, { membershipId: admin.membershipId, role: 'owner' }),
      ).rejects.toEqual(code('FORBIDDEN'));
    });

    it('rejects a team hierarchy cycle', async () => {
      const a = await newOrg();
      const parent = await createTeam(db(), a, { name: 'Parent' });
      const child = await createTeam(db(), a, { name: 'Child', parentId: parent!.id });
      await expect(
        setTeamParent(db(), a, { teamId: parent!.id, parentId: child!.id }),
      ).rejects.toEqual(code('TEAM_CYCLE'));
      await expect(
        setTeamParent(db(), a, { teamId: parent!.id, parentId: parent!.id }),
      ).rejects.toEqual(code('TEAM_CYCLE'));
    });
  });

  describe('artifacts and deletion', () => {
    const upload = (context: TenantContext, store: ObjectStore, workUnitId: string) =>
      addArtifact(db(), store, context, {
        workUnitId,
        name: 'file.txt',
        mimeType: 'text/plain',
        body: Buffer.from('content'),
      });

    it('stores bytes under the tenant, and returns them intact', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await upload(a, store, work.id);
      expect([...store.objects.keys()][0]).toContain(a.organizationId);
      const read = await readArtifact(db(), store, a, { workUnitId: work.id, artifactId: id });
      expect(read.body.toString()).toBe('content');
    });

    it('refuses altered bytes rather than serving them', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await upload(a, store, work.id);
      store.objects.set([...store.objects.keys()][0]!, Buffer.from('tampered'));
      await expect(
        readArtifact(db(), store, a, { workUnitId: work.id, artifactId: id }),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('blocks reading from another tenant', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await upload(a, store, work.id);
      await expect(
        readArtifact(db(), store, b, { workUnitId: work.id, artifactId: id }),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('inherits the classification of its work', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'C', classification: 'confidential' });
      await upload(a, store, work.id);
      const rows = await withTenantTx(db(), a, (tx) =>
        tx.execute('select classification from work.artifacts'),
      );
      expect(rows.rows[0]?.classification).toBe('confidential');
    });

    it('deletes: blocks access, removes bytes and leaves a tombstone', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await upload(a, store, work.id);
      await deleteArtifact(db(), store, a, { workUnitId: work.id, artifactId: id });
      expect(store.objects.size).toBe(0);
      await expect(
        readArtifact(db(), store, a, { workUnitId: work.id, artifactId: id }),
      ).rejects.toEqual(code('NOT_FOUND'));
      const rows = await withTenantTx(db(), a, (tx) =>
        tx.execute(`select target_id from platform.tombstones where target_id = '${id}'`),
      );
      expect(rows.rows).toHaveLength(1);
    });

    it('stays blocked even if removing the bytes fails', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await upload(a, store, work.id);
      const broken: ObjectStore = {
        put: store.put.bind(store),
        get: store.get.bind(store),
        delete: async () => {
          throw new Error('storage down');
        },
      };
      await expect(
        deleteArtifact(db(), broken, a, { workUnitId: work.id, artifactId: id }),
      ).rejects.toThrow('storage down');
      await expect(
        readArtifact(db(), store, a, { workUnitId: work.id, artifactId: id }),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('keeps tombstones append-only', async () => {
      const a = await newOrg();
      await expect(
        withTenantTx(db(), a, (tx) => tx.execute('delete from platform.tombstones')),
      ).rejects.toThrow();
    });
  });

  describe('outbox', () => {
    it('writes state and its event together, or neither', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'Evented' });
      const events = await withTenantTx(db(), a, (tx) =>
        tx.execute(`select e.event_type, o.state from platform.domain_events e
          join platform.outbox_events o on o.event_id = e.id and o.organization_id = e.organization_id
          where e.aggregate_id = '${work.id}'`),
      );
      expect(events.rows).toEqual([{ event_type: 'work.created', state: 'queued' }]);

      // A failed transition rolls back, leaving no event behind.
      await expect(
        transitionWorkUnit(db(), a, { id: work.id, expectedVersion: 1, to: 'completed' }),
      ).rejects.toEqual(code('INVALID_TRANSITION'));
      const after = await withTenantTx(db(), a, (tx) =>
        tx.execute(`select count(*)::int as n from platform.domain_events
          where aggregate_id = '${work.id}'`),
      );
      expect(after.rows[0]?.n).toBe(1);
    });

    it('never puts free text in an event payload', async () => {
      const a = await newOrg();
      const secretTitle = `CANARY-${randomUUID()}`;
      const work = await createWorkUnit(db(), a, { title: secretTitle, objective: secretTitle });
      const events = await withTenantTx(db(), a, (tx) =>
        tx.execute(`select payload from platform.domain_events where aggregate_id = '${work.id}'`),
      );
      expect(JSON.stringify(events.rows)).not.toContain(secretTitle);
    });
  });
});
