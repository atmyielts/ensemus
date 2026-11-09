// FOUND-03, FOUND-02, ASSUR-02, QA-001, DATA-TS-01, DEP-TS-01. Runs against real PostgreSQL with
// the real runtime roles, never as an owner or superuser.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  getOrganization,
  listAuditEvents,
  listMembers,
  listMyOrganizations,
  openAppDatabase,
  resolveTenantContext,
  TenantAccessDenied,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { runMigrations } from '@ensemus/database/migrate';
import { acceptInvitation, createInvitation, disableMember } from '@ensemus/application';
import { makePerson, nativePersonContext, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

const client = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

async function makeUser(auth: pg.Client, label: string) {
  const id = randomUUID();
  await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
    id,
    label,
    `${label}-${id}@example.invalid`,
  ]);
  return id;
}

describe('tenant isolation', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let raw: pg.Client;
  let alice: string;
  let bob: string;
  let orgA: { organizationId: string };
  let orgB: { organizationId: string };
  let ctxA: TenantContext;

  beforeAll(async () => {
    // One connection on purpose: every query reuses it, so leaked tenant state would show up.
    database = openAppDatabase(urls.app(), { max: 1 });
    auth = await client(urls.auth());
    raw = await client(urls.app());
    alice = await makeUser(auth, 'alice');
    bob = await makeUser(auth, 'bob');
    orgA = await createOrganization(database.db, {
      userId: alice,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    orgB = await createOrganization(database.db, {
      userId: bob,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    ctxA = await resolveTenantContext(database.db, alice, orgA.organizationId);
  });

  afterAll(async () => {
    await database?.close();
    await auth?.end();
    await raw?.end();
  });

  it('shows a user only their own organizations, before any tenant is bound', async () => {
    const mine = await listMyOrganizations(database.db, alice);
    expect(mine.map((o) => o.id)).toEqual([orgA.organizationId]);
  });

  it('denies a tenant the user does not belong to, the same way as one that does not exist', async () => {
    const forbidden = resolveTenantContext(database.db, alice, orgB.organizationId);
    const missing = resolveTenantContext(database.db, alice, randomUUID());
    await expect(forbidden).rejects.toBeInstanceOf(TenantAccessDenied);
    await expect(missing).rejects.toThrow('Not found or not permitted');
    await expect(forbidden).rejects.toThrow('Not found or not permitted');
  });

  it('rejects malformed IDs instead of passing them to SQL', async () => {
    await expect(resolveTenantContext(database.db, alice, `x' or '1'='1`)).rejects.toBeInstanceOf(
      TenantAccessDenied,
    );
  });

  it('rejects a hand-made tenant context', async () => {
    const forged = { organizationId: orgB.organizationId, userId: alice } as TenantContext;
    await expect(withTenantTx(database.db, forged, async () => 1)).rejects.toBeInstanceOf(
      TenantAccessDenied,
    );
  });

  it('returns only the bound tenant, even with no WHERE clause', async () => {
    const org = await getOrganization(database.db, ctxA);
    expect(org?.id).toBe(orgA.organizationId);
    const members = await listMembers(database.db, ctxA);
    expect(members.map((m) => m.userId)).toEqual([alice]);
    const audit = await listAuditEvents(database.db, ctxA);
    expect(audit.every((a) => a.organizationId === orgA.organizationId)).toBe(true);
    expect(audit.some((a) => a.action === 'organization.created')).toBe(true);
  });

  it('reads zero tenant rows with no tenant bound', async () => {
    for (const table of ['org.memberships', 'org.organizations', 'governance.audit_events']) {
      const { rows } = await raw.query(`select count(*)::int as n from ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
    const { rows } = await raw.query('select count(*)::int as n from identity.users');
    expect(rows[0].n).toBe(0);
  });

  it('does not leak tenant context across a reused pooled connection', async () => {
    await listMembers(database.db, ctxA);
    await database.db.run(async (tx) => {
      const rows = await tx.execute(`select count(*)::int as n from org.memberships`);
      expect(rows.rows[0]?.n).toBe(0);
    });
  });

  it('blocks writing into another tenant from a bound transaction', async () => {
    await raw.query('begin');
    try {
      await raw.query(`select set_config('app.organization_id', $1, true)`, [orgA.organizationId]);
      await expect(
        raw.query(
          `insert into org.memberships (organization_id, id, user_id) values ($1, gen_random_uuid(), $2)`,
          [orgB.organizationId, alice],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await raw.query('rollback');
    }
  });

  it('lets a two-tenant member reach each tenant only when bound to it', async () => {
    const carol = await makeUser(auth, 'carol');
    const c1 = await createOrganization(database.db, {
      userId: carol,
      name: 'Carol One',
      commercialMode: 'cloud',
    });
    const c2 = await createOrganization(database.db, {
      userId: carol,
      name: 'Carol Two',
      commercialMode: 'cloud',
    });
    const ctx1 = await resolveTenantContext(database.db, carol, c1.organizationId);
    const ctx2 = await resolveTenantContext(database.db, carol, c2.organizationId);
    expect((await getOrganization(database.db, ctx1))?.name).toBe('Carol One');
    expect((await getOrganization(database.db, ctx2))?.name).toBe('Carol Two');
    expect(await listMyOrganizations(database.db, carol)).toHaveLength(2);

    // Regression: inside one tenant, her membership in the other must not be visible.
    const members = await withTenantTx(database.db, ctx1, (tx) =>
      tx.execute(`select organization_id from org.memberships`),
    );
    expect(members.rows.map((r) => r.organization_id)).toEqual([c1.organizationId]);
    const orgs = await withTenantTx(database.db, ctx1, (tx) =>
      tx.execute(`select id from org.organizations`),
    );
    expect(orgs.rows.map((r) => r.id)).toEqual([c1.organizationId]);
  });

  it('stops access as soon as a membership is disabled', async () => {
    const manager = await makePerson('revocation-owner');
    const dave = await makeUser(auth, 'dave');
    const email = `dave-${dave}@example.invalid`;
    const org = await createOrganization(database.db, {
      userId: manager.userId,
      name: 'Membership revocation',
      commercialMode: 'cloud',
    });
    await proveSecondFactor(manager);
    const owner = await nativePersonContext(database.db, manager, org.organizationId);
    await auth.query('update identity.users set email_verified=true where id=$1', [dave]);
    const invitation = await createInvitation(database.db, owner, { email, role: 'member' });
    await acceptInvitation(database.db, {
      token: invitation.token,
      userId: dave,
      email,
      emailVerified: true,
    });
    const ctx = await resolveTenantContext(database.db, dave, org.organizationId);
    await disableMember(database.db, owner, { membershipId: ctx.membershipId });
    await expect(
      resolveTenantContext(database.db, dave, org.organizationId),
    ).rejects.toBeInstanceOf(TenantAccessDenied);
  });

  it('keeps the audit log append-only, even for its owner', async () => {
    const owner = await client(urls.migrator());
    await raw.query('begin');
    await raw.query(`select set_config('app.organization_id', $1, true)`, [orgA.organizationId]);
    await expect(
      raw.query('update governance.audit_events set decision = $1', ['deny']),
    ).rejects.toThrow(/permission denied/);
    await raw.query('rollback');
    await expect(owner.query('delete from governance.audit_events')).rejects.toThrow(/append-only/);
    await owner.end();
  });
});

describe('role boundaries', () => {
  let su: pg.Client;

  beforeAll(async () => {
    su = await client(urls.superuser());
  });
  afterAll(() => su.end());

  const grantsOf = async (role: string) => {
    const { rows } = await su.query(
      `select table_schema || '.' || table_name || ':' || privilege_type as grant
         from information_schema.role_table_grants
        where grantee = $1 order by 1`,
      [role],
    );
    return rows.map((r) => r.grant as string);
  };

  it('gives no runtime role superuser, CREATEROLE or BYPASSRLS', async () => {
    const { rows } = await su.query(
      `select rolname from pg_roles
        where rolname in ('ensemus_app','ensemus_auth','ensemus_dispatcher','ensemus_secrets','ensemus_migrator')
          and (rolsuper or rolcreaterole or rolbypassrls or rolcreatedb)`,
    );
    expect(rows).toEqual([]);
  });

  it('forces RLS on every table in a tenant schema, including future ones', async () => {
    const { rows } = await su.query(
      `select n.nspname || '.' || c.relname as t
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p')
          and n.nspname in ('org','platform','governance','secrets','identity','work','integrations','ai','knowledge',
                            'studio','objects','packs','experience')
          and not (c.relrowsecurity and c.relforcerowsecurity)`,
    );
    expect(rows).toEqual([]);
  });

  it('lets the dispatcher see outbox state and event metadata, and nothing else', async () => {
    const grants = await grantsOf('ensemus_dispatcher');
    expect(grants.filter((g) => !g.startsWith('platform.outbox_events:'))).toEqual([]);

    const d = await client(urls.dispatcher());
    await expect(d.query('select * from org.memberships')).rejects.toThrow(/permission denied/);
    await expect(d.query('select * from identity.users')).rejects.toThrow(/permission denied/);
    await expect(d.query('select * from secrets.sealed_secrets')).rejects.toThrow(
      /permission denied/,
    );
    await expect(d.query('select payload from platform.domain_events')).rejects.toThrow(
      /permission denied/,
    );
    await expect(d.query('select actor_id from platform.domain_events')).rejects.toThrow(
      /permission denied/,
    );
    await d.query('select id, event_type, organization_id from platform.domain_events');
    await d.end();
  });

  it('keeps sealed secrets unreadable by the application role', async () => {
    const a = await client(urls.app());
    await expect(a.query('select * from secrets.sealed_secrets')).rejects.toThrow(
      /permission denied/,
    );
    await expect(a.query('select ciphertext from secrets.sealed_secrets')).rejects.toThrow(
      /permission denied/,
    );
    await a.end();
  });

  it('keeps sessions and password hashes away from the application role', async () => {
    const a = await client(urls.app());
    for (const t of ['identity.sessions', 'identity.accounts', 'identity.verifications']) {
      await expect(a.query(`select * from ${t}`), t).rejects.toThrow(/permission denied/);
    }
    await expect(a.query('select token from identity.sessions')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(a.query('select password from identity.accounts')).rejects.toMatchObject({
      code: '42501',
    });
    await a.end();
  });

  it('bounds native email-verification metadata to the current user and forbids changing it', async () => {
    const a = await client(urls.app());
    const auth = await client(urls.auth());
    let transaction = false;
    try {
      const ownId = await makeUser(auth, 'role-metadata-self');
      const otherId = await makeUser(auth, 'role-metadata-other');
      const read = () =>
        a.query<{ id: string; email_verified: boolean }>(
          'select id,email_verified from identity.users where id=any($1::uuid[]) order by id',
          [[ownId, otherId, randomUUID()]],
        );
      expect((await read()).rows).toEqual([]);
      await a.query('begin');
      transaction = true;
      await a.query(
        "select set_config('app.user_id',$1,true),set_config('app.organization_id','',true),set_config('app.membership_id','',true),set_config('app.actor_type','user',true)",
        [ownId],
      );
      // 0404 intentionally grants this boolean for native invitation acceptance. Existing
      // users_self/tenant RLS applies, and no session, provider or password column is added.
      const visible = await read();
      expect(visible.fields.map((field) => field.name)).toEqual(['id', 'email_verified']);
      expect(visible.rows).toStrictEqual([{ id: ownId, email_verified: false }]);
      await a.query('savepoint native_metadata_write');
      await expect(
        a.query('update identity.users set email_verified=true where id=$1', [ownId]),
      ).rejects.toMatchObject({ code: '42501' });
      await a.query('rollback to savepoint native_metadata_write');
      expect((await read()).rows).toStrictEqual([{ id: ownId, email_verified: false }]);
    } finally {
      if (transaction) await a.query('rollback');
      await a.end();
      await auth.end();
    }
  });

  it('keeps the auth role away from tenant data', async () => {
    const a = await client(urls.auth());
    await expect(a.query('select * from org.memberships')).rejects.toThrow(/permission denied/);
    await expect(a.query('select * from governance.audit_events')).rejects.toThrow(
      /permission denied/,
    );
    await a.end();
  });

  it('keeps the secrets role to its own schema', async () => {
    const s = await client(urls.secrets());
    await expect(s.query('select * from org.memberships')).rejects.toThrow(/permission denied/);
    await expect(s.query('select * from identity.accounts')).rejects.toThrow(/permission denied/);
    const { rows } = await s.query('select count(*)::int as n from secrets.sealed_secrets');
    expect(rows[0].n).toBe(0);
    await s.end();
  });

  it('applies migrations once when several jobs start together', async () => {
    await Promise.all(Array.from({ length: 4 }, () => runMigrations(urls.migrator())));
    const { rows } = await su.query(
      `select count(*)::int as n, count(distinct hash)::int as d from drizzle.__drizzle_migrations`,
    );
    expect(rows[0].n).toBe(rows[0].d);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
