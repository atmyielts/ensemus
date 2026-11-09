// 0545: the offline restore operator's one-way SSO revocation passes the 0404/0410 SSO guards, and
// nothing else does. Real migrator SQL on the shared integration database.
//
// identity.begin_auth_restore itself refuses while any runtime role is connected (0422), which an
// integration database always has, so it cannot be called here; tests/stack/restore-drill.test.ts
// calls the real one over a database holding an active SCIM token. Here the migrator makes the same
// control transition begin makes (operation 'begin', a fresh pending generation), under 0422's own
// unchanged control guard, inside one transaction that is always rolled back, and then runs begin's
// and reconcile's exact revocation statements with the GUCs they set. No other connection ever sees
// the pending phase.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganization, openAppDatabase } from '@ensemus/database';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { urls } from '../helpers/stack';

const CONTROL = '68766d8e-9f7d-4b87-b881-bb4c3ff1654b';

/** begin's own control row update (0422 identity.begin_auth_restore), as the migrator, in `client`'s open transaction. */
async function simulateBegin(client: pg.Client): Promise<string> {
  const generation = randomUUID();
  await client.query("select set_config('identity.auth_restore_operation','begin',true)");
  const updated = await client.query(
    `update identity.verifications set value=jsonb_build_object('version',1,'generation',$1::uuid,
      'phase','pending','backupId',$2::uuid,'manifestSha256',$3::text,'cutoff',clock_timestamp(),
      'notBefore',clock_timestamp()+interval '15 minutes','invalidation',NULL,'securitySha256',NULL,
      'externalReviewSha256',NULL,'externalReviewBytes',NULL,'admittedAt',NULL)::text
     where id=$4`,
    [generation, randomUUID(), createHash('sha256').update(generation).digest('hex'), CONTROL],
  );
  expect(updated.rowCount).toBe(1);
  return generation;
}

/** The GUCs begin and reconcile set around their revocations. */
const reconcileAs = (client: pg.Client, generation: string) =>
  client.query(
    "select set_config('identity.auth_restore_operation','reconcile',true),set_config('identity.auth_restore_generation',$1,true)",
    [generation],
  );

// begin_auth_restore's statement for every outstanding SCIM bearer, narrowed to this fixture's row.
const REVOKE_SCIM =
  "update org.scim_tokens set state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()) where organization_id=$1 and id=$2";
// reconcile_auth_restore's 'disable_provider' statement.
const DISABLE_PROVIDER =
  "update org.sso_connections set state='disabled',auto_join=false,version=version+1,updated_at=clock_timestamp() where organization_id=$1 and id=$2";

