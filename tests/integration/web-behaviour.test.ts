// What the forms and pages rely on from the services, against the real database roles: a repeat of one
// rendered form, the size refusal, reminders for an approver who looked and did not decide, what team
// structure shows to whom, what a work list says, and what a live page can notice (UX-13, UX-15, UX-17).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addArtifact,
  addTeamMember,
  countUnread,
  createClient,
  createInvitation,
  createProject,
  createTeam,
  createWorkUnit,
  decideApproval,
  deleteArtifact,
  getApproval,
  getWorkDetail,
  getWorkFollowState,
  getWorkUnit,
  listClients,
  listMyNotifications,
  listProjects,
  listTeams,
  listWorkOverview,
  markRead,
  requestApproval,
  requestWorkReview,
  sendDueReminders,
  transitionWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import {
  createOrganization,
  listMyOrganizations,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import { MAX_FILE_BYTES, type WorkState } from '@ensemus/domain/work-unit';
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
}

const code = (name: string) => expect.objectContaining({ code: name });
const DAY_MS = 24 * 60 * 60 * 1000;

describe('web behaviour', () => {
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
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
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

  async function move(context: TenantContext, id: string, ...statuses: WorkState[]) {
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

  async function reviewOf(asker: TenantContext, approver: TenantContext, workUnitId: string) {
    const { version } = await getWorkUnit(db(), asker, workUnitId);
    await requestWorkReview(db(), asker, {
      workUnitId,
      expectedVersion: version,
      approverMembershipId: approver.membershipId,
    });
    const [notice] = await listMyNotifications(db(), approver);
    return notice as NonNullable<typeof notice>;
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

  describe('one rendered form, sent again', () => {
    it('makes one piece of work when the same thing is sent twice', async () => {
      const org = await newOrg();
      const requestKey = randomUUID();
      const first = await createWorkUnit(db(), org, { title: 'Same', requestKey });
      const again = await createWorkUnit(db(), org, { title: 'Same', requestKey });
      expect(again.id).toBe(first.id);
      expect((await listWorkOverview(db(), org)).items).toHaveLength(1);
    });

    it('keeps what was typed when the same form is sent again with something else', async () => {
      const org = await newOrg();
      const requestKey = randomUUID();
      const first = await createWorkUnit(db(), org, { title: 'A', requestKey });
      const second = await createWorkUnit(db(), org, { title: 'B', requestKey });
      expect(second.id).not.toBe(first.id);
      expect(second.title).toBe('B');
      expect((await getWorkUnit(db(), org, first.id)).title).toBe('A');
      // That second form, sent twice, is still one piece of work.
      const repeat = await createWorkUnit(db(), org, { title: 'B', requestKey });
      expect(repeat.id).toBe(second.id);
    });

    it('notices a change to anything else on the form, not only the title', async () => {
      const org = await newOrg();
      const requestKey = randomUUID();
      const first = await createWorkUnit(db(), org, {
        title: 'A',
        objective: 'One',
        requestKey,
      });
      const second = await createWorkUnit(db(), org, {
        title: 'A',
        objective: 'Two',
        requestKey,
      });
      expect(second.id).not.toBe(first.id);
    });

    it('makes a second organization when the same form is sent with another name', async () => {
      const user = await makeUser('founder');
      const requestKey = randomUUID();
      const create = (name: string) =>
        createOrganization(db(), { userId: user.id, name, commercialMode: 'byom', requestKey });
      const first = await create('Northwind');
      expect((await create('Northwind')).organizationId).toBe(first.organizationId);
      const second = await create('Southwind');
      expect(second.organizationId).not.toBe(first.organizationId);
      const names = (await listMyOrganizations(db(), user.id)).map((o) => o.name).sort();
      expect(names).toEqual(['Northwind', 'Southwind']);
    });

    it('adds one client, one project and one team, and tells different ones apart', async () => {
      const org = await newOrg();
      const requestKey = randomUUID();

      const client = await createClient(db(), org, { displayName: 'Acme', requestKey });
      expect((await createClient(db(), org, { displayName: 'Acme', requestKey }))?.id).toBe(
        client?.id,
      );
      await createClient(db(), org, { displayName: 'Globex', requestKey });
      expect((await listClients(db(), org)).map((c) => c.displayName).sort()).toEqual([
        'Acme',
        'Globex',
      ]);

      const project = await createProject(db(), org, { name: 'Launch', requestKey });
      expect((await createProject(db(), org, { name: 'Launch', requestKey }))?.id).toBe(
        project?.id,
      );
      await createProject(db(), org, {
        name: 'Launch',
        clientId: client?.id as string,
        requestKey,
      });
      expect(await listProjects(db(), org)).toHaveLength(2);

      const team = await createTeam(db(), org, { name: 'Sales', requestKey });
      expect((await createTeam(db(), org, { name: 'Sales', requestKey }))?.id).toBe(team?.id);
      await createTeam(db(), org, { name: 'Sales', parentId: team?.id as string, requestKey });
      expect(await listTeams(db(), org)).toHaveLength(2);
    });

    it('does not let one person repeat onto what someone else made', async () => {
      const org = await newOrg();
      const member = await join(org, 'member', 'admin');
      const requestKey = randomUUID();
      const mine = await createClient(db(), org, { displayName: 'Acme', requestKey });
      const theirs = await createClient(db(), member, { displayName: 'Acme', requestKey });
      expect(theirs?.id).not.toBe(mine?.id);
    });

    it('attaches one file, even when the two posts race', async () => {
      const org = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), org, { title: 'With a file' });
      const upload = (text: string, requestKey: string) =>
        addArtifact(db(), store, org, {
          workUnitId: work.id,
          name: 'notes.txt',
          mimeType: 'text/plain',
          body: Buffer.from(text),
          requestKey,
        });
      const requestKey = randomUUID();
      const first = await upload('one', requestKey);
      expect((await upload('one', requestKey)).id).toBe(first.id);
      expect((await getWorkDetail(db(), org, work.id)).files).toHaveLength(1);

      const raced = randomUUID();
      const results = await Promise.all([upload('two', raced), upload('two', raced)]);
      expect(results[1].id).toBe(results[0].id);
      const { files } = await getWorkDetail(db(), org, work.id);
      expect(files).toHaveLength(2);
      expect(store.objects.size).toBe(2);
    });

    it('treats a different file from the same form as another file', async () => {
      const org = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), org, { title: 'Two files' });
      const requestKey = randomUUID();
      for (const text of ['one', 'two']) {
        await addArtifact(db(), store, org, {
          workUnitId: work.id,
          name: 'notes.txt',
          mimeType: 'text/plain',
          body: Buffer.from(text),
          requestKey,
        });
      }
      expect((await getWorkDetail(db(), org, work.id)).files).toHaveLength(2);
    });

    it('attaches the file again after it was deleted, as a new file', async () => {
      const org = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), org, { title: 'Gone, then back' });
      const requestKey = randomUUID();
      const upload = () =>
        addArtifact(db(), store, org, {
          workUnitId: work.id,
          name: 'notes.txt',
          mimeType: 'text/plain',
          body: Buffer.from('one'),
          requestKey,
        });
      const first = await upload();
      await deleteArtifact(db(), store, org, { workUnitId: work.id, artifactId: first.id });
      const second = await upload();
      expect(second.id).not.toBe(first.id);
      const { files } = await getWorkDetail(db(), org, work.id);
      expect(files.map((file) => file.id)).toEqual([second.id]);
    });
  });

  describe('the size of a file', () => {
    const upload = async (body: Buffer) => {
      const org = await newOrg();
      const work = await createWorkUnit(db(), org, { title: 'Big' });
      return addArtifact(db(), new MemoryStore(), org, {
        workUnitId: work.id,
        name: 'big.bin',
        mimeType: 'application/octet-stream',
        body,
      });
    };

    it('says a file over the limit is too large', async () => {
      await expect(upload(Buffer.alloc(MAX_FILE_BYTES + 1))).rejects.toEqual(
        code('FILE_TOO_LARGE'),
      );
    });

    it('takes a file exactly at the limit', async () => {
      await expect(upload(Buffer.alloc(MAX_FILE_BYTES))).resolves.toBeDefined();
    });

    it('still calls an empty file a mistake', async () => {
      await expect(upload(Buffer.alloc(0))).rejects.toEqual(code('INVALID_INPUT'));
    });
  });

  describe('reminding an approver', () => {
    async function open() {
      const org = await newOrg();
      const approver = await join(org, 'approver', 'admin');
      const work = await createWorkUnit(db(), org, { title: 'Needs a look' });
      await move(org, work.id, 'ready');
      const notice = await reviewOf(org, approver, work.id);
      return { org, approver, work, notice };
    }
    const later = (days: number) => new Date(Date.now() + days * DAY_MS);

    it('reminds someone who opened it and did not decide, and it comes back unread', async () => {
      const { org, approver, notice } = await open();
      await markRead(db(), approver, notice.id);
      expect(await countUnread(db(), approver)).toBe(0);

      expect(await sendDueReminders(db(), org, later(1))).toBe(1);
      const [back] = await listMyNotifications(db(), approver);
      expect(back).toEqual(
        expect.objectContaining({ id: notice.id, readAt: null, remindersSent: 1 }),
      );
      expect(await countUnread(db(), approver)).toBe(1);
    });

    it('stops at the limit, however often it is opened', async () => {
      const { org, approver, notice } = await open();
      // All inside the 3 days a review has, a day apart, and the first a few hours after it was asked.
      for (const [day, expected] of [
        [0.25, 1],
        [1.25, 1],
        [2.25, 1],
        [2.9, 0],
      ] as const) {
        await markRead(db(), approver, notice.id);
        expect(await sendDueReminders(db(), org, later(day))).toBe(expected);
      }
    });

    it('stops once it is decided, for someone who had already opened it', async () => {
      const { org, approver, notice, work } = await open();
      await markRead(db(), approver, notice.id);
      const approvalId = notice.targetRef.replace('approval:', '');
      const { approval } = await getApproval(db(), approver, approvalId);
      await decideApproval(db(), approver, {
        approvalId,
        decision: 'approve',
        shownHash: approval.actionHash,
      });
      expect(await sendDueReminders(db(), org, later(1))).toBe(0);
      expect(await countUnread(db(), approver)).toBe(0);
      expect((await getWorkUnit(db(), org, work.id)).status).toBe('ready');
    });

    it('does not raise a request left over from before this rule, once decided', async () => {
      // Deciding used to leave the next reminder in place on a row that had already been read.
      const { org, approver, notice } = await open();
      await markRead(db(), approver, notice.id);
      const approvalId = notice.targetRef.replace('approval:', '');
      const { approval } = await getApproval(db(), approver, approvalId);
      await decideApproval(db(), approver, {
        approvalId,
        decision: 'approve',
        shownHash: approval.actionHash,
      });
      const su = new pg.Client({ connectionString: urls.superuser() });
      await su.connect();
      await su.query(
        `update platform.notifications set remind_at = now() - interval '1 hour' where id = $1`,
        [notice.id],
      );
      await su.end();
      expect(await sendDueReminders(db(), org, later(1))).toBe(0);
    });

    it('does not raise a request that has run out', async () => {
      const { org, approver, notice } = await open();
      await markRead(db(), approver, notice.id);
      // A review has 3 days, and the periodic check closes it some time after that.
      expect(await sendDueReminders(db(), org, later(4))).toBe(0);
      expect(await countUnread(db(), approver)).toBe(0);
    });
  });

  describe('team structure', () => {
    async function teams() {
      const org = await newOrg();
      const admin = await join(org, 'admin', 'admin');
      const member = await join(org, 'member');
      const colleague = await join(org, 'colleague');
      const other = await join(org, 'other');
      const mine = await createTeam(db(), org, { name: 'Mine' });
      const theirs = await createTeam(db(), org, { name: 'Theirs' });
      for (const [team, person] of [
        [mine, member],
        [mine, colleague],
        [theirs, other],
      ] as const) {
        await addTeamMember(db(), org, {
          teamId: team?.id as string,
          membershipId: person.membershipId,
        });
      }
      return { org, admin, member, colleague, other };
    }

    it('shows every team to everyone, and who is on it to those on it', async () => {
      const { member, colleague, other } = await teams();
      const seen = await listTeams(db(), member);
      expect(seen.map((team) => team.name)).toEqual(['Mine', 'Theirs']);
      const [mine, theirs] = seen;
      expect(mine?.members.map((m) => m.membershipId).sort()).toEqual(
        [member.membershipId, colleague.membershipId].sort(),
      );
      expect(mine?.memberCount).toBe(2);
      expect(mine?.membersHidden).toBe(false);
      expect(theirs?.members).toEqual([]);
      expect(theirs?.memberCount).toBe(1);
      expect(theirs?.membersHidden).toBe(true);
      expect(JSON.stringify(seen)).not.toContain(other.membershipId);
    });

    it.each(['org', 'admin'] as const)('shows everything to an organization %s', async (who) => {
      const world = await teams();
      const seen = await listTeams(db(), world[who]);
      expect(seen.map((team) => team.memberCount)).toEqual([2, 1]);
      expect(seen.map((team) => team.members.length)).toEqual([2, 1]);
      expect(seen.every((team) => !team.membersHidden)).toBe(true);
    });

    it('never carries an email address', async () => {
      const { org } = await teams();
      expect(JSON.stringify(await listTeams(db(), org))).not.toContain('@example.invalid');
    });
  });

  describe('the work list', () => {
    it('says who owns each item and how its evidence stands', async () => {
      const org = await newOrg('lister');
      const store = new MemoryStore();
      const member = await join(org, 'member-owner');
      const none = await createWorkUnit(db(), org, { title: 'None asked' });
      const file = await createWorkUnit(db(), org, {
        title: 'File asked',
        completionCriteria: [{ kind: 'artifact_exists' }],
      });
      const both = await createWorkUnit(db(), member, {
        title: 'Both asked',
        completionCriteria: [{ kind: 'artifact_exists' }, { kind: 'reviewer_approved' }],
      });
      await addArtifact(db(), store, org, {
        workUnitId: file.id,
        name: 'proof.txt',
        mimeType: 'text/plain',
        body: Buffer.from('proof'),
      });
      await addArtifact(db(), store, member, {
        workUnitId: both.id,
        name: 'proof.txt',
        mimeType: 'text/plain',
        body: Buffer.from('proof'),
      });

      const { items } = await listWorkOverview(db(), org);
      const row = (id: string) => items.find((item) => item.id === id);
      expect(row(none.id)?.ownerName).toBe('lister-owner');
      expect(row(both.id)?.ownerName).toBe('member-owner');
      expect(row(none.id)?.evidence.artifactCount).toBe(0);
      expect(row(file.id)?.evidence.artifactCount).toBe(1);
      expect(row(both.id)?.evidence).toEqual(
        expect.objectContaining({ artifactCount: 1, approvedReviewCount: 0 }),
      );
      // The same answer the work's own page gets.
      expect(row(both.id)?.evidence).toEqual((await getWorkDetail(db(), org, both.id)).evidence);
    });

    it('counts a review only while it covers what the work now holds', async () => {
      const org = await newOrg();
      const approver = await join(org, 'approver', 'admin');
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), org, {
        title: 'Reviewed',
        completionCriteria: [{ kind: 'reviewer_approved' }],
      });
      await move(org, work.id, 'ready');
      const notice = await reviewOf(org, approver, work.id);
      const approvalId = notice.targetRef.replace('approval:', '');
      const { approval } = await getApproval(db(), approver, approvalId);
      await decideApproval(db(), approver, {
        approvalId,
        decision: 'approve',
        shownHash: approval.actionHash,
      });
      const counted = async () =>
        (await listWorkOverview(db(), org)).items[0]?.evidence.approvedReviewCount;
      expect(await counted()).toBe(1);
      await addArtifact(db(), store, org, {
        workUnitId: work.id,
        name: 'late.txt',
        mimeType: 'text/plain',
        body: Buffer.from('late'),
      });
      expect(await counted()).toBe(0);
    });

    it('shows nothing it would not otherwise show', async () => {
      const org = await newOrg();
      const member = await join(org, 'member');
      await createWorkUnit(db(), org, { title: 'Secret', classification: 'restricted' });
      expect((await listWorkOverview(db(), member)).items).toEqual([]);
    });
  });

  describe('what a live page can notice', () => {
    it('sees a file and a decision that leave the version alone', async () => {
      const org = await newOrg();
      const approver = await join(org, 'approver', 'admin');
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), org, { title: 'Followed' });
      await move(org, work.id, 'ready');
      const follow = () => getWorkFollowState(db(), org, work.id);

      const start = await follow();
      expect(await follow()).toEqual(start);

      const file = await addArtifact(db(), store, org, {
        workUnitId: work.id,
        name: 'proof.txt',
        mimeType: 'text/plain',
        body: Buffer.from('proof'),
      });
      const withFile = await follow();
      expect(withFile.version).toBe(start.version);
      expect(withFile.evidence).not.toBe(start.evidence);

      const notice = await reviewOf(org, approver, work.id);
      const asked = await follow();
      expect(asked.evidence).not.toBe(withFile.evidence);

      const approvalId = notice.targetRef.replace('approval:', '');
      const { approval } = await getApproval(db(), approver, approvalId);
      await decideApproval(db(), approver, {
        approvalId,
        decision: 'approve',
        shownHash: approval.actionHash,
      });
      const decided = await follow();
      expect(decided.version).toBe(asked.version);
      expect(decided.evidence).not.toBe(asked.evidence);

      await deleteArtifact(db(), store, org, { workUnitId: work.id, artifactId: file.id });
      const removed = await follow();
      expect(removed.version).toBe(decided.version);
      expect(removed.evidence).not.toBe(decided.evidence);
    });

    it('gives the page and the stream the same answer, so a page does not refresh for nothing', async () => {
      const org = await newOrg();
      const work = await createWorkUnit(db(), org, { title: 'Agreed' });
      const detail = await getWorkDetail(db(), org, work.id);
      expect(detail.evidenceStamp).toBe((await getWorkFollowState(db(), org, work.id)).evidence);
    });

    it('is refused for someone who may not see the work', async () => {
      const org = await newOrg();
      const member = await join(org, 'member');
      const work = await createWorkUnit(db(), org, {
        title: 'Hidden',
        classification: 'restricted',
      });
      await expect(getWorkFollowState(db(), member, work.id)).rejects.toEqual(code('NOT_FOUND'));
      await expect(getWorkFollowState(db(), member, work.id, { evidence: false })).rejects.toEqual(
        code('NOT_FOUND'),
      );
    });

    it('hears of the version without asking about the evidence, for a stream that did not want it', async () => {
      const org = await newOrg();
      const work = await createWorkUnit(db(), org, { title: 'Plain' });
      const plain = () => getWorkFollowState(db(), org, work.id, { evidence: false });
      expect(await plain()).toEqual({ version: work.version, evidence: null });
      await move(org, work.id, 'ready');
      expect((await plain()).version).toBeGreaterThan(work.version);
    });

    it('notices a review running out, which only time changes', async () => {
      const org = await newOrg();
      const approver = await join(org, 'approver', 'admin');
      const work = await createWorkUnit(db(), org, { title: 'Timed' });
      await requestApproval(db(), org, {
        workUnitId: work.id,
        action: { toolName: 'x', toolVersion: '1', targetRef: null, payload: {} },
        approverMembershipId: approver.membershipId,
        expiresAt: new Date(Date.now() + 1_000),
      });
      const before = await getWorkFollowState(db(), org, work.id);
      await expect
        .poll(async () => (await getWorkFollowState(db(), org, work.id)).evidence, {
          timeout: 5_000,
        })
        .not.toBe(before.evidence);
    });
  });
});
