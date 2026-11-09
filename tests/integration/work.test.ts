// WORK-01 to WORK-05, ID-02, LIFE-01, UX-15, UX-16, QA-001 to QA-007, Gate B. Real roles, real SQL.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addArtifact,
  addDependency,
  addTeamMember,
  assignContributor,
  confirmInvitation,
  countUnread,
  createClient,
  createInvitation,
  createTeam,
  createWorkUnit,
  decideApproval,
  deleteArtifact,
  deleteArtifactInTx,
  disableMember,
  expireApproval,
  expireApprovalStatus,
  expireOverdueApprovals,
  getApproval,
  getWorkDetail,
  getWorkUnit,
  getWorkWithCompletion,
  listHeldRuns,
  listClients,
  listInvitations,
  listMyNotifications,
  listMyPendingApprovals,
  listMyWork,
  listTeams,
  listWorkUnits,
  markRead,
  objectKey,
  purgeDueBlobs,
  readArtifact,
  removeDependency,
  removeStoppedHiddenPrerequisites,
  removeTeamMember,
  requestApproval,
  requestExecution,
  requestWorkReview,
  revokeInvitation,
  sendDueReminders,
  setMemberRole,
  setOwner,
  setTeamParent,
  transitionWorkUnit,
  unassign,
  updateWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { actionHash, checkExecution, type ProposedAction } from '@ensemus/domain/approval';
import type { WorkState } from '@ensemus/domain/work-unit';
import { createServiceContext } from '@ensemus/database/service';
import { createActivities } from '@ensemus/workflows/activities';
import { sql } from 'drizzle-orm';
import { inFixtureTenant } from '../helpers/fixture-tenant';
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
  // Explicit test-only unversioned map model, as in saas-lifecycle-fixture. Purging needs these two,
  // as it does from the production S3 adapter; without them nothing can certify the bytes are gone.
  async deleteForPurge(key: string) {
    try {
      await this.delete(key);
    } catch {
      return { transport: 'unknown' as const, capabilityVerified: false };
    }
    return { transport: 'deleted' as const, capabilityVerified: true };
  }
  async isPhysicallyAbsent(key: string) {
    return !this.objects.has(key);
  }
}

/** The same bytes while the store is unreachable, answering as the production S3 adapter does: its
 * capability preflight fails, so a purge DELETE is never attempted and absence cannot be read. */
function downStore(store: MemoryStore): ObjectStore {
  return {
    put: store.put.bind(store),
    get: store.get.bind(store),
    exists: store.exists.bind(store),
    delete: async () => {
      throw new Error('storage down');
    },
    deleteForPurge: async () => ({ transport: 'not_attempted', capabilityVerified: false }),
    isPhysicallyAbsent: async () => {
      throw new Error('storage down');
    },
  };
}

const code = (name: string) => expect.objectContaining({ code: name });

