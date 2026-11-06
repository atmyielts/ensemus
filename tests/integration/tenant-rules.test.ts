// NEXT-01, WORK-03, WORK-05, LIFE-01: rules about which tenant, which person and which reason a request
// names, each of which used to hold on one path and not another. Against the real database roles.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addArtifact,
  addDependency,
  addTeamMember,
  AppError,
  assignContributor,
  auditRefusal,
  auditTenantRefusal,
  createClient,
  createInvitation,
  createProject,
  createRestoreGate,
  createTeam,
  createWorkUnit,
  decideApproval,
  disableMember,
  getApproval,
  getWorkUnit,
  isAuditedRefusal,
  listWorkWithDisabledOwner,
  objectKey,
  recoverWorkOwner,
  refusalCode,
  removeDependency,
  requestApproval,
  requestExecution,
  requestWorkReview,
  setOwner,
  setTeamParent,
  transitionWorkUnit,
  unassign,
  type LedgerReader,
  type ObjectStore,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { ledgerKeyFor, serializeLedgerEntry } from '@ensemus/domain/tombstone-ledger';
import type { WorkState } from '@ensemus/domain/work-unit';
import { urls } from '../helpers/stack';

class MemoryStore implements ObjectStore, LedgerReader {
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
  async *listPages(prefix: string) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    if (keys.length > 0) yield keys;
  }
}

const code = (name: string) => expect.objectContaining({ code: name });