describe('0545: restore revocation through the SSO guards', () => {
  const app = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() }),
    migrator = new pg.Client({ connectionString: urls.migrator() });
  let organizationId: string, connectionId: string, tokenId: string;

  beforeAll(async () => {
    await auth.connect();
    await migrator.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'owner',
      `owner-${userId}@example.invalid`,
    ]);
    const org = await createOrganization(app.db, {
      userId,
      name: 'Generated restore SSO company',
      commercialMode: 'sovereign',
    });
    organizationId = org.organizationId;
    // An active verified connection with automatic joining, and a live SCIM bearer on it: the
    // authority a restored dump can bring back. No production path issues them without a person's
    // interactive MFA proof, so the generated fixture writes the rows as the superuser, bound to the
    // tenant so every SSO trigger still checks them.
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    try {
      await inFixtureTenant(su, organizationId, async () => {
        connectionId = (
          await su.query<{ id: string }>(
            `insert into org.sso_connections(organization_id,provider_id,display_name,domain,domain_state,
              domain_verified_at,state,auto_join,created_by_membership_id)
             values($1,$2,'Generated provider',$3,'verified',now(),'active',true,$4) returning id`,
            [
              organizationId,
              `generated-${randomUUID()}`,
              `restore-${randomUUID()}.example.invalid`,
              org.membershipId,
            ],
          )
        ).rows[0]!.id;
        tokenId = (
          await su.query<{ id: string }>(
            `insert into org.scim_tokens(organization_id,connection_id,token_hash,created_by_membership_id)
             values($1,$2,$3,$4) returning id`,
            [
              organizationId,
              connectionId,
              createHash('sha256').update(randomUUID()).digest('hex'),
              org.membershipId,
            ],
          )
        ).rows[0]!.id;
      });
    } finally {
      await su.end();
    }
  });

  afterAll(async () => {
    await migrator.end();
    await auth.end();
    await app.close();
  });

  it("lets a pending generation's reconcile revoke a SCIM bearer and disable a provider", async () => {
    await migrator.query('begin');
    try {
      const generation = await simulateBegin(migrator);
      await reconcileAs(migrator, generation);
      expect((await migrator.query(REVOKE_SCIM, [organizationId, tokenId])).rowCount).toBe(1);
      expect(
        (await migrator.query(DISABLE_PROVIDER, [organizationId, connectionId])).rowCount,
      ).toBe(1);
      // It revoked: the rows now say so, in this transaction.
      const token = await migrator.query<{ state: string; revoked: boolean }>(
        'select state, revoked_at is not null as revoked from org.scim_tokens where organization_id=$1 and id=$2',
        [organizationId, tokenId],
      );
      expect(token.rows).toEqual([{ state: 'revoked', revoked: true }]);
      // A change that is not a revocation is still refused (0422's own trigger answers first).
      await migrator.query('savepoint reactivate');
      await expect(
        migrator.query(
          "update org.scim_tokens set state='active',revoked_at=null where organization_id=$1 and id=$2",
          [organizationId, tokenId],
        ),
      ).rejects.toMatchObject({ code: 'EN422', message: 'AUTH_RESTORE_RECONCILE_REFUSED' });
      await migrator.query('rollback to savepoint reactivate');
      // A generation that is not the pending one is refused too.
      await reconcileAs(migrator, randomUUID());
      await migrator.query('savepoint stale');
      await expect(
        migrator.query(DISABLE_PROVIDER, [organizationId, connectionId]),
      ).rejects.toMatchObject({ code: 'EN422', message: 'AUTH_RESTORE_RECONCILE_REFUSED' });
      await migrator.query('rollback to savepoint stale');
    } finally {
      await migrator.query('rollback');
    }
  });

  it('refuses the same statements once the restore is admitted, with no tenant bound', async () => {
    // The committed control row is admitted (every other integration test needs it so). 0422's trigger
    // lets the migrator through then, so these refusals are the 0404 and 0410 guards' own.
    const current = await migrator.query<{ generation: string; phase: string }>(
      "select value::jsonb->>'generation' as generation, value::jsonb->>'phase' as phase from identity.verifications where id=$1",
      [CONTROL],
    );
    expect(current.rows[0]?.phase).toBe('admitted');
    for (const [statement, id, message] of [
      [REVOKE_SCIM, () => tokenId, 'INTERACTIVE_GUARD_TARGET_INVALID'],
      // sso_connections_effect_policy (0410) fires before sso_connections_interactive (0404).
      [DISABLE_PROVIDER, () => connectionId, 'SSO_POLICY_SCOPE_INVALID'],
    ] as const) {
      await migrator.query('begin');
      try {
        await reconcileAs(migrator, current.rows[0]!.generation);
        await expect(migrator.query(statement, [organizationId, id()])).rejects.toMatchObject({
          code: '42501',
          message,
        });
      } finally {
        await migrator.query('rollback');
      }
    }
    // Nothing was revoked.
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    try {
      const rows = await su.query<{ token: string; connection: string }>(
        `select t.state as token, c.state as connection from org.scim_tokens t
         join org.sso_connections c on c.organization_id=t.organization_id and c.id=t.connection_id
         where t.organization_id=$1 and t.id=$2`,
        [organizationId, tokenId],
      );
      expect(rows.rows).toEqual([{ token: 'active', connection: 'active' }]);
    } finally {
      await su.end();
    }
  });

  it('gives no runtime role the helper', async () => {
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    try {
      const rows = await su.query<{ role: string; allowed: boolean }>(
        `select r.rolname as role, has_function_privilege(r.rolname,
           'identity.auth_restore_sso_revocation(regclass,jsonb,jsonb)','EXECUTE') as allowed
         from pg_roles r where r.rolname in ('ensemus_app','ensemus_agent','ensemus_auth','ensemus_dispatcher','ensemus_secrets')
         order by r.rolname`,
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.filter((row) => row.allowed)).toEqual([]);
    } finally {
      await su.end();
    }
  });
});