describe('work', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  const db = () => app.db;

  async function makeUser(label: string, emailVerified = false) {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query(
      'insert into identity.users (id, name, email, email_verified) values ($1, $2, $3, $4)',
      [id, label, email, emailVerified],
    );
    return { id, email };
  }

  async function join(context: TenantContext, label: string, role: 'admin' | 'member' = 'member') {
    const user = await makeUser(label, true);
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

  /** Moves work through these statuses, each from whatever version it has reached. */
  async function move(context: TenantContext, id: string, statuses: WorkState[], reason?: string) {
    let current = await getWorkUnit(db(), context, id);
    for (const to of statuses) {
      current = await transitionWorkUnit(db(), context, {
        id,
        expectedVersion: current.version,
        to,
        ...(reason ? { reason } : {}),
      });
    }
    return current;
  }

  const auditRows = async (context: TenantContext, action: string) => {
    const rows = await withTenantTx(db(), context, (tx) =>
      tx.execute(sql`select actor_id, target_ref, safe_reason from governance.audit_events
        where action = ${action} order by occurred_at`),
    );
    return rows.rows as Array<{
      actor_id: string | null;
      target_ref: string;
      safe_reason: string | null;
    }>;
  };

  const eventTypes = async (context: TenantContext, id: string) => {
    const rows = await withTenantTx(db(), context, (tx) =>
      tx.execute(sql`select event_type from platform.domain_events where aggregate_id = ${id}`),
    );
    return rows.rows.map((row) => row.event_type as string);
  };

  /** A second connection, able to hold a lock open while a service runs into it. */
  async function superuser() {
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    return su;
  }

  /** Waits until a service has really blocked on a lock, which is the moment a race is decided. */
  const blockedOnLock = (su: pg.Client) =>
    expect
      .poll(
        async () => {
          const { rows } = await su.query(
            `select count(*)::int as n from pg_stat_activity
             where application_name = 'ensemus' and wait_event_type = 'Lock'`,
          );
          return rows[0].n as number;
        },
        { timeout: 10_000, interval: 25 },
      )
      .toBeGreaterThan(0);

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

  describe('creating an organization from one form', () => {
    const create = (userId: string, requestKey?: string) =>
      createOrganization(db(), {
        userId,
        name: 'Once',
        commercialMode: 'byom',
        ...(requestKey ? { requestKey } : {}),
      });

    const count = async (userId: string) => {
      const su = await superuser();
      const { rows } = await su.query(
        'select count(*)::int as n from org.memberships where user_id = $1',
        [userId],
      );
      await su.end();
      return rows[0].n as number;
    };

    it('makes one, however many times the same form is sent, even at once', async () => {
      const user = await makeUser('double-click');
      const key = randomUUID();
      const [first, second, third] = await Promise.all([
        create(user.id, key),
        create(user.id, key),
        create(user.id, key),
      ]);
      expect(second?.organizationId).toBe(first?.organizationId);
      expect(third?.organizationId).toBe(first?.organizationId);
      expect(third?.membershipId).toBe(first?.membershipId);
      expect((await create(user.id, key)).organizationId).toBe(first?.organizationId);
      expect(await count(user.id)).toBe(1);
      const context = await resolveTenantContext(db(), user.id, first!.organizationId);
      expect(context.role).toBe('owner');
      expect(await eventTypes(context, first!.organizationId)).toEqual(['organization.created']);
    });

    it('makes another from another form', async () => {
      const user = await makeUser('two-forms');
      const one = await create(user.id, randomUUID());
      const two = await create(user.id, randomUUID());
      expect(two.organizationId).not.toBe(one.organizationId);
      expect(await count(user.id)).toBe(2);
    });

    it('cannot lead to somebody else’s organization by reusing their key', async () => {
      const victim = await makeUser('victim');
      const attacker = await makeUser('attacker');
      const key = randomUUID();
      const theirs = await create(victim.id, key);
      const mine = await create(attacker.id, key);
      expect(mine.organizationId).not.toBe(theirs.organizationId);
      await expect(
        resolveTenantContext(db(), attacker.id, theirs.organizationId),
      ).rejects.toThrow();
    });

    it('still makes a new one when no key is sent', async () => {
      const user = await makeUser('no-key');
      expect((await create(user.id)).organizationId).not.toBe(
        (await create(user.id)).organizationId,
      );
    });
  });

  describe('creating work from one form', () => {
    const titled = async (id: string) => {
      const su = await superuser();
      try {
        const { rows } = await su.query(
          `select (select count(*)::int from work.work_units where id = $1) as units,
                  (select count(*)::int from work.work_assignments where work_unit_id = $1) as people,
                  (select count(*)::int from platform.domain_events
                    where aggregate_id = $1 and event_type = 'work.created') as events`,
          [id],
        );
        return rows[0];
      } finally {
        await su.end();
      }
    };

    it('makes one Work Unit however many times the same form is sent', async () => {
      const a = await newOrg();
      const requestKey = randomUUID();
      const [one, two] = await Promise.all([
        createWorkUnit(db(), a, { title: 'Sent twice at once', requestKey }),
        createWorkUnit(db(), a, { title: 'Sent twice at once', requestKey }),
      ]);
      const three = await createWorkUnit(db(), a, { title: 'Sent twice at once', requestKey });
      expect(two.id).toBe(one.id);
      expect(three.id).toBe(one.id);
      expect(await titled(one.id)).toEqual({ units: 1, people: 1, events: 1 });
    });

    it('does not drop what was typed when that form comes back with something else', async () => {
      const a = await newOrg();
      const requestKey = randomUUID();
      const one = await createWorkUnit(db(), a, { title: 'Typed first', requestKey });
      const two = await createWorkUnit(db(), a, { title: 'Typed after going back', requestKey });
      expect(two.id).not.toBe(one.id);
      expect(two.title).toBe('Typed after going back');
      expect(await titled(one.id)).toEqual({ units: 1, people: 1, events: 1 });
      expect(await titled(two.id)).toEqual({ units: 1, people: 1, events: 1 });
    });

    it('makes another when the form is a new one', async () => {
      const a = await newOrg();
      const one = await createWorkUnit(db(), a, { title: 'Same', requestKey: randomUUID() });
      const two = await createWorkUnit(db(), a, { title: 'Same', requestKey: randomUUID() });
      const three = await createWorkUnit(db(), a, { title: 'Same' });
      expect(new Set([one.id, two.id, three.id]).size).toBe(3);
    });

    it('gives nothing back of someone else’s, whoever holds the same key', async () => {
      const a = await newOrg();
      const colleague = await join(a, 'colleague');
      const stranger = await newOrg('stranger');
      const requestKey = randomUUID();
      const mine = await createWorkUnit(db(), a, {
        title: 'Restricted original',
        classification: 'restricted',
        requestKey,
      });
      const theirs = await createWorkUnit(db(), colleague, { title: 'Theirs', requestKey });
      const outside = await createWorkUnit(db(), stranger, { title: 'Outside', requestKey });
      expect(theirs.id).not.toBe(mine.id);
      expect(theirs.title).toBe('Theirs');
      expect(outside.title).toBe('Outside');
      await expect(getWorkUnit(db(), colleague, mine.id)).rejects.toEqual(code('NOT_FOUND'));
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
        // The loser is told why. A deadlock abort would pass the count above and reach them as a 500.
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(result.reason).toEqual(code('DEPENDENCY_CYCLE'));
          }
        }
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

    describe('with no criteria (QA-006)', () => {
      it('cannot skip checking, and takes the accountable owner to confirm it', async () => {
        const a = await newOrg();
        const admin = await join(a, 'admin', 'admin');
        const work = await createWorkUnit(db(), a, { title: 'No criteria' });
        const running = await move(a, work.id, ['ready', 'running']);
        await expect(
          transitionWorkUnit(db(), a, {
            id: work.id,
            expectedVersion: running.version,
            to: 'completed',
          }),
        ).rejects.toEqual(code('INVALID_TRANSITION'));

        const checking = await move(a, work.id, ['verifying']);
        // An admin can change this work, and still cannot answer for it.
        await expect(
          transitionWorkUnit(db(), admin, {
            id: work.id,
            expectedVersion: checking.version,
            to: 'completed',
          }),
        ).rejects.toEqual(code('OWNER_CONFIRMATION_REQUIRED'));
        expect((await getWorkUnit(db(), a, work.id)).status).toBe('verifying');
        expect((await getWorkWithCompletion(db(), a, work.id)).completion).toBeNull();

        await move(a, work.id, ['completed']);
        const { history } = await getWorkDetail(db(), a, work.id);
        expect(history[0]).toMatchObject({
          toStatus: 'completed',
          completionBasis: 'owner_confirmed',
          actorName: expect.stringContaining('owner'),
        });
        expect(history.filter((h) => h.completionBasis !== null)).toHaveLength(1);
        const { completion } = await getWorkWithCompletion(db(), a, work.id);
        expect(completion).toMatchObject({
          basis: 'owner_confirmed',
          confirmedBy: a.membershipId,
        });
      });

      it('moves with ownership, so the new owner confirms and the old one cannot', async () => {
        const a = await newOrg();
        const next = await join(a, 'next', 'admin');
        const work = await createWorkUnit(db(), a, { title: 'Handed over' });
        await move(a, work.id, ['ready', 'running', 'verifying']);
        const current = await getWorkUnit(db(), a, work.id);
        const moved = await setOwner(db(), a, {
          id: work.id,
          expectedVersion: current.version,
          ownerMembershipId: next.membershipId,
        });
        await expect(
          transitionWorkUnit(db(), a, {
            id: work.id,
            expectedVersion: moved.version,
            to: 'completed',
          }),
        ).rejects.toEqual(code('OWNER_CONFIRMATION_REQUIRED'));
        await move(next, work.id, ['completed']);
        expect((await getWorkWithCompletion(db(), a, work.id)).completion?.confirmedBy).toBe(
          next.membershipId,
        );
      });

      it('cannot be confirmed by a service acting for the tenant', async () => {
        const a = await newOrg();
        const work = await createWorkUnit(db(), a, { title: 'W' });
        const checking = await move(a, work.id, ['ready', 'running', 'verifying']);
        await expect(
          transitionWorkUnit(db(), createServiceContext(a.organizationId), {
            id: work.id,
            expectedVersion: checking.version,
            to: 'completed',
          }),
        ).rejects.toEqual(code('OWNER_CONFIRMATION_REQUIRED'));
      });

      it('is not available from another tenant', async () => {
        const a = await newOrg();
        const b = await newOrg();
        const work = await createWorkUnit(db(), a, { title: 'W' });
        await move(a, work.id, ['ready', 'running', 'verifying', 'completed']);
        await expect(getWorkWithCompletion(db(), b, work.id)).rejects.toEqual(code('NOT_FOUND'));
      });
    });

    it('records evidence as the basis when criteria were met, whoever marks it', async () => {
      const a = await newOrg();
      const admin = await join(a, 'admin', 'admin');
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, {
        title: 'Has criteria',
        completionCriteria: [{ kind: 'artifact_exists' }],
      });
      await addArtifact(db(), store, a, {
        workUnitId: work.id,
        name: 'report.pdf',
        mimeType: 'application/pdf',
        body: Buffer.from('evidence'),
      });
      await move(a, work.id, ['ready', 'running', 'verifying']);
      await move(admin, work.id, ['completed']);
      expect((await getWorkWithCompletion(db(), a, work.id)).completion).toMatchObject({
        basis: 'evidence',
        confirmedBy: admin.membershipId,
      });
    });

    it('retries failed work only with a reason', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'Failed' });
      const failed = await move(a, work.id, ['ready', 'running', 'failed']);
      await expect(
        transitionWorkUnit(db(), a, { id: work.id, expectedVersion: failed.version, to: 'ready' }),
      ).rejects.toEqual(code('REASON_REQUIRED'));
      await expect(
        transitionWorkUnit(db(), a, {
          id: work.id,
          expectedVersion: failed.version,
          to: 'ready',
          reason: '   ',
        }),
      ).rejects.toEqual(code('REASON_REQUIRED'));
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('failed');
      const retried = await transitionWorkUnit(db(), a, {
        id: work.id,
        expectedVersion: failed.version,
        to: 'ready',
        reason: 'The supplier answered',
      });
      expect(retried.status).toBe('ready');
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
    it.each(['public', 'internal', 'confidential', 'restricted'] as const)(
      'preserves the native %s Work viewer matrix',
      async (classification) => {
        const owner = await newOrg();
        const admin = await join(owner, 'admin', 'admin');
        const author = await join(owner, 'author');
        const assigned = await join(owner, 'assigned');
        const uninvolved = await join(owner, 'uninvolved');
        const foreign = await newOrg();
        const work = await createWorkUnit(db(), author, { title: 'Viewer matrix', classification });
        await assignContributor(db(), author, { id: work.id, membershipId: assigned.membershipId });
        for (const [viewer, allowed] of [
          [author, true],
          [assigned, true],
          [owner, classification !== 'restricted'],
          [admin, classification !== 'restricted'],
          [uninvolved, classification === 'public' || classification === 'internal'],
          [foreign, false],
        ] as const) {
          const projection = await withTenantTx(db(), viewer, (tx) =>
            tx.execute<{ readable: boolean }>(
              sql`select knowledge.can_read_work(${work.id}::uuid,${viewer.membershipId}::uuid) as readable`,
            ),
          );
          expect(projection.rows[0]?.readable).toBe(allowed);
          if (allowed) {
            expect((await getWorkUnit(db(), viewer, work.id)).id).toBe(work.id);
          } else {
            await expect(getWorkUnit(db(), viewer, work.id)).rejects.toEqual(code('NOT_FOUND'));
          }
          expect(
            (await listWorkUnits(db(), viewer)).items.some((item) => item.id === work.id),
          ).toBe(allowed);
        }
      },
    );

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
      // Told that it holds this up, and nothing about what it is.
      expect(detail.hiddenPrerequisites).toEqual({ unfinished: 1, stopped: 0 });
      expect(JSON.stringify(detail)).not.toContain(hidden.id);
      expect(JSON.stringify(detail)).not.toContain('Hidden');
    });

    describe('a hidden prerequisite that was stopped', () => {
      async function heldUp() {
        const a = await newOrg();
        const bob = await join(a, 'bob');
        const stranger = await join(a, 'stranger');
        const hidden = await createWorkUnit(db(), a, {
          title: 'Hidden title',
          classification: 'restricted',
        });
        const dependent = await createWorkUnit(db(), bob, { title: 'Bob’s work' });
        await addDependency(db(), a, { dependentId: dependent.id, prerequisiteId: hidden.id });
        return { a, bob, stranger, hidden, dependent };
      }

      it('holds the work up, is counted, and can be removed without being named', async () => {
        const { a, bob, hidden, dependent } = await heldUp();
        await move(a, hidden.id, ['cancelled']);

        const detail = await getWorkDetail(db(), bob, dependent.id);
        expect(detail.prerequisites).toEqual([]);
        expect(detail.hiddenPrerequisites).toEqual({ unfinished: 1, stopped: 1 });
        expect(JSON.stringify(detail)).not.toContain('Hidden title');
        await expect(move(bob, dependent.id, ['ready'])).rejects.toEqual(
          code('PREREQUISITES_INCOMPLETE'),
        );

        const removed = await removeStoppedHiddenPrerequisites(db(), bob, {
          dependentId: dependent.id,
        });
        expect(removed).toBe(1);
        expect((await getWorkDetail(db(), bob, dependent.id)).hiddenPrerequisites).toEqual({
          unfinished: 0,
          stopped: 0,
        });
        expect((await move(bob, dependent.id, ['ready'])).status).toBe('ready');
        expect(await eventTypes(a, dependent.id)).toContain('work.dependency_removed');
        expect(
          (await auditRows(a, 'work.dependency_removed')).map((row) => row.safe_reason),
        ).toEqual(['HIDDEN_PREREQUISITE_STOPPED']);
      });

      it('leaves one that can still finish, so it keeps holding the work', async () => {
        const { bob, dependent } = await heldUp();
        expect(
          await removeStoppedHiddenPrerequisites(db(), bob, { dependentId: dependent.id }),
        ).toBe(0);
        await expect(move(bob, dependent.id, ['ready'])).rejects.toEqual(
          code('PREREQUISITES_INCOMPLETE'),
        );
      });

      it('leaves one the person can see, which has its own control', async () => {
        const a = await newOrg();
        const visible = await createWorkUnit(db(), a, { title: 'Visible' });
        const dependent = await createWorkUnit(db(), a, { title: 'Dependent' });
        await addDependency(db(), a, { dependentId: dependent.id, prerequisiteId: visible.id });
        await move(a, visible.id, ['cancelled']);
        expect(await removeStoppedHiddenPrerequisites(db(), a, { dependentId: dependent.id })).toBe(
          0,
        );
        expect((await getWorkDetail(db(), a, dependent.id)).prerequisites).toHaveLength(1);
      });

      it('needs change rights on the dependent work, and stays inside the tenant', async () => {
        const { a, stranger, hidden, dependent } = await heldUp();
        const b = await newOrg();
        await move(a, hidden.id, ['cancelled']);
        await expect(
          removeStoppedHiddenPrerequisites(db(), stranger, { dependentId: dependent.id }),
        ).rejects.toEqual(code('FORBIDDEN'));
        await expect(
          removeStoppedHiddenPrerequisites(db(), b, { dependentId: dependent.id }),
        ).rejects.toEqual(code('NOT_FOUND'));
        expect((await getWorkDetail(db(), a, dependent.id)).hiddenPrerequisites.unfinished).toBe(0);
        // Still there for someone without access to it: nothing above removed it.
        expect(
          (await getWorkDetail(db(), stranger, dependent.id)).hiddenPrerequisites.stopped,
        ).toBe(1);
      });

      it('is refused on finished work', async () => {
        const { a, bob, hidden, dependent } = await heldUp();
        await move(a, hidden.id, ['cancelled']);
        await move(bob, dependent.id, ['cancelled']);
        await expect(
          removeStoppedHiddenPrerequisites(db(), bob, { dependentId: dependent.id }),
        ).rejects.toEqual(code('INVALID_STATE'));
      });
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
        reason: 'Not good enough',
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
      // Checked against the row as stored. Reviews reach this same check through reviewCovers.
      const { approval } = await getApproval(db(), a, created.id);
      const stored = {
        status: approval.status as 'approved',
        expiresAt: approval.expiresAt,
        boundHash: approval.actionHash,
      };
      const now = new Date();
      expect(checkExecution(stored, { action: action(), now })).toEqual({ ok: true });
      expect(checkExecution(stored, { action: action('attacker@example.invalid'), now })).toEqual({
        ok: false,
        reason: 'HASH_MISMATCH',
      });
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

      // Asking yourself is refused at the request, because nobody could ever decide it.
      await expect(
        requestApproval(db(), approver, {
          workUnitId: work.id,
          action: action('x@example.invalid'),
          approverMembershipId: approver.membershipId,
          expiresAt: hour(),
        }),
      ).rejects.toEqual(code('APPROVAL_SELF_APPROVAL'));
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('running');
      expect(await listMyPendingApprovals(db(), approver)).toEqual([]);
    });

    it('refuses a review addressed to whoever asks for it, through the form path too', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const running = await move(a, work.id, ['ready', 'running']);
      await expect(
        requestWorkReview(db(), a, {
          workUnitId: work.id,
          expectedVersion: running.version,
          approverMembershipId: a.membershipId,
        }),
      ).rejects.toEqual(code('APPROVAL_SELF_APPROVAL'));
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('running');
    });

    it('waits for a change to the approver, then sees it, instead of missing it', async () => {
      const { a, approver, work } = await setup();
      const su = await superuser();
      try {
        // Disabled, but not committed yet. A plain read here would still see them as active.
        await su.query('begin');
        // Bound to the row's tenant, as the export-epoch trigger requires of every writer.
        await su.query("select set_config('app.organization_id',$1,true)", [a.organizationId]);
        await su.query(`update org.memberships set status = 'disabled' where id = $1`, [
          approver.membershipId,
        ]);
        const request = requestApproval(db(), a, {
          workUnitId: work.id,
          action: action(),
          approverMembershipId: approver.membershipId,
          expiresAt: hour(),
        });
        await blockedOnLock(su);
        await su.query('commit');
        await expect(request).rejects.toEqual(code('INVALID_INPUT'));
      } finally {
        await su.query('rollback').catch(() => undefined);
        await su.end();
      }
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('running');
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

    it('sends one reminder when one is due, and the next only a day later', async () => {
      const { a, approver, work } = await setup();
      await requestApproval(db(), a, {
        workUnitId: work.id,
        action: action(),
        approverMembershipId: approver.membershipId,
        // Still open when the reminder falls due: one past its time can no longer be decided.
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
      const user = await makeUser('invitee', true);
      const { token } = await createInvitation(db(), a, { email: user.email, role: 'admin' });
      await acceptInvitation(db(), {
        token,
        userId: user.id,
        email: user.email,
        emailVerified: true,
      });
      const context = await resolveTenantContext(db(), user.id, a.organizationId);
      expect(context.role).toBe('admin');
      await expect(resolveTenantContext(db(), user.id, b.organizationId)).rejects.toThrow();
    });

    it('works once', async () => {
      const a = await newOrg();
      const user = await makeUser('invitee', true);
      const { token } = await createInvitation(db(), a, { email: user.email });
      await acceptInvitation(db(), {
        token,
        userId: user.id,
        email: user.email,
        emailVerified: true,
      });
      await expect(
        acceptInvitation(db(), { token, userId: user.id, email: user.email, emailVerified: true }),
      ).rejects.toEqual(code('INVITATION_INVALID'));
    });

    it('refuses a guessed token, the wrong person and a revoked invitation alike', async () => {
      const a = await newOrg();
      const invited = await makeUser('invited');
      const stranger = await makeUser('stranger');
      const { id, token } = await createInvitation(db(), a, { email: invited.email });
      const bad = code('INVITATION_INVALID');
      await expect(
        acceptInvitation(db(), {
          token: 'guess',
          userId: invited.id,
          email: invited.email,
          emailVerified: true,
        }),
      ).rejects.toEqual(bad);
      await expect(
        acceptInvitation(db(), {
          token,
          userId: stranger.id,
          email: stranger.email,
          emailVerified: true,
        }),
      ).rejects.toEqual(bad);
      await revokeInvitation(db(), a, { invitationId: id });
      await expect(
        acceptInvitation(db(), {
          token,
          userId: invited.id,
          email: invited.email,
          emailVerified: true,
        }),
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
      const broken = downStore(store);
      // The person is done once access is blocked: the bytes are recorded as still to remove.
      await deleteArtifact(db(), broken, a, { workUnitId: work.id, artifactId: id });
      await expect(
        readArtifact(db(), store, a, { workUnitId: work.id, artifactId: id }),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('removes the bytes later if the store was down when they were deleted (LIFE-01)', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await upload(a, store, work.id);
      const broken = downStore(store);
      await deleteArtifact(db(), broken, a, { workUnitId: work.id, artifactId: id });
      expect(store.objects.size).toBe(1);

      // Still down: nothing is lost, and the attempt is counted.
      expect(await purgeDueBlobs(db(), broken, a)).toEqual({ purged: 0, failed: 1 });
      expect(store.objects.size).toBe(1);

      // It has backed off, so the very next sweep leaves it alone.
      expect(await purgeDueBlobs(db(), store, a)).toEqual({ purged: 0, failed: 0 });
      expect(store.objects.size).toBe(1);

      // Back up: the bytes go, and it is recorded as verified, so it is not done twice.
      const later = new Date(Date.now() + 16 * 60 * 1000);
      expect(await purgeDueBlobs(db(), store, a, later)).toEqual({ purged: 1, failed: 0 });
      expect(store.objects.size).toBe(0);
      expect(await purgeDueBlobs(db(), store, a, later)).toEqual({ purged: 0, failed: 0 });
      const rows = await withTenantTx(db(), a, (tx) =>
        tx.execute(`select state, attempts, purged_at from platform.blob_lifecycle
          where artifact_id = '${id}'`),
      );
      expect(rows.rows[0]).toMatchObject({ state: 'purged', attempts: 1 });
      expect(rows.rows[0]?.purged_at).toBeTruthy();
    });

    it('does not let rows that keep failing keep the others waiting', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      // Real deleted files, so that every row has the tombstone and catalog entry a purge needs.
      // Deleted in-transaction, as retention does, so no purge has been attempted yet.
      const ids: string[] = [];
      for (let i = 0; i < 51; i++) {
        const { id } = await upload(a, store, work.id);
        await withTenantTx(db(), a, (tx) =>
          deleteArtifactInTx(tx, a, { workUnitId: work.id, artifactId: id }),
        );
        ids.push(id);
      }
      const goodId = ids.pop()!;
      const good = objectKey(a.organizationId, goodId);
      const stuck = new Set(ids.map((id) => objectKey(a.organizationId, id)));
      const su = await superuser();
      try {
        // A full batch of rows that fail, all older than the one that would succeed.
        await inFixtureTenant(su, a.organizationId, async () => {
          await su.query(
            `update platform.blob_lifecycle set purge_after = now() - interval '2 days'
             where organization_id = $1 and artifact_id = any($2::uuid[])`,
            [a.organizationId, ids],
          );
          await su.query(
            `update platform.blob_lifecycle set purge_after = now() - interval '1 day'
             where organization_id = $1 and artifact_id = $2`,
            [a.organizationId, goodId],
          );
        });
      } finally {
        await su.end();
      }
      const flaky: ObjectStore = {
        put: store.put.bind(store),
        get: store.get.bind(store),
        exists: store.exists.bind(store),
        delete: async (key) => {
          if (stuck.has(key)) throw new Error('storage refused this one');
          await store.delete(key);
        },
        // A refused DELETE request is an unknown outcome, as the production adapter reports it.
        deleteForPurge: async (key) =>
          stuck.has(key)
            ? { transport: 'unknown', capabilityVerified: false }
            : store.deleteForPurge(key),
        isPhysicallyAbsent: store.isPhysicallyAbsent.bind(store),
      };
      const now = new Date();
      expect(await purgeDueBlobs(db(), flaky, a, now)).toEqual({ purged: 0, failed: 50 });
      expect(store.objects.has(good)).toBe(true);
      // Without backing off, the same 50 would fill this batch too, and every one after it.
      expect(await purgeDueBlobs(db(), flaky, a, now)).toEqual({ purged: 1, failed: 0 });
      expect(store.objects.has(good)).toBe(false);

      // They come back, each waiting longer than the time before.
      const after = new Date(now.getTime() + 16 * 60 * 1000);
      expect(await purgeDueBlobs(db(), flaky, a, after)).toEqual({ purged: 0, failed: 50 });
      expect(await purgeDueBlobs(db(), flaky, a, after)).toEqual({ purged: 0, failed: 0 });
      expect(
        await purgeDueBlobs(db(), flaky, a, new Date(after.getTime() + 31 * 60 * 1000)),
      ).toEqual({ purged: 0, failed: 50 });
    });

    it('does not call bytes gone when the store still has them', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await upload(a, store, work.id);
      const lying: ObjectStore = {
        put: store.put.bind(store),
        get: store.get.bind(store),
        exists: store.exists.bind(store),
        delete: async () => undefined,
        // Claims a completed DELETE, while an independent read still finds the bytes.
        deleteForPurge: async () => ({ transport: 'deleted', capabilityVerified: true }),
        isPhysicallyAbsent: store.isPhysicallyAbsent.bind(store),
      };
      await deleteArtifact(db(), lying, a, { workUnitId: work.id, artifactId: id });
      expect(await purgeDueBlobs(db(), lying, a)).toEqual({ purged: 0, failed: 1 });
    });

    it('removes an upload whose row never arrived', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const failing: ObjectStore = {
        put: async (key, body) => {
          store.objects.set(key, body);
          // Bytes stored, then the work is stopped before the row can arrive.
          await transitionWorkUnit(db(), a, {
            id: work.id,
            expectedVersion: 1,
            to: 'cancelled',
          });
        },
        get: store.get.bind(store),
        exists: store.exists.bind(store),
        delete: store.delete.bind(store),
        deleteForPurge: store.deleteForPurge.bind(store),
        isPhysicallyAbsent: store.isPhysicallyAbsent.bind(store),
      };
      await expect(upload(a, failing, work.id)).rejects.toEqual(code('INVALID_STATE'));
      expect(store.objects.size).toBe(1);

      // Not while it could still be on its way, and then once it cannot.
      expect(await purgeDueBlobs(db(), store, a)).toEqual({ purged: 0, failed: 0 });
      const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
      expect(await purgeDueBlobs(db(), store, a, later)).toEqual({ purged: 1, failed: 0 });
      expect(store.objects.size).toBe(0);
    });

    it('leaves no record behind for an upload that succeeded', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await upload(a, store, work.id);
      const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
      expect(await purgeDueBlobs(db(), store, a, later)).toEqual({ purged: 0, failed: 0 });
      expect(store.objects.size).toBe(1);
    });

    it('refuses changing files on finished work and on work under review', async () => {
      const a = await newOrg();
      const approver = await join(a, 'approver', 'admin');
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await upload(a, store, work.id);
      await move(a, work.id, ['ready', 'running']);
      await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: (await getWorkUnit(db(), a, work.id)).version,
        approverMembershipId: approver.membershipId,
      });
      await expect(upload(a, store, work.id)).rejects.toEqual(code('INVALID_STATE'));
      await expect(
        deleteArtifact(db(), store, a, { workUnitId: work.id, artifactId: id }),
      ).rejects.toEqual(code('INVALID_STATE'));

      const done = await createWorkUnit(db(), a, { title: 'Done' });
      const file = await upload(a, store, done.id);
      await move(a, done.id, ['ready', 'running', 'verifying', 'completed']);
      await expect(upload(a, store, done.id)).rejects.toEqual(code('INVALID_STATE'));
      await expect(
        deleteArtifact(db(), store, a, { workUnitId: done.id, artifactId: file.id }),
      ).rejects.toEqual(code('INVALID_STATE'));
    });

    it('still lets a file be deleted from stopped work, which can never be reopened', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await upload(a, store, work.id);
      await move(a, work.id, ['cancelled']);
      await expect(upload(a, store, work.id)).rejects.toEqual(code('INVALID_STATE'));
      await deleteArtifact(db(), store, a, { workUnitId: work.id, artifactId: id });
      expect(store.objects.size).toBe(0);
    });

    it('keeps tombstones append-only', async () => {
      const a = await newOrg();
      await expect(
        withTenantTx(db(), a, (tx) => tx.execute('delete from platform.tombstones')),
      ).rejects.toThrow();
    });
  });

  describe('releasing a pause', () => {
    async function paused(criteria: Array<{ kind: 'reviewer_approved' }> = []) {
      const a = await newOrg();
      const alice = await join(a, 'alice', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'Paused', completionCriteria: criteria });
      const running = await move(a, work.id, ['ready', 'running']);
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: running.version,
        approverMembershipId: alice.membershipId,
      });
      return { a, alice, work, review };
    }

    it('refuses a person releasing paused work without a decision', async () => {
      const { a, work } = await paused();
      const current = await getWorkUnit(db(), a, work.id);
      expect(current.status).toBe('awaiting_approval');
      await expect(
        transitionWorkUnit(db(), a, {
          id: work.id,
          expectedVersion: current.version,
          to: 'running',
        }),
      ).rejects.toEqual(code('INVALID_TRANSITION'));
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
    });

    it('refuses a person pausing work with no approval behind it', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const running = await move(a, work.id, ['ready', 'running']);
      await expect(
        transitionWorkUnit(db(), a, {
          id: work.id,
          expectedVersion: running.version,
          to: 'awaiting_approval',
        }),
      ).rejects.toEqual(code('INVALID_TRANSITION'));
    });

    it('still lets someone stop paused work', async () => {
      const { a, work } = await paused();
      await move(a, work.id, ['cancelled'], 'No longer needed');
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('cancelled');
    });

    it('allows only one open review, so a second cannot override the first', async () => {
      const { a, work } = await paused();
      const carol = await join(a, 'carol', 'admin');
      const current = await getWorkUnit(db(), a, work.id);
      await expect(
        requestWorkReview(db(), a, {
          workUnitId: work.id,
          expectedVersion: current.version,
          approverMembershipId: carol.membershipId,
        }),
      ).rejects.toEqual(code('REVIEW_ALREADY_OPEN'));
    });

    it('refuses a duplicate even from a double-click', async () => {
      const a = await newOrg();
      const alice = await join(a, 'alice', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const results = await Promise.allSettled(
        [0, 1, 2].map(() =>
          requestWorkReview(db(), a, {
            workUnitId: work.id,
            expectedVersion: 1,
            approverMembershipId: alice.membershipId,
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await listMyPendingApprovals(db(), alice)).toHaveLength(1);
    });

    it.each([
      ['approval', 'approve'],
      ['denial', 'deny'],
    ] as const)(
      'does not let the %s of a review that holds nothing move paused work',
      async (_, decision) => {
        const a = await newOrg();
        const carol = await join(a, 'carol', 'admin');
        const work = await createWorkUnit(db(), a, { title: 'W' });
        const plain = await requestWorkReview(db(), a, {
          workUnitId: work.id,
          expectedVersion: 1,
          approverMembershipId: carol.membershipId,
        });
        expect((await getApproval(db(), a, plain.id)).approval.holdsWork).toBe(false);
        // The one-open rule keeps services from ever reaching this, so only direct SQL can, and this
        // shows the decision itself checks what it holds rather than relying on that rule.
        await withTenantTx(db(), a, (tx) =>
          tx.execute(
            `update work.work_units set status = 'awaiting_approval' where id = '${work.id}'`,
          ),
        );
        await decideApproval(db(), carol, {
          approvalId: plain.id,
          decision,
          shownHash: plain.actionHash,
        });
        expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
      },
    );

    it('releases on the decision of the approval that holds the pause', async () => {
      const { a, alice, work, review } = await paused();
      await decideApproval(db(), alice, {
        approvalId: review.id,
        decision: 'approve',
        shownHash: review.actionHash,
      });
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('running');
    });

    it('marks only the approval that caused the pause as holding it', async () => {
      const { a, review } = await paused();
      const { approval } = await getApproval(db(), a, review.id);
      expect(approval.holdsWork).toBe(true);
      const b = await newOrg();
      const carol = await join(b, 'carol', 'admin');
      const queued = await createWorkUnit(db(), b, { title: 'Queued' });
      const plain = await requestWorkReview(db(), b, {
        workUnitId: queued.id,
        expectedVersion: 1,
        approverMembershipId: carol.membershipId,
      });
      expect((await getApproval(db(), b, plain.id)).approval.holdsWork).toBe(false);
    });

    it('cannot have which approval holds the pause changed, even by direct SQL', async () => {
      const { a, review } = await paused();
      await expect(
        withTenantTx(db(), a, (tx) =>
          tx.execute(`update work.approvals set holds_work = false where id = '${review.id}'`),
        ),
      ).rejects.toThrow();
    });
  });

  describe('what a review covers', () => {
    async function reviewed(context: TenantContext) {
      const reviewer = await join(context, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), context, {
        title: 'Reviewed',
        objective: 'As first written',
        completionCriteria: [{ kind: 'reviewer_approved' }],
      });
      const review = await requestWorkReview(db(), context, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });
      await decideApproval(db(), reviewer, {
        approvalId: review.id,
        decision: 'approve',
        shownHash: review.actionHash,
      });
      return { reviewer, work, review };
    }

    it('counts as evidence while the work is exactly what was reviewed', async () => {
      const a = await newOrg();
      const { work } = await reviewed(a);
      const done = await move(a, work.id, ['ready', 'running', 'verifying', 'completed']);
      expect(done.status).toBe('completed');
    });

    it('stops counting once the text changes', async () => {
      const a = await newOrg();
      const { work } = await reviewed(a);
      const edited = await updateWorkUnit(db(), a, work.id, 1, { title: 'Something else' });
      await transitionWorkUnit(db(), a, {
        id: work.id,
        expectedVersion: edited.version,
        to: 'ready',
      });
      const checking = await move(a, work.id, ['running', 'verifying']);
      await expect(
        transitionWorkUnit(db(), a, {
          id: work.id,
          expectedVersion: checking.version,
          to: 'completed',
        }),
      ).rejects.toEqual(code('EVIDENCE_MISSING'));
      const detail = await getWorkDetail(db(), a, work.id);
      expect(detail.evidence.approvedReviewCount).toBe(0);
      expect(detail.reviews[0]?.outdated).toBe(true);
    });

    it('is not fooled by a change of status or due date, which changes nothing reviewed', async () => {
      const a = await newOrg();
      const { work } = await reviewed(a);
      await updateWorkUnit(db(), a, work.id, 1, { dueAt: new Date('2030-01-01') });
      expect((await getWorkDetail(db(), a, work.id)).evidence.approvedReviewCount).toBe(1);
      await move(a, work.id, ['ready', 'running', 'verifying']);
      expect((await getWorkDetail(db(), a, work.id)).evidence.approvedReviewCount).toBe(1);
    });

    it('stops counting once the files change, either way', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const { work } = await reviewed(a);
      const file = await addArtifact(db(), store, a, {
        workUnitId: work.id,
        name: 'new.txt',
        mimeType: 'text/plain',
        body: Buffer.from('x'),
      });
      expect((await getWorkDetail(db(), a, work.id)).evidence.approvedReviewCount).toBe(0);
      // Taking it away again restores exactly what was reviewed.
      await deleteArtifact(db(), store, a, { workUnitId: work.id, artifactId: file.id });
      expect((await getWorkDetail(db(), a, work.id)).evidence.approvedReviewCount).toBe(1);
    });

    it('stops counting after the approval has expired', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });
      await decideApproval(db(), reviewer, {
        approvalId: review.id,
        decision: 'approve',
        shownHash: review.actionHash,
      });
      expect((await getWorkDetail(db(), a, work.id)).evidence.approvedReviewCount).toBe(1);
      await pastDue(a, review.id);
      expect((await getWorkDetail(db(), a, work.id)).evidence.approvedReviewCount).toBe(0);
    });

    it('does not count an approval of some other kind of action', async () => {
      const a = await newOrg();
      const approver = await join(a, 'approver', 'admin');
      const work = await createWorkUnit(db(), a, {
        title: 'W',
        completionCriteria: [{ kind: 'reviewer_approved' }],
      });
      const other = await requestApproval(db(), a, {
        workUnitId: work.id,
        action: {
          toolName: 'email.send',
          toolVersion: '1',
          targetRef: 'connection:abc',
          payload: { to: ['x@example.invalid'] },
        },
        approverMembershipId: approver.membershipId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await decideApproval(db(), approver, {
        approvalId: other.id,
        decision: 'approve',
        shownHash: other.actionHash,
      });
      expect((await getWorkDetail(db(), a, work.id)).evidence.approvedReviewCount).toBe(0);
    });

    it('voids a review when work is reopened, so it needs a new one', async () => {
      const a = await newOrg();
      const { work, review } = await reviewed(a);
      await move(a, work.id, ['ready', 'running', 'verifying', 'completed']);
      await move(a, work.id, ['ready'], 'Client rejected it');
      expect((await getApproval(db(), a, review.id)).approval.status).toBe('cancelled');
      const checking = await move(a, work.id, ['running', 'verifying']);
      await expect(
        transitionWorkUnit(db(), a, {
          id: work.id,
          expectedVersion: checking.version,
          to: 'completed',
        }),
      ).rejects.toEqual(code('EVIDENCE_MISSING'));
    });

    it('closes an open review when the work it covers changes', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });
      await updateWorkUnit(db(), a, work.id, 1, { title: 'Changed' });
      expect((await getApproval(db(), a, review.id)).approval.status).toBe('cancelled');
      expect(await listMyPendingApprovals(db(), reviewer)).toEqual([]);
      expect(await countUnread(db(), reviewer)).toBe(0);
      await expect(
        decideApproval(db(), reviewer, {
          approvalId: review.id,
          decision: 'approve',
          shownHash: review.actionHash,
        }),
      ).rejects.toEqual(code('APPROVAL_NOT_PENDING'));
    });

    it('binds what the server read, and refuses a request naming another version', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await expect(
        requestWorkReview(db(), a, {
          workUnitId: work.id,
          expectedVersion: 999,
          approverMembershipId: reviewer.membershipId,
        }),
      ).rejects.toEqual(code('VERSION_CONFLICT'));
    });

    it('refuses a decision when the bound action no longer matches the work', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });
      // Changed behind the services' back, which is what the check is there to catch.
      await withTenantTx(db(), a, (tx) =>
        tx.execute(`update work.work_units set title = 'Sneaky' where id = '${work.id}'`),
      );
      await expect(
        decideApproval(db(), reviewer, {
          approvalId: review.id,
          decision: 'approve',
          shownHash: review.actionHash,
        }),
      ).rejects.toEqual(code('APPROVAL_STALE'));
    });
  });

  /** Moves an approval's deadline into the past, as only time itself otherwise could. */
  async function pastDue(context: TenantContext, approvalId: string) {
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    await su.query(`update work.approvals set expires_at = now() - interval '1 minute'
      where id = '${approvalId}' and organization_id = '${context.organizationId}'`);
    await su.end();
  }

  describe('closing approvals', () => {
    async function open(context: TenantContext, title = 'W') {
      const reviewer = await join(context, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), context, { title });
      const running = await move(context, work.id, ['ready', 'running']);
      const review = await requestWorkReview(db(), context, {
        workUnitId: work.id,
        expectedVersion: running.version,
        approverMembershipId: reviewer.membershipId,
      });
      return { reviewer, work, review };
    }

    it('closes them when the work is stopped, and clears the notification', async () => {
      const a = await newOrg();
      const { reviewer, work, review } = await open(a);
      await move(a, work.id, ['cancelled']);
      expect((await getApproval(db(), a, review.id)).approval.status).toBe('cancelled');
      expect(await listMyPendingApprovals(db(), reviewer)).toEqual([]);
      expect(await countUnread(db(), reviewer)).toBe(0);
      await expect(
        decideApproval(db(), reviewer, {
          approvalId: review.id,
          decision: 'approve',
          shownHash: review.actionHash,
        }),
      ).rejects.toEqual(code('APPROVAL_NOT_PENDING'));
      expect(await sendDueReminders(db(), a, new Date(Date.now() + 86_400_000))).toBe(0);
    });

    it('closes an open one when the work completes', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });
      await move(a, work.id, ['ready', 'running', 'verifying', 'completed']);
      expect((await getApproval(db(), a, review.id)).approval.status).toBe('cancelled');
    });

    it('expires overdue manual reviews in a sweep, applying the outcome to paused work', async () => {
      const a = await newOrg();
      const { reviewer, work, review } = await open(a);
      await pastDue(a, review.id);
      expect(await listMyPendingApprovals(db(), reviewer)).toEqual([]);

      const service = createServiceContext(a.organizationId);
      expect(await expireOverdueApprovals(db(), service, new Date())).toBe(1);
      expect((await getApproval(db(), a, review.id)).approval.status).toBe('expired');
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('cancelled');
      expect(await countUnread(db(), reviewer)).toBe(0);
      expect((await auditRows(a, 'approval.expired')).map((r) => r.target_ref)).toEqual([
        `approval:${review.id}`,
      ]);
      expect(await eventTypes(a, work.id)).toContain('approval.resolved');
      // The owner hears about it.
      expect((await listMyNotifications(db(), a)).map((n) => n.kind)).toContain('approval.expired');
      expect(await expireOverdueApprovals(db(), service, new Date())).toBe(0);
    });

    describe('replacing one whose time has run out', () => {
      it('needs no sweep, keeps the work paused, and leaves a record', async () => {
        const a = await newOrg();
        const { reviewer, work, review } = await open(a);
        const other = await join(a, 'other', 'admin');
        await pastDue(a, review.id);

        const paused = await getWorkUnit(db(), a, work.id);
        const next = await requestWorkReview(db(), a, {
          workUnitId: work.id,
          expectedVersion: paused.version,
          approverMembershipId: other.membershipId,
        });
        expect((await getApproval(db(), a, review.id)).approval.status).toBe('expired');
        expect((await getApproval(db(), a, next.id)).approval.holdsWork).toBe(true);
        expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
        expect(await countUnread(db(), reviewer)).toBe(0);
        expect(await auditRows(a, 'approval.expired')).toEqual([
          {
            actor_id: a.membershipId,
            target_ref: `approval:${review.id}`,
            safe_reason: 'REPLACED',
          },
        ]);

        // The sweep finds nothing left to stop it for, and the new decision can release it.
        const service = createServiceContext(a.organizationId);
        expect(await expireOverdueApprovals(db(), service, new Date())).toBe(0);
        expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
        await decideApproval(db(), other, {
          approvalId: next.id,
          decision: 'approve',
          shownHash: next.actionHash,
        });
        expect((await getWorkUnit(db(), a, work.id)).status).toBe('running');
      });

      it('still needs one that has time left to be decided first', async () => {
        const a = await newOrg();
        const { work } = await open(a);
        const other = await join(a, 'other', 'admin');
        const paused = await getWorkUnit(db(), a, work.id);
        await expect(
          requestWorkReview(db(), a, {
            workUnitId: work.id,
            expectedVersion: paused.version,
            approverMembershipId: other.membershipId,
          }),
        ).rejects.toEqual(code('REVIEW_ALREADY_OPEN'));
      });

      it('leaves paused work to stop if nobody asks anyone else first', async () => {
        const a = await newOrg();
        const { work, review } = await open(a);
        await pastDue(a, review.id);
        const service = createServiceContext(a.organizationId);
        expect(await expireOverdueApprovals(db(), service, new Date())).toBe(1);
        expect((await getWorkUnit(db(), a, work.id)).status).toBe('cancelled');
        expect((await getApproval(db(), a, review.id)).approval.status).toBe('expired');
        // Stopped because it expired, and recorded as that, not also as closed by the work stopping.
        expect(await auditRows(a, 'approval.closed')).toEqual([]);
      });

      it('records one that held nothing, too', async () => {
        const a = await newOrg();
        const first = await join(a, 'first', 'admin');
        const second = await join(a, 'second', 'admin');
        const work = await createWorkUnit(db(), a, { title: 'W' });
        const review = await requestWorkReview(db(), a, {
          workUnitId: work.id,
          expectedVersion: 1,
          approverMembershipId: first.membershipId,
        });
        await pastDue(a, review.id);
        await requestWorkReview(db(), a, {
          workUnitId: work.id,
          expectedVersion: 1,
          approverMembershipId: second.membershipId,
        });
        expect((await auditRows(a, 'approval.expired')).map((row) => row.target_ref)).toEqual([
          `approval:${review.id}`,
        ]);
      });
    });

    it('reports the status it really found, instead of assuming it expired', async () => {
      const a = await newOrg();
      const { reviewer, review } = await open(a);
      const service = createServiceContext(a.organizationId);
      // Not overdue yet, so nothing has changed and it says so.
      expect(await expireApprovalStatus(db(), service, { approvalId: review.id })).toBe('pending');
      await decideApproval(db(), reviewer, {
        approvalId: review.id,
        decision: 'approve',
        shownHash: review.actionHash,
      });
      // Decided in the meantime: the answer is the decision, not an expiry.
      expect(await expireApprovalStatus(db(), service, { approvalId: review.id })).toBe('approved');
    });

    it('tells the owner when a review is decided, or their work is stopped', async () => {
      const a = await newOrg();
      const { reviewer, work, review } = await open(a);
      await decideApproval(db(), reviewer, {
        approvalId: review.id,
        decision: 'approve',
        shownHash: review.actionHash,
      });
      expect((await listMyNotifications(db(), a))[0]).toMatchObject({
        kind: 'approval.decided',
        targetRef: `work_unit:${work.id}`,
      });
      await move(reviewer, work.id, ['cancelled'], 'Client withdrew');
      expect((await listMyNotifications(db(), a))[0]?.kind).toBe('work.stopped');
    });
  });

  describe('an approver who loses access', () => {
    async function restricted(context: TenantContext, approver: TenantContext) {
      const work = await createWorkUnit(db(), context, {
        title: 'Hidden title',
        classification: 'restricted',
      });
      await assignContributor(db(), context, {
        id: work.id,
        membershipId: approver.membershipId,
      });
      return work;
    }

    it('stops seeing the title after being taken off the work', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const work = await restricted(a, member);
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: member.membershipId,
      });
      expect((await listMyPendingApprovals(db(), member))[0]?.workTitle).toBe('Hidden title');

      await unassign(db(), a, { id: work.id, membershipId: member.membershipId });

      expect(await listMyPendingApprovals(db(), member)).toEqual([]);
      const asked = (await listMyNotifications(db(), member)).find(
        (n) => n.targetRef === `approval:${review.id}`,
      );
      expect(asked?.readAt).toBeTruthy();
      expect((await getApproval(db(), a, review.id)).approval.status).toBe('cancelled');
      await expect(getApproval(db(), member, review.id)).rejects.toEqual(code('NOT_FOUND'));
    });

    it('stops seeing the title after ownership is handed away', async () => {
      const a = await newOrg();
      const alice = await join(a, 'alice');
      const dan = await join(a, 'dan');
      const work = await createWorkUnit(db(), a, {
        title: 'Hidden title',
        classification: 'restricted',
        ownerMembershipId: alice.membershipId,
      });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: alice.membershipId,
      });
      await setOwner(db(), a, {
        id: work.id,
        expectedVersion: 1,
        ownerMembershipId: dan.membershipId,
      });
      expect(await listMyPendingApprovals(db(), alice)).toEqual([]);
      expect(await countUnread(db(), alice)).toBe(0);
      expect((await getApproval(db(), a, review.id)).approval.status).toBe('cancelled');
    });

    it('stops seeing confidential titles after being demoted from admin', async () => {
      const a = await newOrg();
      const admin = await join(a, 'admin', 'admin');
      const work = await createWorkUnit(db(), a, {
        title: 'Hidden title',
        classification: 'confidential',
      });
      await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: admin.membershipId,
      });
      await setMemberRole(db(), a, { membershipId: admin.membershipId, role: 'member' });
      const demoted = await resolveTenantContext(db(), admin.userId, a.organizationId);
      expect(await listMyPendingApprovals(db(), demoted)).toEqual([]);
      expect(await countUnread(db(), demoted)).toBe(0);
    });

    it('filters in the query too, even if an approval was somehow left open', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const work = await restricted(a, member);
      await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: member.membershipId,
      });
      // Access goes without any service running, so nothing closes the approval.
      await withTenantTx(db(), a, (tx) =>
        tx.execute(`delete from work.work_assignments
          where work_unit_id = '${work.id}' and membership_id = '${member.membershipId}'`),
      );
      expect(await listMyPendingApprovals(db(), member)).toEqual([]);
    });

    it('records no closure when the approver decided while it waited for the lock', async () => {
      const a = await newOrg();
      const admin = await join(a, 'admin', 'admin');
      const work = await createWorkUnit(db(), a, {
        title: 'Decided in time',
        classification: 'confidential',
      });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: admin.membershipId,
      });
      const su = await superuser();
      try {
        await su.query('begin');
        await su.query('select 1 from work.work_units where id = $1 for update', [work.id]);
        // Reads the approval as pending, loses sight of the work, then waits for the row above.
        const demotion = setMemberRole(db(), a, {
          membershipId: admin.membershipId,
          role: 'member',
        });
        await blockedOnLock(su);
        await su.query(
          `update work.approvals set status = 'approved', decided_at = now() where id = $1`,
          [review.id],
        );
        await su.query('commit');
        await demotion;
      } finally {
        await su.query('rollback').catch(() => undefined);
        await su.end();
      }
      expect((await getApproval(db(), a, review.id)).approval.status).toBe('approved');
      expect(await auditRows(a, 'approval.closed')).toEqual([]);
      expect((await listMyNotifications(db(), a)).map((n) => n.kind)).not.toContain(
        'approval.closed',
      );
      const events = await withTenantTx(db(), a, (tx) =>
        tx.execute(sql`select payload from platform.domain_events
          where aggregate_id = ${work.id} and event_type = 'approval.resolved'`),
      );
      expect(events.rows).toEqual([]);
    });

    it.each([
      ['disabling', (a: TenantContext, id: string) => disableMember(db(), a, { membershipId: id })],
      [
        'demoting',
        (a: TenantContext, id: string) =>
          setMemberRole(db(), a, { membershipId: id, role: 'member' }),
      ],
    ])(
      '%s someone does not wait on what only refers to them, which could deadlock',
      async (_, change) => {
        const a = await newOrg();
        const admin = await join(a, 'admin', 'admin');
        const su = await superuser();
        try {
          // What inserting a history row by this member takes on their membership.
          await su.query('begin');
          await su.query('select 1 from org.memberships where id = $1 for key share', [
            admin.membershipId,
          ]);
          const outcome = await Promise.race([
            change(a, admin.membershipId).then(() => 'finished'),
            new Promise((done) => setTimeout(() => done('still waiting'), 5_000)),
          ]);
          expect(outcome).toBe('finished');
        } finally {
          await su.query('rollback').catch(() => undefined);
          await su.end();
        }
      },
    );

    it('leaves manual work paused, for someone else to review', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const other = await join(a, 'other');
      const work = await restricted(a, member);
      await assignContributor(db(), a, { id: work.id, membershipId: other.membershipId });
      const running = await move(a, work.id, ['ready', 'running']);
      await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: running.version,
        approverMembershipId: member.membershipId,
      });
      await unassign(db(), a, { id: work.id, membershipId: member.membershipId });
      const stillPaused = await getWorkUnit(db(), a, work.id);
      expect(stillPaused.status).toBe('awaiting_approval');
      // Nobody released it. A new review now holds the pause, and its decision can.
      const next = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: stillPaused.version,
        approverMembershipId: other.membershipId,
      });
      await decideApproval(db(), other, {
        approvalId: next.id,
        decision: 'approve',
        shownHash: next.actionHash,
      });
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('running');
    });
  });

  describe('access through having created the work', () => {
    it('is listed, and removable, once ownership moves', async () => {
      const a = await newOrg();
      const bob = await join(a, 'bob');
      const alice = await join(a, 'alice');
      const work = await createWorkUnit(db(), bob, {
        title: 'HR case',
        classification: 'restricted',
      });
      await setOwner(db(), bob, {
        id: work.id,
        expectedVersion: 1,
        ownerMembershipId: alice.membershipId,
      });

      // Alice can see that Bob still has access.
      const detail = await getWorkDetail(db(), alice, work.id);
      expect(detail.people.map((p) => p.membershipId)).toEqual([bob.membershipId]);
      expect((await getWorkUnit(db(), bob, work.id)).id).toBe(work.id);

      // And she can end it, which also takes it out of his lists.
      await unassign(db(), alice, { id: work.id, membershipId: bob.membershipId });
      await expect(getWorkUnit(db(), bob, work.id)).rejects.toEqual(code('NOT_FOUND'));
      expect((await listWorkUnits(db(), bob)).items).toEqual([]);
      await expect(updateWorkUnit(db(), bob, work.id, 2, { title: 'Still mine?' })).rejects.toEqual(
        code('NOT_FOUND'),
      );
    });

    it('does not list the owner as someone else on the work', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'Mine' });
      expect((await getWorkDetail(db(), a, work.id)).people).toEqual([]);
    });
  });

  describe('invitations and the person who sent them', () => {
    const invite = async (
      by: TenantContext,
      role: 'admin' | 'member' = 'admin',
      emailVerified = true,
    ) => {
      const user = await makeUser('invitee', emailVerified);
      const { id, token } = await createInvitation(db(), by, { email: user.email, role });
      return { user, id, token };
    };
    const accept = (user: { id: string; email: string }, token: string, emailVerified = true) =>
      acceptInvitation(db(), { token, userId: user.id, email: user.email, emailVerified });

    it('cannot substitute a caller verification flag for the native verified address', async () => {
      const a = await newOrg();
      const { user, id, token } = await invite(a, 'member', false);
      await expect(accept(user, token, true)).rejects.toMatchObject({ cause: { code: 'EN405' } });
      await expect(resolveTenantContext(db(), user.id, a.organizationId)).rejects.toThrow();
      const listed = (await listInvitations(db(), a)).find((i) => i.id === id);
      expect(listed?.acceptedAt).toBeNull();
      expect(listed?.claimedAt).toBeNull();
      expect(await accept(user, token, false)).toEqual({ status: 'awaiting_confirmation' });
    });

    it('stop working when the inviter is disabled', async () => {
      const a = await newOrg();
      const mallory = await join(a, 'mallory', 'admin');
      const { user, id, token } = await invite(mallory);
      await disableMember(db(), a, { membershipId: mallory.membershipId });
      await expect(accept(user, token)).rejects.toEqual(code('INVITATION_INVALID'));
      await expect(resolveTenantContext(db(), user.id, a.organizationId)).rejects.toThrow();
      const invitations = await listInvitations(db(), a);
      expect(invitations.find((i) => i.id === id)?.revokedAt).toBeTruthy();
      expect(await auditRows(a, 'invitation.revoked')).toEqual([
        {
          actor_id: a.membershipId,
          target_ref: `invitation:${id}`,
          safe_reason: 'INVITER_DISABLED',
        },
      ]);
    });

    it('stop working when the inviter is demoted', async () => {
      const a = await newOrg();
      const mallory = await join(a, 'mallory', 'admin');
      const { user, id, token } = await invite(mallory);
      await setMemberRole(db(), a, { membershipId: mallory.membershipId, role: 'member' });
      await expect(accept(user, token)).rejects.toEqual(code('INVITATION_INVALID'));
      expect((await listInvitations(db(), a)).find((i) => i.id === id)?.revokedAt).toBeTruthy();
    });

    it('are refused even if somehow left unrevoked, by checking the inviter under the lock', async () => {
      const a = await newOrg();
      const mallory = await join(a, 'mallory', 'admin');
      const { user, token } = await invite(mallory);
      // The inviter's role changes with no service running, so nothing revoked the invitation.
      await withTenantTx(db(), a, (tx) =>
        tx.execute(`update org.memberships set role = 'member'
          where id = '${mallory.membershipId}'`),
      );
      await expect(accept(user, token)).rejects.toEqual(code('INVITATION_INVALID'));
    });

    it('survive the inviter keeping the right to invite', async () => {
      const a = await newOrg();
      const admin = await join(a, 'admin', 'admin');
      const { user, token } = await invite(admin);
      await setMemberRole(db(), a, { membershipId: admin.membershipId, role: 'owner' });
      await accept(user, token);
      expect((await resolveTenantContext(db(), user.id, a.organizationId)).role).toBe('admin');
    });

    it('make an unverified account ask, and join nothing until confirmed', async () => {
      const a = await newOrg();
      const { user, id, token } = await invite(a, 'admin', false);
      expect(await accept(user, token, false)).toEqual({ status: 'awaiting_confirmation' });
      await expect(resolveTenantContext(db(), user.id, a.organizationId)).rejects.toThrow();
      const listed = (await listInvitations(db(), a)).find((i) => i.id === id);
      expect(listed?.claimedAt).toBeTruthy();
      expect(listed?.acceptedAt).toBeNull();
      expect((await listMyNotifications(db(), a))[0]?.kind).toBe('member.join_requested');

      await confirmInvitation(db(), a, { invitationId: id });
      expect((await resolveTenantContext(db(), user.id, a.organizationId)).role).toBe('admin');
      await expect(confirmInvitation(db(), a, { invitationId: id })).rejects.toEqual(
        code('INVITATION_INVALID'),
      );
    });

    it('cannot be confirmed by someone who cannot invite, or with no one asking', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const { user, id, token } = await invite(a, 'admin', false);
      await expect(confirmInvitation(db(), a, { invitationId: id })).rejects.toEqual(
        code('INVITATION_INVALID'),
      );
      await accept(user, token, false);
      await expect(confirmInvitation(db(), member, { invitationId: id })).rejects.toEqual(
        code('FORBIDDEN'),
      );
    });

    it('cannot be confirmed once withdrawn', async () => {
      const a = await newOrg();
      const { user, id, token } = await invite(a, 'admin', false);
      await accept(user, token, false);
      await revokeInvitation(db(), a, { invitationId: id });
      await expect(confirmInvitation(db(), a, { invitationId: id })).rejects.toEqual(
        code('INVITATION_INVALID'),
      );
    });

    it('do not bring a disabled member back, and do not claim they joined', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const emailRows = await withTenantTx(db(), a, (tx) =>
        tx.execute(sql`select u.email from identity.users u
          join org.memberships m on m.user_id = u.id where m.id = ${member.membershipId}`),
      );
      const email = emailRows.rows[0]?.email as string;
      await disableMember(db(), a, { membershipId: member.membershipId });
      const { id, token } = await createInvitation(db(), a, { email });
      const joined = (await auditRows(a, 'member.joined')).length;
      await expect(
        acceptInvitation(db(), { token, userId: member.userId, email, emailVerified: true }),
      ).rejects.toEqual(code('INVITATION_INVALID'));
      expect((await listInvitations(db(), a)).find((i) => i.id === id)?.acceptedAt).toBeNull();
      expect(await auditRows(a, 'member.joined')).toHaveLength(joined);
    });

    it('cannot be withdrawn once accepted, which would record something untrue', async () => {
      const a = await newOrg();
      const { user, id, token } = await invite(a, 'member');
      await accept(user, token);
      await revokeInvitation(db(), a, { invitationId: id });
      expect((await listInvitations(db(), a)).find((i) => i.id === id)?.revokedAt).toBeNull();
      expect(await auditRows(a, 'invitation.revoked')).toEqual([]);
      expect(await eventTypes(a, id)).toEqual([]);
      expect((await resolveTenantContext(db(), user.id, a.organizationId)).role).toBe('member');
    });

    it('record being withdrawn once, as an event and in the audit log', async () => {
      const a = await newOrg();
      const { id } = await invite(a);
      await revokeInvitation(db(), a, { invitationId: id });
      await revokeInvitation(db(), a, { invitationId: id });
      expect(await eventTypes(a, id)).toEqual(['invitation.revoked']);
      expect(await auditRows(a, 'invitation.revoked')).toHaveLength(1);
    });

    it('record being withdrawn along with a disabled inviter, as an event too', async () => {
      const a = await newOrg();
      const mallory = await join(a, 'mallory', 'admin');
      const { id } = await invite(mallory);
      await disableMember(db(), a, { membershipId: mallory.membershipId });
      expect(await eventTypes(a, id)).toEqual(['invitation.revoked']);
    });

    it('cannot be withdrawn from another tenant', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const { id } = await invite(a);
      await revokeInvitation(db(), b, { invitationId: id });
      expect((await listInvitations(db(), a)).find((i) => i.id === id)?.revokedAt).toBeNull();
      expect(await eventTypes(a, id)).toEqual([]);
    });

    it('record who joined, and record it differently when nobody did', async () => {
      const a = await newOrg();
      const { user, id, token } = await invite(a, 'member');
      await accept(user, token);
      const context = await resolveTenantContext(db(), user.id, a.organizationId);
      expect(await auditRows(a, 'member.joined')).toEqual([
        { actor_id: context.membershipId, target_ref: `invitation:${id}`, safe_reason: null },
      ]);

      const again = await createInvitation(db(), a, { email: user.email });
      await accept(user, again.token);
      expect(await auditRows(a, 'member.joined')).toHaveLength(1);
      expect(await auditRows(a, 'member.join_skipped')).toEqual([
        {
          actor_id: context.membershipId,
          target_ref: `invitation:${again.id}`,
          safe_reason: 'ALREADY_MEMBER',
        },
      ]);
    });
  });

  describe('the last owner, under concurrency', () => {
    it('cannot be lost when two owners demote each other at once, repeated', async () => {
      for (let i = 0; i < 8; i++) {
        const a = await newOrg();
        const second = await join(a, 'second', 'admin');
        await setMemberRole(db(), a, { membershipId: second.membershipId, role: 'owner' });
        const b = await resolveTenantContext(db(), second.userId, a.organizationId);
        const results = await Promise.allSettled([
          setMemberRole(db(), a, { membershipId: b.membershipId, role: 'member' }),
          setMemberRole(db(), b, { membershipId: a.membershipId, role: 'member' }),
        ]);
        const rows = await withTenantTx(db(), a, (tx) =>
          tx.execute(`select count(*)::int as n from org.memberships
            where role = 'owner' and status = 'active'`),
        );
        expect(rows.rows[0]?.n, `round ${i}`).toBeGreaterThanOrEqual(1);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
      }
    });

    it('cannot be lost when one is demoted while the other is disabled, repeated', async () => {
      for (let i = 0; i < 8; i++) {
        const a = await newOrg();
        const second = await join(a, 'second', 'admin');
        await setMemberRole(db(), a, { membershipId: second.membershipId, role: 'owner' });
        const b = await resolveTenantContext(db(), second.userId, a.organizationId);
        await Promise.allSettled([
          setMemberRole(db(), a, { membershipId: b.membershipId, role: 'member' }),
          disableMember(db(), b, { membershipId: a.membershipId }),
        ]);
        const rows = await withTenantTx(db(), a, (tx) =>
          tx.execute(`select count(*)::int as n from org.memberships
            where role = 'owner' and status = 'active'`),
        );
        expect(rows.rows[0]?.n, `round ${i}`).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('the audit record of access', () => {
    it('records adding and removing someone, with who did it', async () => {
      const a = await newOrg();
      const mallory = await join(a, 'mallory');
      const work = await createWorkUnit(db(), a, { title: 'R', classification: 'restricted' });
      await assignContributor(db(), a, { id: work.id, membershipId: mallory.membershipId });
      await unassign(db(), a, { id: work.id, membershipId: mallory.membershipId });

      for (const action of ['work.assigned', 'work.unassigned']) {
        const rows = await auditRows(a, action);
        expect(rows.map((r) => r.target_ref).sort()).toEqual(
          [`membership:${mallory.membershipId}`, `work_unit:${work.id}`].sort(),
        );
        expect(rows.every((r) => r.actor_id === a.membershipId)).toBe(true);
        expect(rows.every((r) => r.safe_reason === 'RESTRICTED')).toBe(true);
      }
      const events = await eventTypes(a, work.id);
      expect(events).toContain('work.assigned');
      expect(events).toContain('work.unassigned');
    });

    it('records a change of owner, a review request and a withdrawn invitation', async () => {
      const a = await newOrg();
      const member = await join(a, 'member', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await setOwner(db(), a, {
        id: work.id,
        expectedVersion: 1,
        ownerMembershipId: member.membershipId,
      });
      expect((await auditRows(a, 'work.owner_changed')).map((r) => r.target_ref)).toEqual([
        `work_unit:${work.id}`,
      ]);

      const review = await requestWorkReview(db(), member, {
        workUnitId: work.id,
        expectedVersion: 2,
        approverMembershipId: a.membershipId,
      });
      expect((await auditRows(a, 'approval.requested')).map((r) => r.target_ref)).toEqual([
        `approval:${review.id}`,
      ]);

      const { id } = await createInvitation(db(), a, { email: 'x@example.invalid' });
      await revokeInvitation(db(), a, { invitationId: id });
      expect((await auditRows(a, 'invitation.revoked')).map((r) => r.target_ref)).toEqual([
        `invitation:${id}`,
      ]);
    });

    it('records removing a dependency', async () => {
      const a = await newOrg();
      const first = await createWorkUnit(db(), a, { title: 'First' });
      const second = await createWorkUnit(db(), a, { title: 'Second' });
      await addDependency(db(), a, { dependentId: second.id, prerequisiteId: first.id });
      await removeDependency(db(), a, { dependentId: second.id, prerequisiteId: first.id });
      expect(await eventTypes(a, second.id)).toContain('work.dependency_removed');
      expect((await auditRows(a, 'work.dependency_removed')).map((r) => r.target_ref)).toEqual([
        `work_unit:${second.id}`,
      ]);
    });
  });

  describe('history of a Work Unit', () => {
    it('keeps the reason for reopening, and who gave it', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await move(a, work.id, ['ready', 'running', 'verifying', 'completed']);
      await move(a, work.id, ['ready'], '  Client rejected the deliverable  ');
      const { history } = await getWorkDetail(db(), a, work.id);
      expect(history).toHaveLength(5);
      expect(history[0]).toMatchObject({
        fromStatus: 'completed',
        toStatus: 'ready',
        reason: 'Client rejected the deliverable',
      });
      expect(history[0]?.actorName).toBeTruthy();
    });

    it('keeps the free text out of events and the audit log', async () => {
      const a = await newOrg();
      const canary = `CANARY-${randomUUID()}`;
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await move(a, work.id, ['cancelled'], canary);
      const rows = await withTenantTx(db(), a, (tx) =>
        tx.execute(`select payload::text as t from platform.domain_events
          union all select coalesce(safe_reason, '') from governance.audit_events`),
      );
      expect(JSON.stringify(rows.rows)).not.toContain(canary);
      expect((await getWorkDetail(db(), a, work.id)).history[0]?.reason).toBe(canary);
    });

    it('hides the history with the work', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const work = await createWorkUnit(db(), a, { title: 'R', classification: 'restricted' });
      await move(a, work.id, ['cancelled'], 'Secret reason');
      await expect(getWorkDetail(db(), member, work.id)).rejects.toEqual(code('NOT_FOUND'));
    });

    it('keeps it from other tenants at the database', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await move(a, work.id, ['cancelled'], 'Secret reason');
      const rows = await withTenantTx(db(), b, (tx) =>
        tx.execute('select count(*)::int as n from work.work_transitions'),
      );
      expect(rows.rows[0]?.n).toBe(0);
    });

    it('cannot be rewritten', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await move(a, work.id, ['ready']);
      await expect(
        withTenantTx(db(), a, (tx) => tx.execute(`delete from work.work_transitions`)),
      ).rejects.toThrow();
      await expect(
        withTenantTx(db(), a, (tx) => tx.execute(`update work.work_transitions set reason = 'x'`)),
      ).rejects.toThrow();
    });

    it('shows a decision and its reason on the approval', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const running = await move(a, work.id, ['ready', 'running']);
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: running.version,
        approverMembershipId: reviewer.membershipId,
      });
      await decideApproval(db(), reviewer, {
        approvalId: review.id,
        decision: 'deny',
        shownHash: review.actionHash,
        reason: 'Not good enough',
      });
      const { decisions } = await getApproval(db(), a, review.id);
      expect(decisions).toEqual([
        expect.objectContaining({ decision: 'deny', reason: 'Not good enough' }),
      ]);
      const { history } = await getWorkDetail(db(), a, work.id);
      expect(history[0]).toMatchObject({ toStatus: 'cancelled', reason: 'Not good enough' });
    });
  });

  describe('finished work', () => {
    it('refuses edits and new people, but always lets access be removed', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const other = await join(a, 'other');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      await assignContributor(db(), a, { id: work.id, membershipId: member.membershipId });
      const stopped = await move(a, work.id, ['cancelled']);
      await expect(
        updateWorkUnit(db(), a, work.id, stopped.version, { title: 'After' }),
      ).rejects.toEqual(code('INVALID_STATE'));
      await expect(
        assignContributor(db(), a, { id: work.id, membershipId: other.membershipId }),
      ).rejects.toEqual(code('INVALID_STATE'));

      await unassign(db(), a, { id: work.id, membershipId: member.membershipId });
      const moved = await setOwner(db(), a, {
        id: work.id,
        expectedVersion: stopped.version,
        ownerMembershipId: other.membershipId,
      });
      expect(moved.ownerMembershipId).toBe(other.membershipId);
    });

    it('refuses edits while a review is open on paused work', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const running = await move(a, work.id, ['ready', 'running']);
      await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: running.version,
        approverMembershipId: reviewer.membershipId,
      });
      const paused = await getWorkUnit(db(), a, work.id);
      await expect(
        updateWorkUnit(db(), a, work.id, paused.version, { title: 'Sneaky' }),
      ).rejects.toEqual(code('INVALID_STATE'));
    });
  });

  describe('Home lists', () => {
    it('include work someone is assigned to, not only work they own', async () => {
      const a = await newOrg();
      const sam = await join(a, 'sam');
      const work = await createWorkUnit(db(), a, { title: 'Assigned to Sam' });
      expect((await listMyWork(db(), sam)).work).toEqual([]);
      await assignContributor(db(), a, { id: work.id, membershipId: sam.membershipId });
      expect((await listMyWork(db(), sam)).work.map((w) => w.id)).toEqual([work.id]);
      expect((await listMyNotifications(db(), sam))[0]).toMatchObject({
        kind: 'work.assigned',
        targetRef: `work_unit:${work.id}`,
      });
    });

    it('are not limited by how much else in the organization is newer', async () => {
      const a = await newOrg();
      const sam = await join(a, 'sam');
      const old = await createWorkUnit(db(), sam, {
        title: 'Old and late',
        dueAt: new Date('2020-01-01'),
      });
      for (let i = 0; i < 60; i++) await createWorkUnit(db(), a, { title: `Newer ${i}` });
      const mine = await listMyWork(db(), sam);
      expect(mine.attention.map((w) => w.id)).toEqual([old.id]);
      expect(mine.work.map((w) => w.id)).toEqual([old.id]);
      // An org-wide first page would not have held it at all.
      expect((await listWorkUnits(db(), sam)).items.map((w) => w.id)).not.toContain(old.id);
    });

    it('do not call work due today overdue', async () => {
      const a = await newOrg();
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      await createWorkUnit(db(), a, { title: 'Due today', dueAt: today });
      expect((await listMyWork(db(), a)).attention).toEqual([]);
    });

    it('say when there is more to see', async () => {
      const a = await newOrg();
      for (let i = 0; i < 13; i++) await createWorkUnit(db(), a, { title: `W${i}` });
      const mine = await listMyWork(db(), a);
      expect(mine.work).toHaveLength(12);
      expect(mine.workHasMore).toBe(true);
    });
  });

  describe('paging', () => {
    it('never skips rows that fall within the same millisecond', async () => {
      const a = await newOrg();
      const ids: string[] = [];
      const su = new pg.Client({ connectionString: urls.superuser() });
      await su.connect();
      for (const micros of ['900', '400', '100']) {
        const work = await createWorkUnit(db(), a, { title: `At .123${micros}` });
        await inFixtureTenant(su, a.organizationId, () =>
          su.query(
            `update work.work_units set created_at = '2030-01-01 12:00:00.123${micros}+00'
             where id = '${work.id}'`,
          ),
        );
        ids.push(work.id);
      }
      await su.end();
      const first = await listWorkUnits(db(), a, { limit: 1 });
      expect(first.items.map((w) => w.id)).toEqual([ids[0]]);
      const second = await listWorkUnits(db(), a, { limit: 1, cursor: first.nextCursor! });
      expect(second.items.map((w) => w.id)).toEqual([ids[1]]);
      const third = await listWorkUnits(db(), a, { limit: 1, cursor: second.nextCursor! });
      expect(third.items.map((w) => w.id)).toEqual([ids[2]]);
      expect(third.nextCursor).toBeNull();
    });

    it('refuses a cursor that is not one of ours, with a known error', async () => {
      const a = await newOrg();
      await expect(listWorkUnits(db(), a, { cursor: 'garbage' })).rejects.toEqual(
        code('INVALID_INPUT'),
      );
      const injected = Buffer.from(
        JSON.stringify(["2030-01-01'; drop table x; --", randomUUID()]),
      ).toString('base64url');
      await expect(listWorkUnits(db(), a, { cursor: injected })).rejects.toEqual(
        code('INVALID_INPUT'),
      );
    });

    it('keeps no working field from the query on the rows it returns', async () => {
      const a = await newOrg();
      await createWorkUnit(db(), a, { title: 'W' });
      const { items } = await listWorkUnits(db(), a);
      expect(Object.keys(items[0]!)).not.toContain('cursorAt');
    });
  });

  describe('notifications', () => {
    it('refuses an ID that is not one, with a known error and no SQL', async () => {
      const a = await newOrg();
      await expect(markRead(db(), a, "x\n{'forged':'log line'}")).rejects.toEqual(
        code('INVALID_INPUT'),
      );
    });
  });

  describe('teams', () => {
    it('can gain and lose members', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const team = await createTeam(db(), a, { name: 'Sales' });
      await addTeamMember(db(), a, { teamId: team!.id, membershipId: member.membershipId });
      const [listed] = await listTeams(db(), a);
      expect(listed?.members.map((m) => m.membershipId)).toEqual([member.membershipId]);
      await removeTeamMember(db(), a, { teamId: team!.id, membershipId: member.membershipId });
      expect((await listTeams(db(), a))[0]?.members).toEqual([]);
    });

    it('refuses a member with no right to manage teams, and a disabled person', async () => {
      const a = await newOrg();
      const member = await join(a, 'member');
      const team = await createTeam(db(), a, { name: 'Sales' });
      await expect(
        addTeamMember(db(), member, { teamId: team!.id, membershipId: member.membershipId }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await disableMember(db(), a, { membershipId: member.membershipId });
      await expect(
        addTeamMember(db(), a, { teamId: team!.id, membershipId: member.membershipId }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });
  });

  describe('completion criteria', () => {
    it('does not accept a criterion nothing can ever satisfy', async () => {
      const a = await newOrg();
      await expect(
        createWorkUnit(db(), a, {
          title: 'W',
          completionCriteria: [{ kind: 'external_receipt' } as never],
        }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });
  });

  describe('a plan run, through its Activities', () => {
    const RUN = randomUUID();
    const quietStore = new MemoryStore();
    const activities = () => createActivities({ database: db(), store: quietStore });
    const input = (context: TenantContext, workUnitId: string, runId = RUN) => ({
      organizationId: context.organizationId,
      workUnitId,
      runId,
    });

    async function planned(
      context: TenantContext,
      criteria: Array<{ kind: 'artifact_exists' | 'reviewer_approved' }> = [],
      options: Parameters<typeof requestExecution>[3] = {},
    ) {
      const work = await createWorkUnit(db(), context, {
        title: 'Planned',
        executionPlan: 'checklist',
        completionCriteria: criteria,
      });
      await move(context, work.id, ['ready']);
      await requestExecution(db(), context, work.id, options);
      return work;
    }

    it('claims requested work, and treats a repeat by the same run as a retry', async () => {
      const a = await newOrg();
      const work = await planned(a);
      const run = input(a, work.id);
      expect((await activities().prepareWork(run)).status).toBe('running');
      expect((await activities().prepareWork(run)).status).toBe('running');
      expect((await getWorkUnit(db(), a, work.id)).version).toBe(4);
    });

    it('leaves work alone that someone started by hand', async () => {
      const a = await newOrg();
      const work = await planned(a);
      await move(a, work.id, ['running']);
      const late = await activities().prepareWork(input(a, work.id));
      expect(late.status).toBe('stopped');
      // Its status is running, but it never was this run's, so a late retry adds no file to it.
      await expect(activities().produceChecklistArtifact(input(a, work.id))).rejects.toEqual(
        expect.objectContaining({ type: 'WORK_STOPPED' }),
      );
      expect((await getWorkDetail(db(), a, work.id)).files).toEqual([]);
      // It was never this run's, so it is not sent for checking either.
      expect(await activities().verifyAndComplete(input(a, work.id))).toBe('cancelled');
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('running');
    });

    it('does not start again on a delayed event after a reopen', async () => {
      const a = await newOrg();
      const work = await planned(a);
      await move(a, work.id, ['running', 'verifying', 'completed']);
      await move(a, work.id, ['ready'], 'Reopened');
      const late = await activities().prepareWork(input(a, work.id, randomUUID()));
      expect(late.status).toBe('stopped');
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('ready');
    });

    it('does not let another run take over one already running', async () => {
      const a = await newOrg();
      const work = await planned(a);
      await activities().prepareWork(input(a, work.id));
      const other = await activities().prepareWork(input(a, work.id, randomUUID()));
      expect(other.status).toBe('stopped');
    });

    it('stops at checking, and never marks the work done itself', async () => {
      const a = await newOrg();
      const work = await planned(a);
      const run = input(a, work.id);
      await activities().prepareWork(run);
      await activities().produceChecklistArtifact(run);
      expect(await activities().verifyAndComplete(run)).toBe('verifying');
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('verifying');
      const again = await activities().verifyAndComplete(run);
      expect(again).toBe('verifying');
    });

    it('does not count its own generated file as the evidence', async () => {
      const a = await newOrg();
      const work = await planned(a, [{ kind: 'artifact_exists' }]);
      const run = input(a, work.id);
      await activities().prepareWork(run);
      await activities().produceChecklistArtifact(run);
      await activities().verifyAndComplete(run);
      const checking = await getWorkDetail(db(), a, work.id);
      expect(checking.files.map((f) => f.name)).toEqual(['completion-checklist.md']);
      expect(checking.evidence.artifactCount).toBe(0);
      await expect(
        transitionWorkUnit(db(), a, {
          id: work.id,
          expectedVersion: checking.work.version,
          to: 'completed',
        }),
      ).rejects.toEqual(code('EVIDENCE_MISSING'));

      await addArtifact(db(), quietStore, a, {
        workUnitId: work.id,
        name: 'result.pdf',
        mimeType: 'application/pdf',
        body: Buffer.from('result'),
      });
      const done = await transitionWorkUnit(db(), a, {
        id: work.id,
        expectedVersion: checking.work.version,
        to: 'completed',
      });
      expect(done.status).toBe('completed');
    });

    describe('an attempt still running after its timeout', () => {
      /** A store whose first upload stalls until released, and which says when it reached that. */
      function stallingStore() {
        const store = new MemoryStore();
        let release = () => undefined as void;
        let reached = () => undefined as void;
        const stalled = new Promise<void>((done) => {
          reached = done;
        });
        const gate = new Promise<void>((done) => {
          release = done;
        });
        let first = true;
        const stalling: ObjectStore = {
          put: async (key, body, mime) => {
            if (first) {
              first = false;
              reached();
              await gate;
            }
            await store.put(key, body);
            void mime;
          },
          get: store.get.bind(store),
          exists: store.exists.bind(store),
          delete: store.delete.bind(store),
          deleteForPurge: store.deleteForPurge.bind(store),
          isPhysicallyAbsent: store.isPhysicallyAbsent.bind(store),
        };
        return { store, stalling, stalled, release };
      }

      it('refuses an overlapping upload, then reuses the checklist without changing its review', async () => {
        const a = await newOrg();
        const reviewer = await join(a, 'reviewer', 'admin');
        const work = await planned(a);
        const run = input(a, work.id);
        const { store, stalling, stalled, release } = stallingStore();
        const own = createActivities({ database: db(), store: stalling });
        await own.prepareWork(run);

        const slow = own.produceChecklistArtifact(run);
        await stalled;
        try {
          await expect(own.produceChecklistArtifact(run)).rejects.toEqual(code('INVALID_STATE'));
        } finally {
          release();
        }
        const published = await slow;

        // A person is mid-review when the completed activity is delivered again.
        const version = (await getWorkUnit(db(), a, work.id)).version;
        await withTenantTx(db(), a, (tx) =>
          tx.execute(`update work.work_units set run_id = null where id = '${work.id}'`),
        );
        const review = await requestWorkReview(db(), a, {
          workUnitId: work.id,
          expectedVersion: version,
          approverMembershipId: reviewer.membershipId,
        });
        await withTenantTx(db(), a, (tx) =>
          tx.execute(
            `update work.work_units set status = 'running', run_id = '${run.runId}'
             where id = '${work.id}'`,
          ),
        );

        expect(await own.produceChecklistArtifact(run)).toEqual(published);
        const { files } = await getWorkDetail(db(), a, work.id);
        expect(files.map((f) => f.id)).toEqual([published.artifactId]);
        // Delivery again changes nothing, so the human review still stands.
        expect((await getApproval(db(), a, review.id)).approval.status).toBe('pending');

        expect(store.objects.size).toBe(1);
        const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
        expect(await purgeDueBlobs(db(), store, a, later)).toEqual({ purged: 0, failed: 0 });
        expect([...store.objects.values()]).toHaveLength(1);
      });

      it('attaches nothing if the run lost the work during the upload', async () => {
        const a = await newOrg();
        const work = await planned(a);
        const run = input(a, work.id);
        const { store, stalling, stalled, release } = stallingStore();
        const own = createActivities({ database: db(), store: stalling });
        await own.prepareWork(run);

        const slow = own.produceChecklistArtifact(run);
        await stalled;
        // A person takes it over by hand. The status is running again by the time the upload lands.
        await move(a, work.id, ['blocked', 'ready', 'running']);
        release();
        await expect(slow).rejects.toEqual(expect.objectContaining({ type: 'WORK_STOPPED' }));
        expect((await getWorkDetail(db(), a, work.id)).files).toEqual([]);
        const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
        // Generated bytes need a hold-aware lifecycle and old-writer proof. A generic grace-period
        // sweep cannot turn a stopped publication into physical deletion evidence.
        expect(await purgeDueBlobs(db(), store, a, later)).toEqual({ purged: 0, failed: 0 });
        expect(store.objects.size).toBe(1);
        const retained = await withTenantTx(db(), createServiceContext(a.organizationId), (tx) =>
          tx.execute<{ state: string; writeState: string; blobState: string }>(
            sql`select l.state,l.write_state as "writeState",b.state as "blobState"
              from knowledge.artifact_lineage l join platform.blob_lifecycle b
                on b.organization_id=l.organization_id and b.artifact_id=l.artifact_id
              where l.execution_kind='system' and l.execution_id=${run.runId}::uuid
                and l.work_unit_id=${work.id}::uuid`,
          ),
        );
        expect(retained.rows).toEqual([
          { state: 'blocked', writeState: 'settled', blobState: 'deleting' },
        ]);
      });
    });

    describe('a request nothing has claimed', () => {
      const backdate = async (context: TenantContext, id: string) => {
        const su = await superuser();
        await inFixtureTenant(su, context.organizationId, () =>
          su.query(
            `update work.work_units set run_requested_at = now() - interval '1 hour'
             where id = $1 and organization_id = $2`,
            [id, context.organizationId],
          ),
        );
        await su.end();
      };
      const delivered = async (context: TenantContext) => {
        const su = await superuser();
        await su.query(
          `update platform.outbox_events set state = 'published'
           where state = 'queued' and organization_id = $1`,
          [context.organizationId],
        );
        await su.end();
      };
      const requests = async (context: TenantContext, id: string) =>
        (await eventTypes(context, id)).filter((t) => t === 'work.execution_requested').length;
      const upkeep = (context: TenantContext) =>
        activities().sendReminders({ organizationId: context.organizationId });

      it('is asked for again, and the new request can be claimed', async () => {
        const a = await newOrg();
        const work = await planned(a);
        await delivered(a);
        await backdate(a, work.id);
        await upkeep(a);
        expect(await requests(a, work.id)).toBe(2);
        expect(
          (await auditRows(a, 'work.run_requested_again')).map((row) => row.target_ref),
        ).toEqual([`work_unit:${work.id}`]);
        // Only asked once, while that second request waits to be delivered.
        await upkeep(a);
        expect(await requests(a, work.id)).toBe(2);
        // Delivered, and a run with nothing else in the way takes it.
        await delivered(a);
        expect((await activities().prepareWork(input(a, work.id))).status).toBe('running');
        await upkeep(a);
        expect(await requests(a, work.id)).toBe(2);
      });

      it('is not asked for again while it is recent', async () => {
        const a = await newOrg();
        const work = await planned(a);
        await delivered(a);
        await upkeep(a);
        expect(await requests(a, work.id)).toBe(1);
      });

      it('is not asked for again once someone started the work by hand', async () => {
        const a = await newOrg();
        const work = await planned(a);
        await delivered(a);
        await backdate(a, work.id);
        await move(a, work.id, ['running']);
        await upkeep(a);
        expect(await requests(a, work.id)).toBe(1);
      });

      it('is only asked for again in its own tenant', async () => {
        const a = await newOrg();
        const b = await newOrg();
        const work = await planned(a);
        await delivered(a);
        await backdate(a, work.id);
        await upkeep(b);
        expect(await requests(a, work.id)).toBe(1);
      });

      it('cannot be repeated, so nobody can replace the reviewer it named', async () => {
        const a = await newOrg();
        const bob = await join(a, 'bob', 'admin');
        const carol = await join(a, 'carol', 'admin');
        const dan = await join(a, 'dan', 'admin');
        const work = await planned(a, [{ kind: 'reviewer_approved' }], {
          reviewerMembershipId: dan.membershipId,
        });
        const before = await getWorkUnit(db(), a, work.id);
        await expect(
          requestExecution(db(), bob, work.id, { reviewerMembershipId: carol.membershipId }),
        ).rejects.toEqual(code('RUN_ALREADY_REQUESTED'));
        const after = await getWorkUnit(db(), a, work.id);
        expect(after.planReviewerMembershipId).toBe(dan.membershipId);
        expect(after.runRequestedByMembershipId).toBe(a.membershipId);
        expect(after.runRequestedAt).toEqual(before.runRequestedAt);
        expect(await requests(a, work.id)).toBe(1);

        const run = input(a, work.id);
        await activities().prepareWork(run);
        await activities().produceChecklistArtifact(run);
        const { approvalId } = await activities().requestReview(run);
        const { approval } = await getApproval(db(), a, approvalId);
        expect(approval.approverMembershipId).toBe(dan.membershipId);
      });

      it('can be made again once the first has been answered', async () => {
        const a = await newOrg();
        const work = await planned(a);
        await move(a, work.id, ['running', 'blocked', 'ready']);
        await requestExecution(db(), a, work.id);
        expect((await getWorkUnit(db(), a, work.id)).runRequestedAt).toBeTruthy();
      });

      it('cannot be made from another tenant', async () => {
        const a = await newOrg();
        const b = await newOrg();
        const work = await createWorkUnit(db(), a, {
          title: 'W',
          executionPlan: 'checklist',
        });
        await move(a, work.id, ['ready']);
        await expect(requestExecution(db(), b, work.id)).rejects.toEqual(code('NOT_FOUND'));
      });
    });

    it('writes its checklist in plain words, with no internal names', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await planned(a, [{ kind: 'artifact_exists' }, { kind: 'reviewer_approved' }], {
        reviewerMembershipId: (await join(a, 'r', 'admin')).membershipId,
      });
      const run = input(a, work.id);
      const own = createActivities({ database: db(), store });
      await own.prepareWork(run);
      const { artifactId } = await own.produceChecklistArtifact(run);
      const { body } = await readArtifact(db(), store, a, { workUnitId: work.id, artifactId });
      const text = body.toString();
      expect(text).not.toContain('artifact_exists');
      expect(text).not.toContain('reviewer_approved');
      expect(text).toContain('this file is not evidence');
    });

    it('refuses the person who runs it reviewing it themselves', async () => {
      const a = await newOrg();
      const work = await createWorkUnit(db(), a, {
        title: 'W',
        executionPlan: 'checklist',
        completionCriteria: [{ kind: 'reviewer_approved' }],
      });
      await move(a, work.id, ['ready']);
      await expect(requestExecution(db(), a, work.id)).rejects.toEqual(
        code('APPROVAL_SELF_APPROVAL'),
      );
      await expect(
        requestExecution(db(), a, work.id, { reviewerMembershipId: a.membershipId }),
      ).rejects.toEqual(code('APPROVAL_SELF_APPROVAL'));
    });

    it('asks the chosen reviewer, and records who ran it as the requester', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await planned(a, [{ kind: 'reviewer_approved' }], {
        reviewerMembershipId: reviewer.membershipId,
      });
      const run = input(a, work.id);
      await activities().prepareWork(run);
      await activities().produceChecklistArtifact(run);
      const review = await activities().requestReview(run);
      const { approval } = await getApproval(db(), a, review.approvalId);
      expect(approval.approverMembershipId).toBe(reviewer.membershipId);
      expect(approval.requestedByMembershipId).toBe(a.membershipId);
      expect(approval.holdsWork).toBe(true);
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
    });

    it('finds its own request on a retry, even if the files changed meanwhile', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await planned(a, [{ kind: 'reviewer_approved' }], {
        reviewerMembershipId: reviewer.membershipId,
      });
      const run = input(a, work.id);
      await activities().prepareWork(run);
      await activities().produceChecklistArtifact(run);
      const first = await activities().requestReview(run);
      // The artifact set is different now, by a route the page does not allow during a review.
      await withTenantTx(db(), a, (tx) =>
        tx.execute(`delete from work.work_artifacts where work_unit_id = '${work.id}'`),
      );
      const retried = await activities().requestReview(run);
      expect(retried.approvalId).toBe(first.approvalId);
    });

    it('reuses nothing from an earlier run after a reopen', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await planned(a, [{ kind: 'reviewer_approved' }], {
        reviewerMembershipId: reviewer.membershipId,
      });
      const first = input(a, work.id);
      await activities().prepareWork(first);
      await activities().produceChecklistArtifact(first);
      const { approvalId } = await activities().requestReview(first);
      const { approval } = await getApproval(db(), a, approvalId);
      await decideApproval(db(), reviewer, {
        approvalId,
        decision: 'approve',
        shownHash: approval.actionHash,
      });
      await activities().verifyAndComplete(first);
      await move(a, work.id, ['completed']);
      await move(a, work.id, ['ready'], 'Reopened');
      await requestExecution(db(), a, work.id, { reviewerMembershipId: reviewer.membershipId });

      const second = input(a, work.id, randomUUID());
      await activities().prepareWork(second);
      await activities().produceChecklistArtifact(second);
      const again = await activities().requestReview(second);
      expect(again.approvalId).not.toBe(approvalId);
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
    });

    it('replaces a review someone asked for by hand before the plan got there', async () => {
      const a = await newOrg();
      const carol = await join(a, 'carol', 'admin');
      const reviewer = await join(a, 'reviewer', 'admin');
      const work = await planned(a, [{ kind: 'reviewer_approved' }], {
        reviewerMembershipId: reviewer.membershipId,
      });
      const manual = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: (await getWorkUnit(db(), a, work.id)).version,
        approverMembershipId: carol.membershipId,
      });
      const run = input(a, work.id);
      await activities().prepareWork(run);
      await activities().requestReview(run);
      expect((await getApproval(db(), a, manual.id)).approval.status).toBe('cancelled');
      expect(await countUnread(db(), carol)).toBe(0);
      // Closed on the record, and the person who asked is told.
      expect(await auditRows(a, 'approval.closed')).toEqual([
        { actor_id: null, target_ref: `approval:${manual.id}`, safe_reason: 'PLAN_STARTED' },
      ]);
      expect((await listMyNotifications(db(), a)).map((n) => n.kind)).toContain(
        'approval.superseded',
      );
    });

    it('refuses a person asking for a review while a plan holds the work', async () => {
      const a = await newOrg();
      const carol = await join(a, 'carol', 'admin');
      const work = await planned(a);
      await activities().prepareWork(input(a, work.id));
      await expect(
        requestWorkReview(db(), a, {
          workUnitId: work.id,
          expectedVersion: (await getWorkUnit(db(), a, work.id)).version,
          approverMembershipId: carol.membershipId,
        }),
      ).rejects.toEqual(code('INVALID_STATE'));
    });

    it('reports failure honestly from every step it can be in', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');

      const beforeClaim = await planned(a);
      await activities().markFailed(input(a, beforeClaim.id));
      expect((await getWorkUnit(db(), a, beforeClaim.id)).status).toBe('failed');

      const waiting = await planned(a, [{ kind: 'reviewer_approved' }], {
        reviewerMembershipId: reviewer.membershipId,
      });
      const run = input(a, waiting.id);
      await activities().prepareWork(run);
      await activities().produceChecklistArtifact(run);
      const { approvalId } = await activities().requestReview(run);
      await activities().markFailed(run);
      expect((await getWorkUnit(db(), a, waiting.id)).status).toBe('failed');
      expect((await getApproval(db(), a, approvalId)).approval.status).toBe('cancelled');
      expect(await listMyPendingApprovals(db(), reviewer)).toEqual([]);
    });

    it('does not fail work that was never this run’s', async () => {
      const a = await newOrg();
      const work = await planned(a);
      await move(a, work.id, ['running']);
      await activities().markFailed(input(a, work.id));
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('running');
    });

    it('ends runs Temporal says are over, and leaves live ones alone', async () => {
      const a = await newOrg();
      const stranded = await planned(a);
      const live = await planned(a);
      const started = createActivities({
        database: db(),
        store: quietStore,
        probeWorkflow: async ({ workUnitId }) => (workUnitId === stranded.id ? 'closed' : 'open'),
      });
      await started.prepareWork(input(a, stranded.id));
      await started.prepareWork(input(a, live.id));
      const su = new pg.Client({ connectionString: urls.superuser() });
      await su.connect();
      await inFixtureTenant(su, a.organizationId, () =>
        su.query(
          `update work.work_units set updated_at = now() - interval '1 hour'
           where organization_id = '${a.organizationId}'`,
        ),
      );
      await su.end();
      await started.sendReminders({ organizationId: a.organizationId });
      expect((await getWorkUnit(db(), a, stranded.id)).status).toBe('failed');
      expect((await getWorkUnit(db(), a, live.id)).status).toBe('running');
    });

    it('expires overdue reviews and clears stuck bytes in the periodic upkeep', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });
      // Real bytes, left behind because the store refused when the file was deleted.
      const other = await createWorkUnit(db(), a, { title: 'Other' });
      const file = await addArtifact(db(), store, a, {
        workUnitId: other.id,
        name: 'gone.txt',
        mimeType: 'text/plain',
        body: Buffer.from('should not stay'),
      });
      await deleteArtifact(
        db(),
        {
          put: store.put.bind(store),
          get: store.get.bind(store),
          exists: store.exists.bind(store),
          delete: async () => {
            throw new Error('storage down');
          },
        },
        a,
        { workUnitId: other.id, artifactId: file.id },
      );
      expect(store.objects.size).toBe(1);
      await pastDue(a, review.id);

      await createActivities({ database: db(), store }).sendReminders({
        organizationId: a.organizationId,
      });

      expect((await getApproval(db(), a, review.id)).approval.status).toBe('expired');
      // It was not pausing anything, so the work carries on as it was.
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('queued');
      expect(store.objects.size).toBe(0);
      const rows = await withTenantTx(db(), a, (tx) =>
        tx.execute(`select state from platform.blob_lifecycle where artifact_id = '${file.id}'`),
      );
      expect(rows.rows).toEqual([{ state: 'purged' }]);
    });

    it('carries on with the other upkeep when one job fails, and still reports it', async () => {
      const a = await newOrg();
      const reviewer = await join(a, 'reviewer', 'admin');
      const store = new MemoryStore();
      const held = await planned(a);
      const started = createActivities({
        database: db(),
        store,
        probeWorkflow: async () => {
          throw new Error('Temporal is having a bad day');
        },
      });
      await started.prepareWork(input(a, held.id));
      const su = await superuser();
      await inFixtureTenant(su, a.organizationId, () =>
        su.query(
          `update work.work_units set updated_at = now() - interval '1 hour' where id = $1`,
          [held.id],
        ),
      );
      await su.end();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: reviewer.membershipId,
      });
      await pastDue(a, review.id);
      const other = await createWorkUnit(db(), a, { title: 'Other' });
      const file = await addArtifact(db(), store, a, {
        workUnitId: other.id,
        name: 'gone.txt',
        mimeType: 'text/plain',
        body: Buffer.from('x'),
      });
      await deleteArtifact(
        db(),
        {
          put: store.put.bind(store),
          get: store.get.bind(store),
          exists: store.exists.bind(store),
          delete: async () => {
            throw new Error('storage down');
          },
        },
        a,
        { workUnitId: other.id, artifactId: file.id },
      );
      expect(store.objects.size).toBe(1);

      await expect(started.sendReminders({ organizationId: a.organizationId })).rejects.toThrow(
        'bad day',
      );
      // One of these runs before the job that failed and one after, and both happened.
      expect(store.objects.size).toBe(0);
      expect((await getApproval(db(), a, review.id)).approval.status).toBe('expired');
    });

    describe('the sweep of runs Temporal says are over', () => {
      const quieten = async (context: TenantContext, ids: string[], interval: string) => {
        const su = await superuser();
        await inFixtureTenant(su, context.organizationId, () =>
          su.query(
            `update work.work_units set updated_at = now() - $1::interval
             where organization_id = $2 and id = any($3::uuid[])`,
            [interval, context.organizationId, ids],
          ),
        );
        await su.end();
      };

      it('reaches a dead run behind more live ones than fit in one page', async () => {
        const a = await newOrg();
        const live: string[] = [];
        const probed: string[] = [];
        const stranded = await planned(a);
        const started = createActivities({
          database: db(),
          store: quietStore,
          probeWorkflow: async ({ workUnitId }) => {
            probed.push(workUnitId);
            return workUnitId === stranded.id ? 'closed' : 'open';
          },
        });
        await started.prepareWork(input(a, stranded.id));
        for (let i = 0; i < 51; i++) {
          const work = await planned(a);
          await started.prepareWork(input(a, work.id));
          live.push(work.id);
        }
        // All the live ones have been quiet for longer, so they come first.
        await quieten(a, live, '2 hours');
        await quieten(a, [stranded.id], '1 hour');

        await started.sendReminders({ organizationId: a.organizationId });

        expect(probed).toHaveLength(52);
        expect(probed.at(-1)).toBe(stranded.id);
        expect((await getWorkUnit(db(), a, stranded.id)).status).toBe('failed');
        expect((await getWorkUnit(db(), a, live[0]!)).status).toBe('running');
      });

      it('pages in a stable order, breaking ties on the ID, and only in its own tenant', async () => {
        const a = await newOrg();
        const b = await newOrg();
        const ids: string[] = [];
        const own = createActivities({ database: db(), store: quietStore });
        for (let i = 0; i < 5; i++) {
          const work = await planned(a);
          await own.prepareWork(input(a, work.id));
          ids.push(work.id);
        }
        const su = await superuser();
        await inFixtureTenant(su, a.organizationId, () =>
          su.query(
            `update work.work_units set updated_at = '2030-01-01 00:00:00.123456+00'
             where id = any($1::uuid[])`,
            [ids],
          ),
        );
        await su.end();
        const service = createServiceContext(a.organizationId);
        const before = new Date('2030-01-02');
        const seen: string[] = [];
        let after: Awaited<ReturnType<typeof listHeldRuns>>['next'] = null;
        do {
          const page: Awaited<ReturnType<typeof listHeldRuns>> = await listHeldRuns(
            db(),
            service,
            before,
            { after: after ?? undefined, limit: 2 },
          );
          seen.push(...page.items.map((item) => item.id));
          after = page.next;
        } while (after);
        expect(seen).toEqual([...ids].sort());
        const elsewhere = await listHeldRuns(db(), createServiceContext(b.organizationId), before);
        expect(elsewhere.items).toEqual([]);
      });
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
