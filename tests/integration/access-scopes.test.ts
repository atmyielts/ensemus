// WORK-03, UX-15, NEXT-01, UX-17: what an assigned person may do, what the directory shows, how
// refusals are recorded, and how an inbox orders what it holds. Each against the real database roles.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addDependency,
  addTeamMember,
  assignContributor,
  auditRefusal,
  auditTenantRefusal,
  countUnread,
  createInvitation,
  createTeam,
  createWorkUnit,
  getWorkDetail,
  getWorkUnit,
  INBOX_SIZE,
  isAuditedRefusal,
  listDirectory,
  listMyNotifications,
  listTeams,
  markRead,
  removeTeamMember,
  sendDueReminders,
  setOwner,
  setTeamParent,
  transitionWorkUnit,
  unassign,
  updateWorkUnit,
  AppError,
} from '@ensemus/application';
import {
  createOrganization,
  listAuditEvents,
  MAX_REFUSALS_PER_HOUR,
  openAppDatabase,
  resolveTenantContext,
  TenantAccessDenied,
  type TenantContext,
} from '@ensemus/database';
import type { WorkState } from '@ensemus/domain/work-unit';
import { urls } from '../helpers/stack';

const code = (name: string) => expect.objectContaining({ code: name });

describe('access scopes', () => {
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
    await auth.query('update identity.users set email_verified=true where id=$1', [user.id]);
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

  describe('someone assigned to work (WORK-03)', () => {
    /** Olive owns the work. Dan is only assigned to it, and is an ordinary member. */
    async function delegated(classification: 'internal' | 'restricted' = 'internal') {
      const org = await newOrg();
      const olive = await join(org, 'olive');
      const dan = await join(org, 'dan');
      const other = await join(org, 'other');
      const work = await createWorkUnit(db(), olive, {
        title: 'Delegated',
        classification,
      });
      await assignContributor(db(), olive, { id: work.id, membershipId: dan.membershipId });
      return { org, olive, dan, other, work };
    }

    it('can work on it and move it along', async () => {
      const { dan, work } = await delegated();
      const edited = await updateWorkUnit(db(), dan, work.id, 1, { title: 'Edited by Dan' });
      expect(edited.title).toBe('Edited by Dan');
      expect((await move(dan, work.id, 'ready', 'running', 'blocked', 'ready')).status).toBe(
        'ready',
      );
      const other = await createWorkUnit(db(), dan, { title: 'Prerequisite' });
      await move(dan, work.id, 'running', 'blocked');
      await addDependency(db(), dan, { dependentId: work.id, prerequisiteId: other.id });
      const detail = await getWorkDetail(db(), dan, work.id);
      expect(detail.prerequisites.map((p) => p.id)).toEqual([other.id]);
      expect(detail.canChange).toBe(true);
      expect(detail.canManage).toBe(false);
    });

    it('cannot change the owner', async () => {
      const { olive, dan, other, work } = await delegated();
      for (const ownerMembershipId of [dan.membershipId, other.membershipId]) {
        await expect(
          setOwner(db(), dan, { id: work.id, expectedVersion: 1, ownerMembershipId }),
        ).rejects.toEqual(code('FORBIDDEN'));
      }
      const after = await getWorkUnit(db(), olive, work.id);
      expect(after.ownerMembershipId).toBe(olive.membershipId);
      expect(after.version).toBe(1);
    });

    it('cannot add or remove anyone else', async () => {
      const { olive, dan, other, work } = await delegated();
      await expect(
        assignContributor(db(), dan, { id: work.id, membershipId: other.membershipId }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await assignContributor(db(), olive, { id: work.id, membershipId: other.membershipId });
      await expect(
        unassign(db(), dan, { id: work.id, membershipId: other.membershipId }),
      ).rejects.toEqual(code('FORBIDDEN'));
      const { people } = await getWorkDetail(db(), olive, work.id);
      expect(people.map((p) => p.membershipId)).toContain(other.membershipId);
    });

    it('can take themselves off, and then has no way back on', async () => {
      const { dan, work } = await delegated('restricted');
      await unassign(db(), dan, { id: work.id, membershipId: dan.membershipId });
      await expect(getWorkUnit(db(), dan, work.id)).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        assignContributor(db(), dan, { id: work.id, membershipId: dan.membershipId }),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('cannot stop it, from any status that could be stopped', async () => {
      const { olive, dan, work } = await delegated();
      const stop = (expectedVersion: number) =>
        transitionWorkUnit(db(), dan, {
          id: work.id,
          expectedVersion,
          to: 'cancelled',
          reason: 'Done with this',
        });
      await expect(stop(1)).rejects.toEqual(code('FORBIDDEN'));
      const running = await move(dan, work.id, 'ready', 'running');
      await expect(stop(running.version)).rejects.toEqual(code('FORBIDDEN'));
      expect((await getWorkUnit(db(), olive, work.id)).status).toBe('running');
    });

    it('becomes a delegate by handing over, and keeps no owner rights', async () => {
      const { olive, dan, work } = await delegated();
      const handed = await setOwner(db(), olive, {
        id: work.id,
        expectedVersion: 1,
        ownerMembershipId: dan.membershipId,
      });
      // Olive made the work, so she stays on it, and now only as someone assigned.
      await expect(
        setOwner(db(), olive, {
          id: work.id,
          expectedVersion: handed.version,
          ownerMembershipId: olive.membershipId,
        }),
      ).rejects.toEqual(code('FORBIDDEN'));
      expect((await getWorkDetail(db(), olive, work.id)).canManage).toBe(false);
      expect((await getWorkDetail(db(), dan, work.id)).canManage).toBe(true);
    });

    it('leaves all of this to the owner, who may be an ordinary member', async () => {
      const { olive, dan, other, work } = await delegated();
      await assignContributor(db(), olive, { id: work.id, membershipId: other.membershipId });
      await unassign(db(), olive, { id: work.id, membershipId: dan.membershipId });
      const handed = await setOwner(db(), olive, {
        id: work.id,
        expectedVersion: 1,
        ownerMembershipId: other.membershipId,
      });
      const stopped = await transitionWorkUnit(db(), other, {
        id: work.id,
        expectedVersion: handed.version,
        to: 'cancelled',
        reason: 'No longer needed',
      });
      expect(stopped.status).toBe('cancelled');
    });

    it('leaves it to an admin too, who need not be on the work', async () => {
      const { org, dan, other, work } = await delegated();
      const admin = await join(org, 'admin', 'admin');
      expect((await getWorkDetail(db(), admin, work.id)).canManage).toBe(true);
      await assignContributor(db(), admin, { id: work.id, membershipId: other.membershipId });
      await unassign(db(), admin, { id: work.id, membershipId: dan.membershipId });
      const stopped = await transitionWorkUnit(db(), org, {
        id: work.id,
        expectedVersion: 1,
        to: 'cancelled',
        reason: 'No longer needed',
      });
      expect(stopped.status).toBe('cancelled');
    });

    it('does not let an admin reach into restricted work they are not on', async () => {
      const { org, olive, other, work } = await delegated('restricted');
      const admin = await join(org, 'admin', 'admin');
      await expect(
        setOwner(db(), admin, {
          id: work.id,
          expectedVersion: 1,
          ownerMembershipId: admin.membershipId,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        assignContributor(db(), admin, { id: work.id, membershipId: other.membershipId }),
      ).rejects.toEqual(code('NOT_FOUND'));
      expect((await getWorkUnit(db(), olive, work.id)).ownerMembershipId).toBe(olive.membershipId);
    });

    it('gives someone not on it nothing, and someone in another tenant less', async () => {
      const { other, work } = await delegated();
      const rival = await newOrg('rival');
      for (const [person, refusal] of [
        [other, 'FORBIDDEN'],
        [rival, 'NOT_FOUND'],
      ] as const) {
        await expect(
          setOwner(db(), person, {
            id: work.id,
            expectedVersion: 1,
            ownerMembershipId: person.membershipId,
          }),
        ).rejects.toEqual(code(refusal));
        await expect(
          assignContributor(db(), person, { id: work.id, membershipId: person.membershipId }),
        ).rejects.toEqual(code(refusal));
        await expect(
          transitionWorkUnit(db(), person, { id: work.id, expectedVersion: 1, to: 'cancelled' }),
        ).rejects.toEqual(code(refusal));
      }
    });

    it('has no way to change classification, and neither does anyone else', async () => {
      const { olive, dan, work } = await delegated();
      for (const person of [dan, olive]) {
        await expect(
          updateWorkUnit(db(), person, work.id, 1, { classification: 'public' } as never),
        ).rejects.toEqual(code('INVALID_INPUT'));
      }
      expect((await getWorkUnit(db(), olive, work.id)).classification).toBe('internal');
    });

    it('marks every assignment as held by a person, and the database knows no third kind', async () => {
      const { dan, work } = await delegated();
      const { rows } = await su.query(
        'select actor_type from work.work_assignments where work_unit_id = $1',
        [work.id],
      );
      expect(new Set(rows.map((row) => row.actor_type))).toEqual(new Set(['human']));
      await su.query('begin');
      try {
        await su.query("select set_config('app.organization_id',$1,true)", [dan.organizationId]);
        await expect(
          su.query(
            `update work.work_assignments set actor_type = 'robot'
           where work_unit_id = $1 and membership_id = $2`,
            [work.id, dan.membershipId],
          ),
        ).rejects.toThrow(/work_assignments_actor_type_check/);
      } finally {
        await su.query('rollback');
      }
    });
  });

  describe('the directory (UX-15)', () => {
    it('shows a member names and roles, and no address but their own', async () => {
      const org = await newOrg();
      const member = await join(org, 'member');
      const other = await join(org, 'other');
      const listed = await listDirectory(db(), member);
      expect(listed).toHaveLength(3);
      expect(new Set(listed.map((person) => person.role))).toEqual(new Set(['owner', 'member']));
      expect(listed.every((person) => person.name.length > 0)).toBe(true);
      const emails = (id: string) => listed.find((person) => person.membershipId === id)?.email;
      expect(emails(org.membershipId)).toBeNull();
      expect(emails(other.membershipId)).toBeNull();
      expect(emails(member.membershipId)).toContain('@example.invalid');
      expect(JSON.stringify(listed)).not.toContain(other.userId);
    });

    it('shows an admin and an owner every address', async () => {
      const org = await newOrg();
      const admin = await join(org, 'admin', 'admin');
      await join(org, 'member');
      for (const viewer of [org, admin]) {
        const listed = await listDirectory(db(), viewer);
        expect(listed).toHaveLength(3);
        expect(listed.every((person) => person.email?.includes('@'))).toBe(true);
      }
    });

    it('never shows anyone from another tenant', async () => {
      const org = await newOrg();
      const rival = await newOrg('rival');
      const listed = await listDirectory(db(), org);
      expect(listed.map((person) => person.membershipId)).toEqual([org.membershipId]);
      expect(listed.map((person) => person.membershipId)).not.toContain(rival.membershipId);
    });
  });

  describe('moving teams (UX-15)', () => {
    async function threeLevels() {
      const org = await newOrg();
      const top = await createTeam(db(), org, { name: 'Top' });
      const middle = await createTeam(db(), org, { name: 'Middle', parentId: top?.id ?? null });
      const bottom = await createTeam(db(), org, { name: 'Bottom', parentId: middle?.id ?? null });
      if (!top || !middle || !bottom) throw new Error('Teams not created');
      return { org, top, middle, bottom };
    }

    it('moves a team under another, and back to the top, and records the move', async () => {
      const { org, top, bottom } = await threeLevels();
      await setTeamParent(db(), org, { teamId: bottom.id, parentId: top.id });
      const parentOf = async () =>
        (await listTeams(db(), org)).find((team) => team.id === bottom.id)?.parentId;
      expect(await parentOf()).toBe(top.id);
      await setTeamParent(db(), org, { teamId: bottom.id, parentId: null });
      expect(await parentOf()).toBeNull();
      const audit = await listAuditEvents(db(), org);
      expect(
        audit.filter((row) => row.action === 'team.moved' && row.targetRef === `team:${bottom.id}`),
      ).toHaveLength(2);
    });

    it('refuses a loop more than one level deep, and changes nothing', async () => {
      const { org, top, bottom } = await threeLevels();
      await expect(
        setTeamParent(db(), org, { teamId: top.id, parentId: bottom.id }),
      ).rejects.toEqual(code('TEAM_CYCLE'));
      const after = await listTeams(db(), org);
      expect(after.find((team) => team.id === top.id)?.parentId).toBeNull();
    });

    it('refuses a parent or a team from another tenant, or a value that is no ID', async () => {
      const { org, top } = await threeLevels();
      const rival = await newOrg('rival');
      const theirs = await createTeam(db(), rival, { name: 'Theirs' });
      if (!theirs) throw new Error('Team not created');
      await expect(
        setTeamParent(db(), org, { teamId: top.id, parentId: theirs.id }),
      ).rejects.toEqual(code('INVALID_INPUT'));
      await expect(
        setTeamParent(db(), org, { teamId: theirs.id, parentId: top.id }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        createTeam(db(), org, { name: 'Under theirs', parentId: theirs.id }),
      ).rejects.toEqual(code('INVALID_INPUT'));
      await expect(setTeamParent(db(), org, { teamId: 'nope', parentId: null })).rejects.toEqual(
        code('INVALID_INPUT'),
      );
      expect((await listTeams(db(), rival))[0]?.parentId).toBeNull();
    });

    it('is not for a member, and neither is removing someone from a team', async () => {
      const { org, top, bottom } = await threeLevels();
      const member = await join(org, 'member');
      await addTeamMember(db(), org, { teamId: top.id, membershipId: member.membershipId });
      await expect(
        setTeamParent(db(), member, { teamId: bottom.id, parentId: null }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        removeTeamMember(db(), member, { teamId: top.id, membershipId: member.membershipId }),
      ).rejects.toEqual(code('FORBIDDEN'));
      const team = (await listTeams(db(), org)).find((entry) => entry.id === top.id);
      expect(team?.members.map((m) => m.membershipId)).toEqual([member.membershipId]);
    });
  });

  describe('recording refusals (NEXT-01)', () => {
    const refusalsIn = async (organizationId: string) => {
      const { rows } = await su.query(
        `select actor_id, action, target_ref, decision, safe_reason from governance.audit_events
         where organization_id = $1 and action like 'access.refused%'`,
        [organizationId],
      );
      return rows;
    };

    it('writes who, where and which code, and nothing from the request', async () => {
      const org = await newOrg();
      const member = await join(org, 'member');
      await auditRefusal(db(), member, { code: 'FORBIDDEN', surface: 'web' });
      expect(await refusalsIn(org.organizationId)).toEqual([
        {
          actor_id: member.membershipId,
          action: 'access.refused.web',
          target_ref: `organization:${org.organizationId}`,
          decision: 'deny',
          safe_reason: 'FORBIDDEN',
        },
      ]);
    });

    it('makes one row per person and code in an hour, however many times it happens', async () => {
      const org = await newOrg();
      const member = await join(org, 'member');
      const other = await join(org, 'other');
      const at = new Date('2031-03-04T05:06:07Z');
      const refuse = (person: TenantContext, when: Date, kind = 'FORBIDDEN' as const) =>
        auditRefusal(db(), person, { code: kind, surface: 'web', now: when });
      const results = await Promise.all(Array.from({ length: 20 }, () => refuse(member, at)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await refusalsIn(org.organizationId)).toHaveLength(1);

      // Someone else, or something else, or later on, is a new fact and gets its own row.
      expect(await refuse(other, at)).toBe(true);
      expect(await auditRefusal(db(), member, { code: 'NOT_FOUND', surface: 'web', now: at })).toBe(
        true,
      );
      expect(await auditRefusal(db(), member, { code: 'FORBIDDEN', surface: 'api', now: at })).toBe(
        true,
      );
      expect(await refuse(member, new Date('2031-03-04T06:06:07Z'))).toBe(true);
      expect(await refusalsIn(org.organizationId)).toHaveLength(5);
    });

    it('stops at a limit an hour, even with a different account behind each one', async () => {
      const org = await newOrg();
      const at = new Date();
      // As if the limit had almost been reached by other accounts this hour.
      await su.query(
        `insert into governance.audit_events
           (organization_id, actor_type, actor_id, action, target_ref, decision, safe_reason,
            dedupe_key, occurred_at)
         select $1, 'user', gen_random_uuid(), 'access.refused.web', $2, 'deny', 'FORBIDDEN',
                gen_random_uuid()::text, $3::timestamptz
         from generate_series(1, $4::int)`,
        [
          org.organizationId,
          `organization:${org.organizationId}`,
          at.toISOString(),
          MAX_REFUSALS_PER_HOUR - 1,
        ],
      );
      const member = await join(org, 'member');
      const other = await join(org, 'other');
      expect(await auditRefusal(db(), member, { code: 'FORBIDDEN', surface: 'web', now: at })).toBe(
        true,
      );
      expect(await auditRefusal(db(), other, { code: 'FORBIDDEN', surface: 'web', now: at })).toBe(
        false,
      );
      expect(await refusalsIn(org.organizationId)).toHaveLength(MAX_REFUSALS_PER_HOUR);
    });

    it('files a forged tenant under that tenant, out of sight of the person’s own', async () => {
      const org = await newOrg();
      const rival = await newOrg('rival');
      const rivalMember = await join(rival, 'rival-member');
      expect(
        await auditTenantRefusal(db(), {
          userId: org.userId,
          organizationId: rival.organizationId,
          surface: 'api',
        }),
      ).toBe(true);
      expect(await refusalsIn(rival.organizationId)).toEqual([
        {
          actor_id: org.userId,
          action: 'access.refused.api',
          target_ref: `organization:${rival.organizationId}`,
          decision: 'deny',
          safe_reason: 'TENANT_ACCESS_DENIED',
        },
      ]);
      // The other tenant's owner can read it. The person who tried cannot, from their own tenant.
      const seenBy = async (context: TenantContext) =>
        (await listAuditEvents(db(), context)).filter((row) =>
          row.action.startsWith('access.refused'),
        );
      expect(await seenBy(rival)).toHaveLength(1);
      expect(await seenBy(org)).toEqual([]);
      // Nor can an ordinary member of the tenant it is about.
      await expect(listAuditEvents(db(), rivalMember)).rejects.toBeInstanceOf(TenantAccessDenied);
    });

    it('writes nothing, and does not fail, for a tenant that does not exist', async () => {
      const org = await newOrg();
      const missing = randomUUID();
      expect(
        await auditTenantRefusal(db(), {
          userId: org.userId,
          organizationId: missing,
          surface: 'web',
        }),
      ).toBe(false);
      expect(
        await auditTenantRefusal(db(), {
          userId: org.userId,
          organizationId: "x' or 1=1--",
          surface: 'web',
        }),
      ).toBe(false);
      expect(await refusalsIn(missing)).toEqual([]);
    });

    it('leaves out what is an ordinary mistake rather than a refusal', () => {
      for (const ordinary of ['INVALID_INPUT', 'VERSION_CONFLICT', 'REASON_REQUIRED'] as const) {
        expect(isAuditedRefusal(new AppError(ordinary))).toBe(false);
      }
      for (const refused of ['FORBIDDEN', 'INVALID_TRANSITION', 'NOT_FOUND'] as const) {
        expect(isAuditedRefusal(new AppError(refused))).toBe(true);
      }
      expect(isAuditedRefusal(new Error('FORBIDDEN'))).toBe(false);
    });
  });

  describe('the inbox (UX-17)', () => {
    /** Adds notifications directly, so a test can put them in the past. */
    async function notifications(
      person: TenantContext,
      count: number,
      fields: { kind: string; ageHours: number; read?: boolean; remindAt?: Date },
    ) {
      const { rows } = await su.query(
        `insert into platform.notifications
           (organization_id, recipient_membership_id, kind, target_ref, created_at, read_at, remind_at)
         select $1, $2, $3, 'work_unit:' || gen_random_uuid(),
                now() - ($4::int * interval '1 hour'),
                case when $5::boolean then now() end, $6::timestamptz
         from generate_series(1, $7::int)
         returning id`,
        [
          person.organizationId,
          person.membershipId,
          fields.kind,
          fields.ageHours,
          fields.read ?? false,
          fields.remindAt?.toISOString() ?? null,
          count,
        ],
      );
      return rows.map((row) => row.id as string);
    }

    it('keeps old unread items when a full page of newer ones has been read', async () => {
      const org = await newOrg();
      const [old] = await notifications(org, 1, { kind: 'old.unread', ageHours: 500 });
      await notifications(org, INBOX_SIZE + 5, { kind: 'newer.read', ageHours: 1, read: true });
      const listed = await listMyNotifications(db(), org);
      expect(listed).toHaveLength(INBOX_SIZE);
      expect(listed[0]?.id).toBe(old);
    });

    it('moves a reminded item to the top, even from behind a full page of new ones', async () => {
      const org = await newOrg();
      const now = new Date();
      const [reminded] = await notifications(org, 1, {
        kind: 'old.reminded',
        ageHours: 500,
        remindAt: new Date(now.getTime() - 1000),
      });
      await notifications(org, INBOX_SIZE + 5, { kind: 'newer.unread', ageHours: 1 });
      const before = await listMyNotifications(db(), org);
      expect(before.map((n) => n.id)).not.toContain(reminded);

      expect(await sendDueReminders(db(), org, now)).toBe(1);
      const after = await listMyNotifications(db(), org);
      expect(after[0]).toMatchObject({ id: reminded, remindersSent: 1 });
      expect(after[0]?.lastRemindedAt?.toISOString()).toBe(now.toISOString());
      expect(after).toHaveLength(INBOX_SIZE);
      // Nothing unread was lost: the count still has them, and the page says so.
      expect(await countUnread(db(), org)).toBe(INBOX_SIZE + 6);
    });

    it('brings the next one up as each is opened', async () => {
      const org = await newOrg();
      const oldest = await notifications(org, 1, { kind: 'oldest', ageHours: 500 });
      await notifications(org, INBOX_SIZE, { kind: 'newer', ageHours: 1 });
      const first = await listMyNotifications(db(), org);
      expect(first.map((n) => n.id)).not.toContain(oldest[0]);
      await markRead(db(), org, first[0]?.id as string);
      const second = await listMyNotifications(db(), org);
      expect(second.map((n) => n.id)).toContain(oldest[0]);
    });

    it('puts something read below everything unread, reminded or not', async () => {
      const org = await newOrg();
      const now = new Date();
      const [reminded] = await notifications(org, 1, {
        kind: 'reminded',
        ageHours: 100,
        remindAt: new Date(now.getTime() - 1000),
      });
      await sendDueReminders(db(), org, now);
      const [unread] = await notifications(org, 1, { kind: 'unread', ageHours: 50 });
      const [read] = await notifications(org, 1, { kind: 'read', ageHours: 0, read: true });
      expect((await listMyNotifications(db(), org)).map((n) => n.id)).toEqual([
        reminded,
        unread,
        read,
      ]);
      await markRead(db(), org, reminded as string);
      expect((await listMyNotifications(db(), org))[0]?.id).toBe(unread);
    });

    it('stops reminding after three, and never reaches into another tenant', async () => {
      const org = await newOrg();
      const rival = await newOrg('rival');
      let now = new Date();
      await notifications(org, 1, {
        kind: 'unanswered',
        ageHours: 100,
        remindAt: new Date(now.getTime() - 1000),
      });
      await notifications(rival, 1, {
        kind: 'theirs',
        ageHours: 100,
        remindAt: new Date(now.getTime() - 1000),
      });
      for (const expected of [1, 1, 1, 0]) {
        expect(await sendDueReminders(db(), org, now)).toBe(expected);
        now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
      }
      expect((await listMyNotifications(db(), org))[0]?.remindersSent).toBe(3);
      expect((await listMyNotifications(db(), rival))[0]?.remindersSent).toBe(0);
    });
  });
});