describe('tenant rules', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let su: pg.Client;
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

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
  });

  afterAll(async () => {
    await app?.close();
    await auth?.end();
    await su?.end();
  });

  describe('an organization ID in capitals', () => {
    /** The same tenant, reached by the same person through an address in capitals. */
    async function shouted() {
      const org = await newOrg('shouted');
      const upper = org.organizationId.toUpperCase();
      expect(upper).not.toBe(org.organizationId);
      return { org, upper, context: await resolveTenantContext(db(), org.userId, upper) };
    }

    it('resolves to the one spelling the database holds', async () => {
      const { org, context } = await shouted();
      expect(context.organizationId).toBe(org.organizationId);
    });

    it('resolves to it for a worker too', async () => {
      const { org, upper } = await shouted();
      expect(createServiceContext(upper).organizationId).toBe(org.organizationId);
    });

    it('does not get past the restore gate', async () => {
      const { org, context } = await shouted();
      const store = new MemoryStore();
      const entry = {
        organizationId: org.organizationId,
        targetType: 'artifact',
        targetId: randomUUID(),
        deletedAt: new Date('2026-11-01T09:00:00.000Z'),
      };
      store.objects.set(ledgerKeyFor(entry), serializeLedgerEntry(entry));
      const gate = createRestoreGate({ database: db(), store });
      await expect(gate.assertServing(context)).rejects.toEqual(code('RESTORE_PENDING'));
    });

    it('keeps a file’s bytes where a re-apply of the ledger would look for them', async () => {
      const { org, context } = await shouted();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), context, { title: 'Files' });
      const { id: artifactId } = await addArtifact(db(), store, context, {
        workUnitId: work.id,
        name: 'f.txt',
        mimeType: 'text/plain',
        body: Buffer.from('bytes'),
      });
      expect([...store.objects.keys()]).toEqual([objectKey(org.organizationId, artifactId)]);
      expect(objectKey(org.organizationId, artifactId)).toBe(
        `${org.organizationId}/artifacts/${artifactId}`,
      );
    });

    it('waits for the same lock as a change made through the ordinary address', async () => {
      const { org, context } = await shouted();
      const member = await join(org, 'member');
      await su.query('begin');
      let settled = false;
      let pending: Promise<void> | undefined;
      try {
        await su.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `member_changes:${org.organizationId}`,
        ]);
        pending = disableMember(db(), context, { membershipId: member.membershipId }).then(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Two owners removing each other through different spellings must still queue up.
        expect(settled).toBe(false);
      } finally {
        await su.query('rollback');
      }
      await pending;
      expect(settled).toBe(true);
    });

    it('files a refused tenant under its own spelling', async () => {
      const org = await newOrg('refused');
      const stranger = await makeUser('stranger');
      await auditTenantRefusal(db(), {
        userId: stranger.id,
        organizationId: org.organizationId.toUpperCase(),
        surface: 'web',
      });
      const { rows } = await su.query(
        `select target_ref from governance.audit_events
         where organization_id = $1 and actor_id = $2`,
        [org.organizationId, stranger.id],
      );
      expect(rows).toEqual([{ target_ref: `organization:${org.organizationId}` }]);
    });
  });

  // A form can send an ID in any spelling, and PostgreSQL stores the one spelling whatever it is given.
  // A rule that compares the text before it gets there can be walked around with the shift key.
  describe('a membership ID or a work ID in capitals', () => {
    const openReviews = async (workUnitId: string) =>
      (await su.query('select id from work.approvals where work_unit_id = $1', [workUnitId])).rows;

    /** Ready to run, with a plan that needs someone other than the person running it to review. */
    async function plannedWork(context: TenantContext) {
      const work = await createWorkUnit(db(), context, {
        title: 'Planned',
        executionPlan: 'checklist',
        completionCriteria: [{ kind: 'reviewer_approved' }],
      });
      await move(context, work.id, 'ready');
      return work;
    }

    it('cannot name yourself as the reviewer of your own plan', async () => {
      const org = await newOrg('own-plan');
      await join(org, 'other');
      const work = await plannedWork(org);
      await expect(
        requestExecution(db(), org, work.id, {
          reviewerMembershipId: org.membershipId.toUpperCase(),
        }),
      ).rejects.toEqual(code('APPROVAL_SELF_APPROVAL'));
      const { rows } = await su.query(
        'select run_requested_at, plan_reviewer_membership_id from work.work_units where id = $1',
        [work.id],
      );
      expect(rows).toEqual([{ run_requested_at: null, plan_reviewer_membership_id: null }]);
    });

    it('cannot ask yourself to review', async () => {
      const org = await newOrg('own-review');
      const work = await createWorkUnit(db(), org, { title: 'Reviewed' });
      await expect(
        requestWorkReview(db(), org, {
          workUnitId: work.id,
          expectedVersion: work.version,
          approverMembershipId: org.membershipId.toUpperCase(),
        }),
      ).rejects.toEqual(code('APPROVAL_SELF_APPROVAL'));
      expect(await openReviews(work.id)).toEqual([]);
    });

    it('cannot be the reviewer of a request made in your own name, whichever side is in capitals', async () => {
      const org = await newOrg('own-request');
      const work = await createWorkUnit(db(), org, { title: 'Requested' });
      const action = {
        toolName: 'work.review',
        toolVersion: '2',
        targetRef: `work_unit:${work.id}`,
        payload: {},
      };
      const expiresAt = new Date(Date.now() + 60_000);
      await expect(
        requestApproval(db(), org, {
          workUnitId: work.id,
          action,
          approverMembershipId: org.membershipId,
          requestedByMembershipId: org.membershipId.toUpperCase(),
          expiresAt,
        }),
      ).rejects.toEqual(code('APPROVAL_SELF_APPROVAL'));
      expect(await openReviews(work.id)).toEqual([]);
    });

    it('leaves a review open that the person it names can actually decide', async () => {
      const org = await newOrg('other-review');
      const reviewer = await join(org, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), org, { title: 'Reviewed' });
      await requestWorkReview(db(), org, {
        workUnitId: work.id,
        expectedVersion: work.version,
        approverMembershipId: reviewer.membershipId.toUpperCase(),
      });
      const { rows } = await su.query(
        'select approver_membership_id as approver from work.approvals where work_unit_id = $1',
        [work.id],
      );
      expect(rows).toEqual([{ approver: reviewer.membershipId }]);
    });

    it('lets someone on the work take themselves off, as in any other spelling', async () => {
      const org = await newOrg('off');
      const member = await join(org, 'member');
      const work = await createWorkUnit(db(), org, { title: 'On it' });
      await assignContributor(db(), org, { id: work.id, membershipId: member.membershipId });
      await unassign(db(), member, {
        id: work.id,
        membershipId: member.membershipId.toUpperCase(),
      });
      const { rows } = await su.query(
        'select 1 from work.work_assignments where work_unit_id = $1 and membership_id = $2',
        [work.id, member.membershipId],
      );
      expect(rows).toEqual([]);
    });

    it('does not tell you about what you did yourself, and records one spelling', async () => {
      const org = await newOrg('self');
      const work = await createWorkUnit(db(), org, { title: 'Mine' });
      await unassign(db(), org, { id: work.id, membershipId: org.membershipId });
      await assignContributor(db(), org, {
        id: work.id,
        membershipId: org.membershipId.toUpperCase(),
      });
      const told = await su.query(
        `select 1 from platform.notifications
         where recipient_membership_id = $1 and target_ref = $2`,
        [org.membershipId, `work_unit:${work.id}`],
      );
      expect(told.rows).toEqual([]);
      const events = await su.query(
        `select payload ->> 'membership_id' as membership from platform.domain_events
         where aggregate_id = $1 and event_type = 'work.assigned'`,
        [work.id],
      );
      expect(events.rows).toEqual([{ membership: org.membershipId }]);
    });

    it('moves work to someone under one spelling, and tells them', async () => {
      const org = await newOrg('owner');
      const next = await join(org, 'next');
      const work = await createWorkUnit(db(), org, { title: 'Moved' });
      await setOwner(db(), org, {
        id: work.id,
        expectedVersion: work.version,
        ownerMembershipId: next.membershipId.toUpperCase(),
      });
      const events = await su.query(
        `select payload ->> 'owner_membership_id' as owner from platform.domain_events
         where aggregate_id = $1 and event_type = 'work.owner_changed'`,
        [work.id],
      );
      expect(events.rows).toEqual([{ owner: next.membershipId }]);
    });

    it('cannot make work depend on itself', async () => {
      const org = await newOrg('itself');
      const work = await createWorkUnit(db(), org, { title: 'Itself' });
      await expect(
        addDependency(db(), org, { dependentId: work.id, prerequisiteId: work.id.toUpperCase() }),
      ).rejects.toEqual(code('DEPENDENCY_CYCLE'));
    });

    it('treats a form sent twice as one form, whichever spelling its key and references use', async () => {
      const org = await newOrg('repeat');
      const requestKey = randomUUID();
      const first = await createWorkUnit(db(), org, {
        title: 'Once',
        ownerMembershipId: org.membershipId,
        requestKey,
      });
      const again = await createWorkUnit(db(), org, {
        title: 'Once',
        ownerMembershipId: org.membershipId.toUpperCase(),
        requestKey: requestKey.toUpperCase(),
      });
      expect(again.id).toBe(first.id);

      const parent = await createTeam(db(), org, { name: 'Parent' });
      const parentId = parent?.id as string;
      const teamKey = randomUUID();
      const team = await createTeam(db(), org, { name: 'Child', parentId, requestKey: teamKey });
      const sameTeam = await createTeam(db(), org, {
        name: 'Child',
        parentId: parentId.toUpperCase(),
        requestKey: teamKey.toUpperCase(),
      });
      expect(sameTeam?.id).toBe(team?.id);
      expect(team?.id).toBeDefined();
    });
  });

  describe('naming something from another tenant (NEXT-01)', () => {
    /** A refusal the caller hears as bad input, and that the audit log records as what it was. */
    async function expectForged(attempt: Promise<unknown>, context: TenantContext) {
      const error = await attempt.then(
        () => {
          throw new Error('It was not refused');
        },
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_INPUT');
      expect(isAuditedRefusal(error)).toBe(true);
      expect(refusalCode(error as AppError)).toBe('FOREIGN_REFERENCE');
      await auditRefusal(db(), context, {
        code: refusalCode(error as AppError),
        surface: 'web',
      });
      const { rows } = await su.query(
        `select safe_reason from governance.audit_events
         where organization_id = $1 and actor_id = $2 and action = 'access.refused.web'`,
        [context.organizationId, context.membershipId],
      );
      expect(rows).toEqual([{ safe_reason: 'FOREIGN_REFERENCE' }]);
    }

    async function twoTenants() {
      const org = await newOrg('ours');
      const rival = await newOrg('theirs');
      return { org, rival, member: await join(org, 'member') };
    }

    it('refuses and records a project', async () => {
      const { rival, member } = await twoTenants();
      const theirs = await createProject(db(), rival, { name: 'Theirs' });
      const title = `Forged ${randomUUID()}`;
      await expectForged(
        createWorkUnit(db(), member, { title, projectId: theirs?.id as string }),
        member,
      );
      const { rows } = await su.query('select id from work.work_units where title = $1', [title]);
      expect(rows).toEqual([]);
    });

    it('refuses and records a project that does not exist, with the same answer', async () => {
      const { member } = await twoTenants();
      await expectForged(
        createWorkUnit(db(), member, { title: 'Nowhere', projectId: randomUUID() }),
        member,
      );
    });

    it('still accepts a project of its own', async () => {
      const { member } = await twoTenants();
      const ours = await createProject(db(), member, { name: 'Ours' });
      const work = await createWorkUnit(db(), member, {
        title: 'Inside',
        projectId: ours?.id as string,
      });
      expect(work.projectId).toBe(ours?.id);
    });

    it('refuses and records an owner', async () => {
      const { org, rival } = await twoTenants();
      const work = await createWorkUnit(db(), org, { title: 'Owned' });
      await expectForged(
        setOwner(db(), org, {
          id: work.id,
          expectedVersion: work.version,
          ownerMembershipId: rival.membershipId,
        }),
        org,
      );
    });

    it('refuses and records someone to assign', async () => {
      const { org, rival } = await twoTenants();
      const work = await createWorkUnit(db(), org, { title: 'Assigned' });
      await expectForged(
        assignContributor(db(), org, { id: work.id, membershipId: rival.membershipId }),
        org,
      );
    });

    it('refuses and records a reviewer', async () => {
      const { org, rival } = await twoTenants();
      const work = await createWorkUnit(db(), org, { title: 'Reviewed' });
      await expectForged(
        requestWorkReview(db(), org, {
          workUnitId: work.id,
          expectedVersion: work.version,
          approverMembershipId: rival.membershipId,
        }),
        org,
      );
    });

    it('refuses and records a plan’s reviewer', async () => {
      const { org, rival } = await twoTenants();
      const work = await createWorkUnit(db(), org, {
        title: 'Planned',
        executionPlan: 'checklist',
        completionCriteria: [{ kind: 'reviewer_approved' }],
      });
      await move(org, work.id, 'ready');
      await expectForged(
        requestExecution(db(), org, work.id, { reviewerMembershipId: rival.membershipId }),
        org,
      );
    });

    it('refuses and records a team member', async () => {
      const { org, rival } = await twoTenants();
      const team = await createTeam(db(), org, { name: 'Ours' });
      await expectForged(
        addTeamMember(db(), org, {
          teamId: team?.id as string,
          membershipId: rival.membershipId,
        }),
        org,
      );
    });

    it('refuses and records a parent team, on creating one and on moving one', async () => {
      const { org, rival } = await twoTenants();
      const theirs = await createTeam(db(), rival, { name: 'Theirs' });
      const ours = await createTeam(db(), org, { name: 'Ours' });
      await expectForged(
        setTeamParent(db(), org, { teamId: ours?.id as string, parentId: theirs?.id as string }),
        org,
      );
      await expect(
        createTeam(db(), org, { name: 'Child', parentId: theirs?.id as string }),
      ).rejects.toSatisfy((error) => isAuditedRefusal(error));
    });

    it('refuses and records a client', async () => {
      const { org, rival } = await twoTenants();
      const theirs = await createClient(db(), rival, { displayName: 'Theirs' });
      await expectForged(
        createProject(db(), org, { name: 'Forged', clientId: theirs?.id as string }),
        org,
      );
    });

    it('leaves choosing someone disabled as the ordinary mistake it is', async () => {
      const { org, member } = await twoTenants();
      const gone = await join(org, 'gone');
      await disableMember(db(), org, { membershipId: gone.membershipId });
      const work = await createWorkUnit(db(), member, { title: 'Ordinary' });
      const refused = await setOwner(db(), member, {
        id: work.id,
        expectedVersion: work.version,
        ownerMembershipId: gone.membershipId,
      }).catch((error: unknown) => error);
      expect(refused).toEqual(code('INVALID_INPUT'));
      expect(isAuditedRefusal(refused)).toBe(false);
    });

    it('does not treat text that is no ID as a database failure', async () => {
      const { org } = await twoTenants();
      const work = await createWorkUnit(db(), org, { title: 'Typed' });
      const refused = await assignContributor(db(), org, {
        id: work.id,
        membershipId: 'not an id',
      }).catch((error: unknown) => error);
      expect(refused).toEqual(code('INVALID_INPUT'));
      expect(isAuditedRefusal(refused)).toBe(false);
    });
  });

  describe('prerequisites someone cannot see', () => {
    /** Bob can change the work. Alice can see the restricted prerequisite it waits on, and he cannot. */
    async function hiddenPrerequisite() {
      const org = await newOrg('hidden');
      const alice = await join(org, 'alice');
      const bob = await join(org, 'bob');
      const secret = await createWorkUnit(db(), alice, {
        title: 'Secret',
        classification: 'restricted',
      });
      const dependent = await createWorkUnit(db(), bob, { title: 'Waiting' });
      await assignContributor(db(), bob, { id: dependent.id, membershipId: alice.membershipId });
      await addDependency(db(), alice, { dependentId: dependent.id, prerequisiteId: secret.id });
      return { alice, bob, secret, dependent };
    }

    const edges = async (dependentId: string) => {
      const { rows } = await su.query(
        'select prerequisite_id from work.work_dependencies where dependent_id = $1',
        [dependentId],
      );
      return rows.length;
    };

    it('cannot be lifted by naming the ID', async () => {
      const { bob, secret, dependent } = await hiddenPrerequisite();
      await expect(
        removeDependency(db(), bob, { dependentId: dependent.id, prerequisiteId: secret.id }),
      ).rejects.toEqual(code('NOT_FOUND'));
      expect(await edges(dependent.id)).toBe(1);
    });

    it('gives the same answer as an ID that does not exist', async () => {
      const { bob, dependent } = await hiddenPrerequisite();
      await expect(
        removeDependency(db(), bob, { dependentId: dependent.id, prerequisiteId: randomUUID() }),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('can still be lifted by someone who can see it', async () => {
      const { alice, secret, dependent } = await hiddenPrerequisite();
      await removeDependency(db(), alice, {
        dependentId: dependent.id,
        prerequisiteId: secret.id,
      });
      expect(await edges(dependent.id)).toBe(0);
    });
  });

  describe('denying a review that holds the work', () => {
    async function held() {
      const org = await newOrg('held');
      const reviewer = await join(org, 'reviewer');
      const work = await createWorkUnit(db(), org, { title: 'Held' });
      await move(org, work.id, 'ready', 'running');
      const { id, actionHash: hash } = await requestApproval(db(), org, {
        workUnitId: work.id,
        action: { toolName: 'x.y', toolVersion: '1', targetRef: null, payload: {} },
        approverMembershipId: reviewer.membershipId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      return { org, reviewer, work, id, hash };
    }

    it('needs a reason, whichever way it arrives, and changes nothing without one', async () => {
      const { org, reviewer, work, id, hash } = await held();
      for (const reason of [undefined, '   ']) {
        await expect(
          decideApproval(db(), reviewer, {
            approvalId: id,
            decision: 'deny',
            shownHash: hash,
            ...(reason ? { reason } : {}),
          }),
        ).rejects.toEqual(code('REASON_REQUIRED'));
      }
      expect((await getWorkUnit(db(), org, work.id)).status).toBe('awaiting_approval');
      expect((await getApproval(db(), org, id)).approval.status).toBe('pending');
    });

    it('stops the work once there is one', async () => {
      const { org, reviewer, work, id, hash } = await held();
      await decideApproval(db(), reviewer, {
        approvalId: id,
        decision: 'deny',
        shownHash: hash,
        reason: 'Not this way',
      });
      expect((await getWorkUnit(db(), org, work.id)).status).toBe('cancelled');
    });

    it('tells someone else it is not theirs before asking them why', async () => {
      const { org, id, hash } = await held();
      const other = await join(org, 'other');
      await expect(
        decideApproval(db(), other, { approvalId: id, decision: 'deny', shownHash: hash }),
      ).rejects.toEqual(code('APPROVAL_WRONG_APPROVER'));
    });

    it('asks for nothing on an approval, or on a review that holds nothing', async () => {
      const { reviewer, id, hash } = await held();
      await decideApproval(db(), reviewer, {
        approvalId: id,
        decision: 'approve',
        shownHash: hash,
      });

      const org = await newOrg('plain');
      const person = await join(org, 'person');
      const work = await createWorkUnit(db(), org, { title: 'Plain' });
      const review = await requestWorkReview(db(), org, {
        workUnitId: work.id,
        expectedVersion: work.version,
        approverMembershipId: person.membershipId,
      });
      await decideApproval(db(), person, {
        approvalId: review.id,
        decision: 'deny',
        shownHash: review.actionHash,
      });
    });
  });

  describe('restricted work whose owner was disabled (WORK-03)', () => {
    /** Mira is the only person on it, and she has gone. */
    async function stranded() {
      const org = await newOrg('stranded');
      const admin = await join(org, 'admin', 'admin');
      const member = await join(org, 'member');
      const mira = await join(org, 'mira');
      const title = `Stranded ${randomUUID()}`;
      const work = await createWorkUnit(db(), mira, { title, classification: 'restricted' });
      await disableMember(db(), org, { membershipId: mira.membershipId });
      return { org, admin, member, mira, work, title };
    }

    const recover = (context: TenantContext, id: string, version: number, to: string) =>
      recoverWorkOwner(db(), context, { id, expectedVersion: version, ownerMembershipId: to });

    it('is out of everyone’s reach through the ordinary way in', async () => {
      const { org, member, work } = await stranded();
      await expect(getWorkUnit(db(), org, work.id)).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        setOwner(db(), org, {
          id: work.id,
          expectedVersion: work.version,
          ownerMembershipId: member.membershipId,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('is listed for an organization owner, with nothing about what it holds', async () => {
      const { org, work, title } = await stranded();
      const { hidden, visible } = await listWorkWithDisabledOwner(db(), org);
      expect(hidden).toEqual([{ id: work.id, version: work.version, status: work.status }]);
      expect(visible).toEqual([]);
      expect(JSON.stringify({ hidden, visible })).not.toContain(title);
    });

    it('is not listed for anyone else', async () => {
      const { admin, member } = await stranded();
      expect((await listWorkWithDisabledOwner(db(), admin)).hidden).toEqual([]);
      await expect(listWorkWithDisabledOwner(db(), member)).rejects.toEqual(code('FORBIDDEN'));
    });

    it('lists work anyone there can already reach with its title, to be moved on its page', async () => {
      const org = await newOrg('open');
      const gone = await join(org, 'gone');
      const work = await createWorkUnit(db(), gone, { title: 'Open work' });
      await disableMember(db(), org, { membershipId: gone.membershipId });
      expect(await listWorkWithDisabledOwner(db(), org)).toEqual({
        hidden: [],
        visible: [expect.objectContaining({ id: work.id, title: 'Open work' })],
      });
    });

    it('can be moved to someone active by an organization owner, and only that way', async () => {
      const { org, member, work, title } = await stranded();
      await recover(org, work.id, work.version, member.membershipId);
      const now = await getWorkUnit(db(), member, work.id);
      expect(now.title).toBe(title);
      expect(now.ownerMembershipId).toBe(member.membershipId);
      // Moving it gives the person who moved it nothing they did not name for themselves.
      await expect(getWorkUnit(db(), org, work.id)).rejects.toEqual(code('NOT_FOUND'));
      expect((await listWorkWithDisabledOwner(db(), org)).hidden).toEqual([]);
    });

    it('leaves a record of it, and tells the other owners', async () => {
      const { org, member, work } = await stranded();
      const secondOwner = await join(org, 'second', 'admin');
      await su.query(`update org.memberships set role = 'owner' where id = $1`, [
        secondOwner.membershipId,
      ]);
      await recover(org, work.id, work.version, member.membershipId);
      const audit = await su.query(
        `select actor_id, safe_reason from governance.audit_events
         where organization_id = $1 and target_ref = $2 and action = 'work.owner_changed'`,
        [org.organizationId, `work_unit:${work.id}`],
      );
      expect(audit.rows).toEqual([{ actor_id: org.membershipId, safe_reason: 'OWNER_DISABLED' }]);
      const told = await su.query(
        `select recipient_membership_id as who from platform.notifications
         where organization_id = $1 and kind = 'work.owner_recovered'`,
        [org.organizationId],
      );
      expect(told.rows).toEqual([{ who: secondOwner.membershipId }]);
    });

    it('refuses an admin and a member, even with the right form', async () => {
      const { admin, member, work } = await stranded();
      for (const context of [admin, member]) {
        await expect(recover(context, work.id, work.version, member.membershipId)).rejects.toEqual(
          code('FORBIDDEN'),
        );
      }
    });

    it('is no way into restricted work whose owner is still here', async () => {
      const org = await newOrg('active');
      const olive = await join(org, 'olive');
      const work = await createWorkUnit(db(), olive, {
        title: 'Still owned',
        classification: 'restricted',
      });
      await expect(recover(org, work.id, work.version, org.membershipId)).rejects.toEqual(
        code('NOT_FOUND'),
      );
      expect((await getWorkUnit(db(), olive, work.id)).ownerMembershipId).toBe(olive.membershipId);
    });

    it('refuses a stale form, someone disabled, and someone from another tenant', async () => {
      const { org, member, mira, work } = await stranded();
      await expect(recover(org, work.id, work.version + 1, member.membershipId)).rejects.toEqual(
        code('VERSION_CONFLICT'),
      );
      await expect(recover(org, work.id, work.version, mira.membershipId)).rejects.toEqual(
        code('INVALID_INPUT'),
      );
      const rival = await newOrg('rival');
      const forged = await recover(org, work.id, work.version, rival.membershipId).catch(
        (error: unknown) => error,
      );
      expect(isAuditedRefusal(forged)).toBe(true);
    });

    it('reports work from another tenant the same as work that does not exist', async () => {
      const { org, work } = await stranded();
      const rival = await newOrg('rival');
      await expect(recover(rival, work.id, work.version, rival.membershipId)).rejects.toEqual(
        code('NOT_FOUND'),
      );
      await expect(recover(org, randomUUID(), 1, org.membershipId)).rejects.toEqual(
        code('NOT_FOUND'),
      );
    });
  });

  describe('accepting an invitation while the tenant is being restored', () => {
    async function invited() {
      const org = await newOrg('invited');
      const user = await makeUser('invited');
      const { token } = await createInvitation(db(), org, { email: user.email });
      const store = new MemoryStore();
      const gate = createRestoreGate({ database: db(), store });
      const accept = (emailVerified: boolean) =>
        acceptInvitation(db(), {
          token,
          userId: user.id,
          email: user.email,
          emailVerified,
          assertServing: (organizationId, userId) =>
            gate.assertServingInvited(organizationId, userId),
        });
      return { org, user, store, accept };
    }

    const closeGate = (store: MemoryStore, organizationId: string) => {
      const entry = {
        organizationId,
        targetType: 'artifact',
        targetId: randomUUID(),
        deletedAt: new Date('2026-11-01T09:00:00.000Z'),
      };
      store.objects.set(ledgerKeyFor(entry), serializeLedgerEntry(entry));
    };

    const stateOf = async (organizationId: string, userId: string) => {
      const member = await su.query(
        'select id from org.memberships where organization_id = $1 and user_id = $2',
        [organizationId, userId],
      );
      const invitation = await su.query(
        'select accepted_at, claimed_at from org.invitations where organization_id = $1',
        [organizationId],
      );
      return { members: member.rows.length, invitation: invitation.rows[0] };
    };

    it.each([true, false])('writes nothing (verified: %s)', async (verified) => {
      const { org, user, store, accept } = await invited();
      closeGate(store, org.organizationId);
      await expect(accept(verified)).rejects.toEqual(code('RESTORE_PENDING'));
      expect(await stateOf(org.organizationId, user.id)).toEqual({
        members: 0,
        invitation: { accepted_at: null, claimed_at: null },
      });
    });

    it('joins as usual when nothing is being restored', async () => {
      const { org, user, accept } = await invited();
      await expect(accept(true)).resolves.toEqual({
        status: 'joined',
        organizationId: org.organizationId,
      });
      expect((await stateOf(org.organizationId, user.id)).members).toBe(1);
    });

    it('says nothing about a restore to someone the invitation is not for', async () => {
      const org = await newOrg('other');
      const user = await makeUser('wrong-person');
      const { token } = await createInvitation(db(), org, { email: 'someone@example.invalid' });
      const store = new MemoryStore();
      closeGate(store, org.organizationId);
      const gate = createRestoreGate({ database: db(), store });
      await expect(
        acceptInvitation(db(), {
          token,
          userId: user.id,
          email: user.email,
          emailVerified: true,
          assertServing: (organizationId, userId) =>
            gate.assertServingInvited(organizationId, userId),
        }),
      ).rejects.toEqual(code('INVITATION_INVALID'));
    });
  });
});
