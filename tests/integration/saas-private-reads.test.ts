// Real login roles and generated fixtures. No SET SESSION AUTHORIZATION shortcut substitutes for
// the actual agent login, including the deliberate SET ROLE app / forged actor negatives below.
import { memberships, openAppDatabase, withTenantTx, type TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createWorkUnit, disableMember, setMemberRole } from '@ensemus/application';
import { createEntitlementChecker, getEntitlements } from '@ensemus/application/saas/entitlements';
import { getTenantStanding } from '@ensemus/application/saas/standing';
import { openTicket } from '@ensemus/application/saas/support';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { asRole, seedBillingAccount, seedPlan, seedSubscription } from '../helpers/saas';
import { urls } from '../helpers/stack';

describe('financial and support bodies remain outside actual agent logins', () => {
  const app = openAppDatabase(urls.app()),
    agent = new pg.Client({ connectionString: urls.agent() }),
    appClient = new pg.Client({ connectionString: urls.app() });
  let people: Awaited<ReturnType<typeof makeTwoTenants>>;
  let planVersionId: string, ownerTicket: string, memberTicket: string, breakGlassId: string;
  let owner: TenantContext, member: TenantContext;
  const email = 'generated-private-billing@example.invalid',
    taxId = 'GENERATED-PRIVATE-TAX';

  async function bound<T>(
    client: pg.Client,
    context: TenantContext,
    use: (c: pg.Client) => Promise<T>,
    options: {
      actor?: string;
      asApp?: boolean;
      userId?: string;
      membershipId?: string;
      organizationId?: string;
    } = {},
  ) {
    await client.query('begin');
    try {
      if (options.asApp) await client.query('set local role ensemus_app');
      await client.query(
        `select set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true),
        set_config('app.membership_id',$3,true),set_config('app.actor_type',$4,true)`,
        [
          options.organizationId ?? context.organizationId,
          options.userId ?? context.userId,
          options.membershipId ?? context.membershipId,
          options.actor ?? 'user',
        ],
      );
      return await use(client);
    } finally {
      await client.query('rollback');
    }
  }

  beforeAll(async () => {
    await agent.connect();
    await appClient.connect();
    people = await makeTwoTenants(app.db);
    owner = people.a.owner.context;
    member = people.a.member.context;
    const plan = await seedPlan({ mode: 'byom' });
    planVersionId = plan.planVersionId;
    const subscription = await seedSubscription(app.db, owner, plan, {
      createdByRef: 'generated-private-subscriber@example.invalid',
    });
    await seedBillingAccount(app.db, owner, {
      billingName: 'Generated private billing name',
      billingEmail: email,
      taxId,
    });
    await withTenantTx(app.db, owner, async (tx) => {
      const period = await tx.execute<{
        id: string;
      }>(sql`insert into billing.billing_periods(organization_id,subscription_id,plan_version_id,starts_at,ends_at)
        values(${owner.organizationId}::uuid,${subscription.id}::uuid,${planVersionId}::uuid,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day') returning id`);
      await tx.execute(sql`insert into billing.invoices(organization_id,kind,currency,subscription_id,billing_period_id,bill_to)
        values(${owner.organizationId}::uuid,'subscription','XTS',${subscription.id}::uuid,${period.rows[0]!.id}::uuid,${JSON.stringify({ billing_email: email, tax_id: taxId })}::jsonb)`);
      await tx.execute(sql`insert into billing.credit_accounts(organization_id,balance_microcredits,usage_cursor)
        values(${owner.organizationId}::uuid,12345,'generated-private-usage-cursor') on conflict(organization_id) do update set balance_microcredits=12345,usage_cursor='generated-private-usage-cursor'`);
      await tx.execute(sql`insert into billing.standing_changes(organization_id,from_lifecycle,to_lifecycle,reason_code,actor_type,actor_ref)
        values(${owner.organizationId}::uuid,'active','active','TEST_PRIVATE_STANDING','operator','generated-private-operator@example.invalid')`);
    });
    ownerTicket = (
      await openTicket(app.db, owner, {
        subject: 'Generated owner subject',
        category: 'billing',
        body: 'Generated owner private support body',
      })
    ).ticketId;
    memberTicket = (
      await openTicket(app.db, member, {
        subject: 'Generated member subject',
        category: 'other',
        body: 'Generated member private support body',
      })
    ).ticketId;
    const work = await createWorkUnit(app.db, owner, { title: 'Generated break-glass target' });
    await asRole(
      'ensemus_support',
      async (c) => {
        const row = await c.query<{ id: string }>(
          `insert into support.break_glass_requests(organization_id,ticket_id,requested_by,reason_code,scope_type,scope_id,requested_minutes)
        values($1,$2,'generated-private-desk@example.invalid','TEST_PRIVATE','work_unit',$3,10) returning id`,
          [owner.organizationId, ownerTicket, work.id],
        );
        breakGlassId = row.rows[0]!.id;
        await c.query(
          `insert into support.break_glass_log(organization_id,request_id,action,actor_ref)
        values($1,$2,'requested','generated-private-desk@example.invalid')`,
          [owner.organizationId, breakGlassId],
        );
      },
      { organizationId: owner.organizationId },
    );
  });
  afterAll(async () => {
    await agent.end();
    await appClient.end();
    await app.close();
  });

  it('allows real app owner/admin bodies and keeps ordinary member financial rows closed', async () => {
    const rows = await bound(appClient, owner, (c) =>
      c.query('select billing_email,tax_id from billing.billing_accounts'),
    );
    expect(rows.rows).toEqual([{ billing_email: email, tax_id: taxId }]);
    const invoices = await bound(appClient, people.a.admin.context, (c) =>
      c.query('select bill_to from billing.invoices'),
    );
    expect(invoices.rows).toEqual([{ bill_to: { billing_email: email, tax_id: taxId } }]);
    for (const table of [
      'billing_accounts',
      'invoices',
      'subscriptions',
      'credit_accounts',
      'standing_changes',
    ]) {
      expect(
        (await bound(appClient, member, (c) => c.query(`select * from billing.${table}`))).rows,
      ).toEqual([]);
    }
  });

  it.each(['agent', 'user', 'delegated', 'service'])(
    'actual agent login cannot read private bodies with a forged %s actor',
    async (actor) => {
      for (const asApp of [false, true]) {
        await bound(
          agent,
          owner,
          async (c) => {
            expect((await c.query('select session_user,current_user')).rows[0]).toEqual({
              session_user: 'ensemus_agent',
              current_user: asApp ? 'ensemus_app' : 'ensemus_agent',
            });
            // A caller-supplied private function scope is not a body-serving capability.
            await c.query("select set_config('billing.entitlement_org',$1,true)", [
              owner.organizationId,
            ]);
            for (const table of [
              'billing_accounts',
              'subscriptions',
              'subscription_changes',
              'standing_changes',
              'billing_periods',
              'credit_accounts',
              'top_ups',
              'credit_ledger',
              'invoices',
              'invoice_lines',
              'payments',
              'payment_attempts',
              'payment_events',
              'payment_webhook_events',
              'collection_cases',
            ])
              expect((await c.query(`select * from billing.${table}`)).rows, table).toEqual([]);
            for (const table of [
              'tickets',
              'ticket_messages',
              'break_glass_requests',
              'break_glass_log',
            ])
              expect((await c.query(`select * from support.${table}`)).rows, table).toEqual([]);
          },
          { actor, asApp },
        );
      }
    },
  );

  it('returns exactly the five metadata fields to app members and actual agent logins, including SET ROLE app', async () => {
    for (const [client, context, options] of [
      [appClient, member, {}],
      [agent, owner, { actor: 'agent' }],
      [agent, owner, { actor: 'service', asApp: true }],
    ] as const) {
      const result = await bound(
        client,
        context,
        async (c) => {
          await c.query("select set_config('billing.entitlement_org','prior-scope',true)");
          const row = (await c.query('select * from billing.current_entitlement_metadata()'))
            .rows[0];
          expect(
            (await c.query("select current_setting('billing.entitlement_org',true) scope")).rows[0]
              ?.scope,
          ).toBe('prior-scope');
          return row;
        },
        options,
      );
      expect(Object.keys(result).sort()).toEqual(
        [
          'planVersionId',
          'subscriptionStatus',
          'balanceMicrocredits',
          'standingReasonCode',
          'standingChangedAt',
        ].sort(),
      );
      expect(result).toMatchObject({
        planVersionId,
        subscriptionStatus: 'active',
        balanceMicrocredits: '12345',
        standingReasonCode: 'TEST_PRIVATE_STANDING',
      });
      expect(JSON.stringify(result)).not.toContain(email);
      expect(JSON.stringify(result)).not.toContain(taxId);
      expect(JSON.stringify(result)).not.toContain('usage-cursor');
      expect(JSON.stringify(result)).not.toContain('operator@example');
    }
  });

  it('preserves ordinary member workspace licensing and account standing through the real service', async () => {
    expect((await getEntitlements(app.db, member, { billingEnabled: true })).features).toEqual([
      'work',
    ]);
    expect(await createEntitlementChecker(app.db, true).check(member, 'model.call')).toEqual({
      ok: true,
      billable: false,
      commercialMode: 'byom',
    });
    expect(await getTenantStanding(app.db, member)).toMatchObject({
      lifecycle: 'active',
      reasonCode: 'TEST_PRIVATE_STANDING',
    });
  });

  it('preserves actual app service financial jobs without admitting an agent forged service', async () => {
    const service = createServiceContext(owner.organizationId);
    expect(
      (
        await bound(appClient, service, (c) => c.query('select bill_to from billing.invoices'), {
          actor: 'service',
        })
      ).rows,
    ).toEqual([{ bill_to: { billing_email: email, tax_id: taxId } }]);
    expect(
      (
        await bound(agent, service, (c) => c.query('select bill_to from billing.invoices'), {
          actor: 'service',
          asApp: true,
        })
      ).rows,
    ).toEqual([]);
  });

  it('gives support members only their own actual ticket and message, while admin sees both', async () => {
    expect(
      (await bound(appClient, member, (c) => c.query('select id from support.tickets'))).rows,
    ).toEqual([{ id: memberTicket }]);
    expect(
      (
        await bound(appClient, member, (c) =>
          c.query('select ticket_id,body from support.ticket_messages'),
        )
      ).rows,
    ).toEqual([{ ticket_id: memberTicket, body: 'Generated member private support body' }]);
    expect(
      (
        await bound(appClient, people.a.admin.context, (c) =>
          c.query('select id from support.tickets order by id'),
        )
      ).rows,
    ).toEqual([ownerTicket, memberTicket].sort().map((id) => ({ id })));
  });

  it('keeps break-glass body/history owner-only while preserving the real support desk role', async () => {
    expect(
      (await bound(appClient, owner, (c) => c.query('select id from support.break_glass_requests')))
        .rows,
    ).toEqual([{ id: breakGlassId }]);
    for (const context of [member, people.a.admin.context]) {
      expect(
        (
          await bound(appClient, context, (c) =>
            c.query('select * from support.break_glass_requests'),
          )
        ).rows,
      ).toEqual([]);
      expect(
        (await bound(appClient, context, (c) => c.query('select * from support.break_glass_log')))
          .rows,
      ).toEqual([]);
    }
    expect(
      (
        await asRole('ensemus_support', (c) =>
          c.query('select id from support.break_glass_requests where id=$1', [breakGlassId]),
        )
      ).rows,
    ).toEqual([{ id: breakGlassId }]);
  });

  it('keeps approved global plan/rate semantics unchanged for actual agent login', async () => {
    const rows = await bound(
      agent,
      owner,
      (c) => c.query('select id from billing.plan_versions where id=$1', [planVersionId]),
      { actor: 'agent', asApp: true },
    );
    expect(rows.rows).toEqual([{ id: planVersionId }]);
  });

  it('refuses a foreign tenant/member or mismatched user and restores the function scope on error', async () => {
    for (const options of [
      { organizationId: people.b.organizationId },
      { userId: people.b.owner.userId },
    ]) {
      await bound(
        appClient,
        member,
        async (c) => {
          await c.query("select set_config('billing.entitlement_org','prior-scope',true)");
          await c.query('savepoint metadata_failure');
          await expect(
            c.query('select * from billing.current_entitlement_metadata()'),
          ).rejects.toMatchObject({ code: '42501' });
          await c.query('rollback to savepoint metadata_failure');
          expect(
            (await c.query("select current_setting('billing.entitlement_org',true) scope")).rows[0]
              ?.scope,
          ).toBe('prior-scope');
        },
        options,
      );
    }
  });

  it('does not let unrelated operator/support roles call the tenant metadata RPC', async () => {
    for (const role of ['ensemus_operator', 'ensemus_support'] as const)
      await expect(
        asRole(role, (c) => c.query('select * from billing.current_entitlement_metadata()'), {
          organizationId: owner.organizationId,
        }),
      ).rejects.toMatchObject({ code: '42501' });
  });

  it('rechecks a disabled member instead of trusting a retained context role', async () => {
    await proveSecondFactor(people.a.owner);
    await disableMember(app.db, owner, { membershipId: member.membershipId });
    expect(
      (await bound(appClient, member, (c) => c.query('select * from support.tickets'))).rows,
    ).toEqual([]);
    await expect(
      bound(appClient, member, (c) =>
        c.query('select * from billing.current_entitlement_metadata()'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const actual = await withTenantTx(app.db, owner, (tx) =>
      tx.select({ id: memberships.id, status: memberships.status }).from(memberships),
    );
    expect(actual).toContainEqual({ id: member.membershipId, status: 'disabled' });
  });

  it('rechecks a demoted admin instead of trusting a retained financial role', async () => {
    await proveSecondFactor(people.a.owner);
    await setMemberRole(app.db, owner, {
      membershipId: people.a.admin.context.membershipId,
      role: 'member',
    });
    expect(
      (
        await bound(appClient, people.a.admin.context, (c) =>
          c.query('select * from billing.billing_accounts'),
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await bound(appClient, people.a.admin.context, (c) =>
          c.query('select id from support.tickets'),
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await getEntitlements(app.db, people.a.admin.context, { billingEnabled: true })).features,
    ).toEqual(['work']);
  });
});
