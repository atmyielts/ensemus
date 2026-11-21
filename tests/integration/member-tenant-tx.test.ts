// QA-003, API-13, ADR-037 D5, ADR-025 D3. One live status poll is one transaction, and that second way to
// bind a tenant has to show exactly what withTenantTx shows. Runs against real PostgreSQL with the real
// runtime roles, never as an owner or superuser. Written on a machine without Docker: unverified until run.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  acceptInvitation,
  createInvitation,
  createWorkUnit,
  disableMember,
  getWorkFollowState,
  getWorkFollowStateAsMember,
  transitionWorkUnit,
} from '@ensemus/application';
import {
  createOrganization,
  getOrganization,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  TenantAccessDenied,
  withMemberTenantTx,
  withTenantTx,
  withUserTx,
  workUnits,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { urls } from '../helpers/stack';

const code = (name: string) => expect.objectContaining({ code: name });

/** Bindings nothing here should set, so that a stray one would show up as a difference. */
const OTHER_BINDINGS = ['app.invitation_token_hash', 'app.webhook_token_hash'];

/** `current_setting` for each name, with unset and empty read as the same, as RLS reads them. */
async function settings(tx: Tx, names: readonly string[]) {
  const seen: Record<string, string> = {};
  for (const name of names) {
    const { rows } = await tx.execute(
      sql`select coalesce(current_setting(${name}, true), '') as value`,
    );
    seen[name] = String(rows[0]?.value);
  }
  return seen;
}

describe('one transaction for a live status poll', () => {
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

  async function newOrg(userId: string, name = 'Same Name Ltd') {
    const { organizationId } = await createOrganization(db(), {
      userId,
      name,
      commercialMode: 'byom',
    });
    return resolveTenantContext(db(), userId, organizationId);
  }

  async function join(context: TenantContext, label: string) {
    const user = await makeUser(label);
    const { token } = await createInvitation(db(), context, { email: user.email, role: 'member' });
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  /** A fresh organization with an owner, and a piece of work in it. */
  async function scene() {
    const user = await makeUser('owner');
    const org = await newOrg(user.id);
    const work = await createWorkUnit(db(), org, { title: 'Same title' });
    return { user, org, work };
  }

  beforeAll(async () => {
    // One connection on purpose: every query reuses it, so leaked tenant state would show up.
    app = openAppDatabase(urls.app(), { max: 1 });
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await auth?.end();
  });

  describe('for a member', () => {
    it('answers in exactly one transaction', async () => {
      const { user, org, work } = await scene();
      const spy = vi.spyOn(db(), 'transaction');
      const { context, state } = await getWorkFollowStateAsMember(
        db(),
        user.id,
        org.organizationId,
        work.id,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      // Only the user is bound on the way in. The tenant comes from the row, not from the request.
      expect(spy.mock.calls[0]?.[0]).toEqual({ 'app.user_id': user.id });
      expect(state).toEqual({ version: work.version, evidence: expect.any(String) });
      expect(context.organizationId).toBe(org.organizationId);
      expect(context.membershipId).toBe(org.membershipId);
      expect(context.role).toBe(org.role);
      expect(context.userId).toBe(user.id);
      expect(context.actorType).toBe('user');
    });

    it('gives the same answer as the first read, with and without the evidence', async () => {
      const { user, org, work } = await scene();
      for (const options of [{}, { evidence: true }, { evidence: false }]) {
        const { state } = await getWorkFollowStateAsMember(
          db(),
          user.id,
          org.organizationId,
          work.id,
          options,
        );
        expect(state).toEqual(await getWorkFollowState(db(), org, work.id, options));
      }
      const { state } = await getWorkFollowStateAsMember(
        db(),
        user.id,
        org.organizationId,
        work.id,
        { evidence: false },
      );
      expect(state.evidence).toBeNull();
    });

    it('hands back a context that the rest of the code accepts', async () => {
      const { user, org, work } = await scene();
      const { context } = await getWorkFollowStateAsMember(
        db(),
        user.id,
        org.organizationId,
        work.id,
      );
      expect((await getOrganization(db(), context))?.id).toBe(org.organizationId);
    });

    it('sees a change on the next poll', async () => {
      const { user, org, work } = await scene();
      const read = () =>
        getWorkFollowStateAsMember(db(), user.id, org.organizationId, work.id, {
          evidence: false,
        });
      expect((await read()).state.version).toBe(work.version);
      const moved = await transitionWorkUnit(db(), org, {
        id: work.id,
        expectedVersion: work.version,
        to: 'ready',
      });
      expect(moved.version).not.toBe(work.version);
      expect((await read()).state.version).toBe(moved.version);
    });
  });

  describe('for anyone who is not a member', () => {
    async function expectDenied(userId: string, organizationId: string, workUnitId: string) {
      const fn = vi.fn(async () => 'ran');
      await expect(withMemberTenantTx(db(), userId, organizationId, fn)).rejects.toBeInstanceOf(
        TenantAccessDenied,
      );
      expect(fn).not.toHaveBeenCalled();
      await expect(
        getWorkFollowStateAsMember(db(), userId, organizationId, workUnitId),
      ).rejects.toBeInstanceOf(TenantAccessDenied);
    }

    it('denies a person from another tenant, and fn never runs', async () => {
      const { org, work } = await scene();
      const outsider = await makeUser('outsider');
      await newOrg(outsider.id);
      await expectDenied(outsider.id, org.organizationId, work.id);
    });

    it('denies a tenant that does not exist with the same answer as a forbidden one', async () => {
      const { org } = await scene();
      const outsider = await makeUser('outsider');
      const fn = vi.fn(async () => 'ran');
      await expect(
        withMemberTenantTx(db(), outsider.id, org.organizationId, fn),
      ).rejects.toThrow('Not found or not permitted');
      await expect(withMemberTenantTx(db(), outsider.id, randomUUID(), fn)).rejects.toThrow(
        'Not found or not permitted',
      );
      expect(fn).not.toHaveBeenCalled();
    });

    it('denies a member whose row has been removed, on the very next poll', async () => {
      const { org, work } = await scene();
      const member = await join(org, 'member');
      await getWorkFollowStateAsMember(db(), member.userId, org.organizationId, work.id);
      await withTenantTx(db(), org, (tx) =>
        tx.execute(sql`delete from org.memberships where id = ${member.membershipId}`),
      );
      await expectDenied(member.userId, org.organizationId, work.id);
    });

    // A membership has no status called suspended. Disabled is the one that means it.
    it('denies a suspended member, on the very next poll', async () => {
      const { org, work } = await scene();
      const member = await join(org, 'member');
      await getWorkFollowStateAsMember(db(), member.userId, org.organizationId, work.id);
      await disableMember(db(), org, { membershipId: member.membershipId });
      await expectDenied(member.userId, org.organizationId, work.id);
    });

    it('denies a member who has only been invited', async () => {
      const { org, work } = await scene();
      const member = await join(org, 'member');
      await withTenantTx(db(), org, (tx) =>
        tx.execute(
          sql`update org.memberships set status = 'invited' where id = ${member.membershipId}`,
        ),
      );
      await expectDenied(member.userId, org.organizationId, work.id);
    });

    it('denies a user ID that nobody has', async () => {
      const { org, work } = await scene();
      await expectDenied(randomUUID(), org.organizationId, work.id);
    });
  });

  describe('for a person in two tenants with the same names', () => {
    async function twoTenants() {
      const user = await makeUser('both');
      const first = await newOrg(user.id);
      const second = await newOrg(user.id);
      const firstWork = await createWorkUnit(db(), first, { title: 'Same title' });
      const secondWork = await createWorkUnit(db(), second, { title: 'Same title' });
      const colleague = await join(second, 'colleague');
      return { user, first, second, firstWork, secondWork, colleague };
    }

    it('shows only the tenant that was asked for inside fn', async () => {
      const { user, first, second, firstWork, secondWork } = await twoTenants();
      const asked = await withMemberTenantTx(
        db(),
        user.id,
        first.organizationId,
        async (tx, context) => {
          expect(context.organizationId).toBe(first.organizationId);
          return {
            work: await tx.select({ id: workUnits.id }).from(workUnits),
            members: await tx
              .select({ organizationId: memberships.organizationId })
              .from(memberships),
            organizations: (await tx.execute(sql`select id from org.organizations`)).rows,
          };
        },
      );
      expect(asked.work.map((row) => row.id)).toEqual([firstWork.id]);
      expect(asked.work.map((row) => row.id)).not.toContain(secondWork.id);
      expect(asked.members.map((row) => row.organizationId)).toEqual([first.organizationId]);
      expect(asked.organizations.map((row) => row.id)).toEqual([first.organizationId]);

      const other = await withMemberTenantTx(db(), user.id, second.organizationId, (tx) =>
        tx.select({ id: workUnits.id }).from(workUnits),
      );
      expect(other.map((row) => row.id)).toEqual([secondWork.id]);
    });

    it('does not show their other membership inside fn (ADR-025 D3)', async () => {
      const { user, first, second } = await twoTenants();
      // First that there is something to hide: with only the user bound, they see both.
      const both = await withUserTx(db(), user.id, (tx) =>
        tx.select({ organizationId: memberships.organizationId }).from(memberships),
      );
      expect(both.map((row) => row.organizationId).sort()).toEqual(
        [first.organizationId, second.organizationId].sort(),
      );

      const inside = await withMemberTenantTx(db(), user.id, first.organizationId, async (tx) => ({
        filtered: await tx.execute(
          sql`select organization_id from org.memberships where user_id = ${user.id}`,
        ),
        asked: await tx.execute(
          sql`select id from org.memberships where organization_id = ${second.organizationId}`,
        ),
      }));
      expect(inside.filtered.rows.map((row) => row.organization_id)).toEqual([
        first.organizationId,
      ]);
      expect(inside.asked.rows).toEqual([]);
    });

    it('shows inside fn just what withTenantTx shows', async () => {
      const { user, second, colleague } = await twoTenants();
      const members = (tx: Tx) =>
        tx.execute(sql`select id from org.memberships order by id`).then(({ rows }) => rows);
      const context = await resolveTenantContext(db(), user.id, second.organizationId);
      const inTenant = await withTenantTx(db(), context, members);
      const inMember = await withMemberTenantTx(db(), user.id, second.organizationId, members);
      expect(inMember).toEqual(inTenant);
      // A tenant's own members are visible, which is not what the self-only policy shows.
      expect(inMember.map((row) => row.id)).toContain(colleague.membershipId);
    });

    it('binds just what withTenantTx binds, whatever gets added to that list', async () => {
      const { user, second } = await twoTenants();
      const context = await resolveTenantContext(db(), user.id, second.organizationId);
      const spy = vi.spyOn(db(), 'transaction');
      const { bound, inTenant } = await withTenantTx(db(), context, async (tx) => {
        // What withTenantTx hands to the database is tenantBindings, so a new name is covered here too.
        const list = spy.mock.calls[0]?.[0] ?? {};
        return {
          bound: list,
          inTenant: await settings(tx, [...Object.keys(list), ...OTHER_BINDINGS]),
        };
      });
      spy.mockRestore();
      const names = Object.keys(bound);
      expect(names).toEqual(expect.arrayContaining(['app.organization_id', 'app.user_id']));
      for (const name of names) expect(name).toMatch(/^app\./);
      for (const name of names) expect(inTenant[name]).toBe(bound[name]);

      const inMember = await withMemberTenantTx(db(), user.id, second.organizationId, (tx) =>
        settings(tx, [...names, ...OTHER_BINDINGS]),
      );
      expect(inMember).toEqual(inTenant);
    });
  });

  describe('with what the request asked for', () => {
    it('gives the context the spelling in the row when the ID comes in capitals', async () => {
      const { user, org, work } = await scene();
      const asked = org.organizationId.toUpperCase();
      expect(asked).not.toBe(org.organizationId);
      const bound = await withMemberTenantTx(db(), user.id, asked, async (tx, context) => {
        expect(context.organizationId).toBe(org.organizationId);
        return settings(tx, ['app.organization_id']);
      });
      expect(bound['app.organization_id']).toBe(org.organizationId);
      const { context, state } = await getWorkFollowStateAsMember(db(), user.id, asked, work.id);
      expect(context.organizationId).toBe(org.organizationId);
      expect(state.version).toBe(work.version);
    });

    it('denies a malformed ID without opening a transaction', async () => {
      const { user, org, work } = await scene();
      const spy = vi.spyOn(db(), 'transaction');
      const fn = vi.fn(async () => 'ran');
      for (const malformed of [
        `x' or '1'='1`,
        '',
        'not-a-uuid',
        `${org.organizationId} `,
        `${org.organizationId}\n`,
      ]) {
        // withMemberTenantTx refuses before it returns a promise, so this catches that too.
        await expect(
          (async () => withMemberTenantTx(db(), user.id, malformed, fn))(),
        ).rejects.toBeInstanceOf(TenantAccessDenied);
        await expect(
          (async () => withMemberTenantTx(db(), malformed, org.organizationId, fn))(),
        ).rejects.toBeInstanceOf(TenantAccessDenied);
        // This one is a real promise, whichever way it is refused.
        await expect(
          getWorkFollowStateAsMember(db(), user.id, malformed, work.id),
        ).rejects.toBeInstanceOf(TenantAccessDenied);
      }
      expect(fn).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    it('answers NOT_FOUND for work in another tenant, as for work that does not exist', async () => {
      const { user, org } = await scene();
      const elsewhere = await scene();
      await expect(
        getWorkFollowStateAsMember(db(), user.id, org.organizationId, elsewhere.work.id),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        getWorkFollowStateAsMember(db(), user.id, org.organizationId, randomUUID()),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('answers NOT_FOUND for that same work when the person is in both tenants', async () => {
      const user = await makeUser('both');
      const first = await newOrg(user.id);
      const second = await newOrg(user.id);
      const work = await createWorkUnit(db(), second, { title: 'Same title' });
      await expect(
        getWorkFollowStateAsMember(db(), user.id, first.organizationId, work.id),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('answers NOT_FOUND for work the member may not read in their own tenant', async () => {
      const { org } = await scene();
      const member = await join(org, 'member');
      const restricted = await createWorkUnit(db(), org, {
        title: 'Hidden',
        classification: 'restricted',
      });
      for (const options of [{}, { evidence: false }]) {
        await expect(
          getWorkFollowStateAsMember(
            db(),
            member.userId,
            org.organizationId,
            restricted.id,
            options,
          ),
        ).rejects.toEqual(code('NOT_FOUND'));
      }
    });
  });

  describe('when something goes wrong', () => {
    /** With one connection, whatever the last transaction left behind would be on this one. */
    async function expectNothingLeft(userId: string, organizationId: string) {
      const left = await withUserTx(db(), userId, async (tx) => ({
        bound: await settings(tx, ['app.organization_id', ...OTHER_BINDINGS]),
        work: await tx.select({ id: workUnits.id }).from(workUnits),
        members: await tx
          .select({ organizationId: memberships.organizationId })
          .from(memberships),
      }));
      expect(left.bound['app.organization_id']).toBe('');
      expect(left.work).toEqual([]);
      // The self-only policy applies again, which it only does with no tenant bound.
      expect(left.members.map((row) => row.organizationId)).toContain(organizationId);
    }

    it('rolls back a rejected fn and leaves no binding on the pooled connection', async () => {
      const { user, org } = await scene();
      const before = await getOrganization(db(), org);
      await expect(
        withMemberTenantTx(db(), user.id, org.organizationId, async (tx) => {
          await tx.execute(
            sql`update org.organizations set name = 'Changed' where id = ${org.organizationId}`,
          );
          throw new Error('fn gave up');
        }),
      ).rejects.toThrow('fn gave up');
      expect((await getOrganization(db(), org))?.name).toBe(before?.name);
      await expectNothingLeft(user.id, org.organizationId);
    });

    it('leaves no binding behind when a refused member never reached fn', async () => {
      const { user, org } = await scene();
      const elsewhere = await scene();
      await expect(
        withMemberTenantTx(db(), user.id, elsewhere.org.organizationId, async () => 'ran'),
      ).rejects.toBeInstanceOf(TenantAccessDenied);
      await expectNothingLeft(user.id, org.organizationId);
    });

    it('fails the poll when the database refuses midway, and the next poll is clean', async () => {
      const { user, org, work } = await scene();
      // The membership has been read and the tenant bound by the time this statement is refused.
      await expect(
        withMemberTenantTx(db(), user.id, org.organizationId, (tx) =>
          tx.execute(sql`select 1 / 0`),
        ),
      ).rejects.not.toBeInstanceOf(TenantAccessDenied);
      await expectNothingLeft(user.id, org.organizationId);
      const { state } = await getWorkFollowStateAsMember(
        db(),
        user.id,
        org.organizationId,
        work.id,
      );
      expect(state.version).toBe(work.version);
    });

    it('fails the poll when the database times a statement out midway', async () => {
      const { user, org } = await scene();
      await expect(
        withMemberTenantTx(db(), user.id, org.organizationId, async (tx) => {
          await tx.execute(sql`select set_config('statement_timeout', '1', true)`);
          return tx.execute(sql`select pg_sleep(1)`);
        }),
      ).rejects.not.toBeInstanceOf(TenantAccessDenied);
      await expectNothingLeft(user.id, org.organizationId);
    });

    it('does not take a failure in the real read for a loss of access', async () => {
      const { user, org } = await scene();
      // The route validates the path, so nothing can send this. It makes the read itself fail, after
      // the membership check has passed and inside the one transaction.
      const failed = await getWorkFollowStateAsMember(
        db(),
        user.id,
        org.organizationId,
        'not-a-uuid',
      ).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect(failed).not.toBeInstanceOf(TenantAccessDenied);
      expect(failed).not.toEqual(code('NOT_FOUND'));
      await expectNothingLeft(user.id, org.organizationId);
    });
  });
});
