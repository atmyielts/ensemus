// ADR-039 D1 against the real roles and migrations 0700 and 0701 (FLAGGED FOR HUMAN SECURITY REVIEW): each
// worker logs in as itself, reads as ensemus_app to every rule that names ensemus_app, and cannot slip past
// a rule meant for some other trusted role. The suite read and consent rules only the connector passes are
// in suite-tools.test.ts, and the offboarding revoke in offboarding-connections.test.ts.
// Generated values only. Written, not yet run: owed to the first stack run.
import { randomUUID } from 'node:crypto';
import { pgCode } from '@ensemus/application';
import { createOrganization, openAppDatabase, resolveTenantContext } from '@ensemus/database';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urls } from '../helpers/stack';

const LOGINS = {
  app: urls.app,
  worker: urls.worker,
  connector: urls.connector,
  knowledge: urls.knowledge,
  agent: urls.agent,
} as const;

describe('worker login roles (ADR-039)', () => {
  const clients = new Map<keyof typeof LOGINS, pg.Client>();
  let superuser: pg.Client;
  let auth: pg.Client;

  beforeAll(async () => {
    for (const [name, url] of Object.entries(LOGINS)) {
      const client = new pg.Client({ connectionString: url() });
      await client.connect();
      clients.set(name as keyof typeof LOGINS, client);
    }
    superuser = new pg.Client({ connectionString: urls.superuser() });
    auth = new pg.Client({ connectionString: urls.auth() });
    await superuser.connect();
    await auth.connect();
  });
  afterAll(async () => {
    for (const client of clients.values()) await client.end();
    await superuser.end();
    await auth.end();
  });

  it('logs each worker in as itself, and maps only the workers onto ensemus_app', async () => {
    const expected = {
      app: ['ensemus_app', 'ensemus_app'],
      worker: ['ensemus_worker', 'ensemus_app'],
      connector: ['ensemus_connector', 'ensemus_app'],
      knowledge: ['ensemus_knowledge', 'ensemus_app'],
      agent: ['ensemus_agent', 'ensemus_agent'],
    };
    for (const [name, [login, tier]] of Object.entries(expected)) {
      const { rows } = await clients
        .get(name as keyof typeof LOGINS)!
        .query<{ login: string; session: string; current: string }>(
          `select session_user::text as login, app.tier_session_user()::text as session,
                  app.tier_current_user()::text as current`,
        );
      expect(rows[0], name).toEqual({ login, session: tier, current: tier });
    }
  });

  it('normalizes legacy tier checks and retains explicit native-login boundaries', async () => {
    const { rows } = await superuser.query<{ name: string; definition: string }>(
      `select p.oid::regprocedure::text as name, pg_get_functiondef(p.oid) as definition
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'
          and p.prokind in ('f','p')
          and not exists (select 1 from pg_depend d
                           where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
          and p.oid not in ('app.tier_session_user()'::regprocedure, 'app.tier_current_user()'::regprocedure)
          and strpos(pg_get_functiondef(p.oid), 'ensemus_app') <> 0
          and pg_get_functiondef(p.oid) ~* '\\m(session_user|current_user)\\M'
       union all
       select 'policy ' || polname,
              coalesce(pg_get_expr(polqual, polrelid), '') || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), '')
         from pg_policy
        where strpos(coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), ''), 'ensemus_app') <> 0
          and (coalesce(pg_get_expr(polqual, polrelid), '') || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), '')) ~* '\\m(session_user|current_user)\\M'`,
    );
    // A body can mention a mapped app check and a distinct native connector check. Match the actual
    // comparison, not the mere presence of both names. Mail invitations deliberately remain web-only.
    const rawTierCheck =
      /\b(?:session_user|current_user)\s*(?:=|<>|!=|(?:NOT\s+)?IN\s*\()\s*'ensemus_app'/i;
    expect(
      rows
        .filter((row) => rawTierCheck.test(row.definition))
        .map((row) => row.name)
        .sort(),
    ).toEqual(['platform.check_new_tenant_mail()', 'skills.guard_signer_administration()'].sort());
  });

  it('lets a worker login do what ensemus_app may, and no more', async () => {
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'generated',
      `generated-${userId}@example.invalid`,
    ]);
    const worker = openAppDatabase(urls.worker());
    try {
      // A person's own organization, through the rules that name ensemus_app and a person.
      const { organizationId } = await createOrganization(worker.db, {
        userId,
        name: 'Generated Ltd',
        commercialMode: 'byom',
      });
      const owner = await resolveTenantContext(worker.db, userId, organizationId);
      expect(owner.role).toBe('owner');
      // The connection guard returns early for roles it does not know (0565). A worker login is not one of
      // them: a member-owned connection outside a consent is refused as it is for ensemus_app.
      const client = clients.get('worker')!;
      await client.query('begin');
      try {
        for (const [name, value] of [
          ['app.organization_id', organizationId],
          ['app.user_id', userId],
          ['app.membership_id', owner.membershipId],
          ['app.actor_type', 'user'],
        ])
          await client.query('select set_config($1, $2, true)', [name, value]);
        const refused = await client
          .query(
            `insert into integrations.connections
               (organization_id, id, connector_type, display_name, state, granted_scopes, owner_membership_id)
             values ($1, $2, 'google_workspace', 'Generated', 'active', '{}', $3)`,
            [organizationId, randomUUID(), owner.membershipId],
          )
          .catch((error: unknown) => error);
        // EN121 from 0565's branch, unless an earlier guard refuses it first; either way, not let through.
        expect(refused).toBeInstanceOf(Error);
        expect(pgCode({ cause: refused })).toMatch(/^(EN|42)/);
      } finally {
        await client.query('rollback');
      }
    } finally {
      await worker.close();
    }
  });

  it('gives no worker login a role of its own beyond ensemus_app', async () => {
    const { rows } = await superuser.query<{ rolname: string; parents: string[]; members: number }>(
      `select r.rolname,
              array(select p.rolname::text from pg_auth_members m join pg_roles p on p.oid = m.roleid
                     where m.member = r.oid order by 1) as parents,
              (select count(*)::int from pg_auth_members m where m.roleid = r.oid) as members
         from pg_roles r
        where r.rolname in ('ensemus_worker','ensemus_connector','ensemus_knowledge')
          and not (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolbypassrls or r.rolreplication)
        order by 1`,
    );
    expect(rows).toEqual([
      { rolname: 'ensemus_connector', parents: ['ensemus_app'], members: 0 },
      { rolname: 'ensemus_knowledge', parents: ['ensemus_app'], members: 0 },
      { rolname: 'ensemus_worker', parents: ['ensemus_app'], members: 0 },
    ]);
  });
});
