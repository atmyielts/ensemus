// ADR-032's database rules on their own: forced RLS, what each role can reach, and the triggers that hold
// invoices, payments, holds and erasure, whatever application code does. Real PostgreSQL, real roles. The
// slices test behaviour on top of this, and each writes its own file. Needs the journal entry for 0500 and 0501,
// which the final merge adds, and a database, so it is unverified until then.
import { randomUUID } from 'node:crypto';
import {
  creditAccounts,
  creditLedger,
  createOrganization,
  invoiceLines,
  invoices,
  legalHolds,
  legalHoldScopes,
  offboardings,
  openAppDatabase,
  paymentAttempts,
  payments,
  resolveTenantContext,
  tombstones,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { eq, sql } from 'drizzle-orm';
import { withAccountTx } from '@ensemus/database/account';
import { createServiceContext } from '@ensemus/database/service';
import { requestOffboarding } from '@ensemus/application/saas/offboarding';
import { createOffboardingAgentHaltPort } from '@ensemus/application/saas/offboarding-agent-port';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asRole,
  seedBillingAccount,
  seedPlan,
  seedRateCard,
  seedSubscription,
} from '../helpers/saas';
import { urls } from '../helpers/stack';
import { nativeSovereignContext } from '../helpers/sovereign';

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

describe('M8 rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let su: pg.Client;
  let auth: pg.Client;
  let ctxA: TenantContext;
  let ctxB: TenantContext;

  const makeTenant = async (label: string) => {
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      label,
      `${label}-${userId}@example.invalid`,
    ]);
    const { organizationId } = await createOrganization(database.db, {
      userId,
      name: `${label} ${userId}`,
      commercialMode: 'cloud',
    });
    return resolveTenantContext(database.db, userId, organizationId);
  };

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    ctxA = await makeTenant('saas-a');
    ctxB = await makeTenant('saas-b');
  });

  afterAll(async () => {
    await auth.end();
    await su.end();
    await database.close();
  });

  it('forces RLS on every table in the new schemas', async () => {
    const { rows } = await su.query(
      `select n.nspname || '.' || c.relname as t
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p')
          and n.nspname in ('billing','lifecycle','support','operations')
          and not (c.relrowsecurity and c.relforcerowsecurity)`,
    );
    expect(rows).toEqual([]);
  });

  it('gives the three new roles no login and no special power', async () => {
    const { rows } = await su.query(
      `select rolname from pg_roles
        where rolname in ('ensemus_operator','ensemus_support','ensemus_eraser')
          and (rolcanlogin or rolsuper or rolcreaterole or rolbypassrls or rolcreatedb)`,
    );
    expect(rows).toEqual([]);
  });

  it('lets the support role reach the desk tables and nothing else (SEC-011)', async () => {
    const { rows } = await su.query<{ t: string }>(
      `select distinct table_schema || '.' || table_name as t
         from information_schema.role_table_grants
        where grantee = 'ensemus_support'
       union
       select distinct table_schema || '.' || table_name
         from information_schema.role_column_grants
        where grantee = 'ensemus_support'`,
    );
    expect(rows.filter((row) => !row.t.startsWith('support.'))).toEqual([]);
    await asRole('ensemus_support', async (client) => {
      await client.query('savepoint s');
      await expect(client.query('select * from work.work_units')).rejects.toThrow(
        /permission denied/,
      );
      await client.query('rollback to savepoint s');
      await expect(client.query('select * from integrations.connections')).rejects.toThrow(
        /permission denied/,
      );
      await client.query('rollback to savepoint s');
      await expect(client.query('select * from secrets.sealed_secrets')).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it('lets the operator read numbers across tenants, and not names, contacts or work', async () => {
    await asRole('ensemus_operator', async (client) => {
      await client.query('select id, commercial_mode, lifecycle from org.organizations');
      await client.query('savepoint s');
      await expect(client.query('select name from org.organizations')).rejects.toThrow(
        /permission denied/,
      );
      await client.query('rollback to savepoint s');
      await expect(client.query('select * from billing.billing_accounts')).rejects.toThrow(
        /permission denied/,
      );
      await client.query('rollback to savepoint s');
      await expect(client.query('select bill_to from billing.invoices')).rejects.toThrow(
        /permission denied/,
      );
      await client.query('rollback to savepoint s');
      await expect(client.query('select * from work.work_units')).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it('never lets the eraser read what it removes, and only while erasure is open', async () => {
    await asRole(
      'ensemus_eraser',
      async (client) => {
        await client.query('savepoint s');
        await expect(client.query('select title from work.work_units')).rejects.toThrow(
          /permission denied/,
        );
        await client.query('rollback to savepoint s');
        const { rows } = await client.query<{ n: number }>(
          'select count(*)::int as n from work.work_units',
        );
        expect(rows[0]!.n).toBe(0);
        const removed = await client.query('delete from work.clients');
        expect(removed.rowCount).toBe(0);
      },
      { organizationId: ctxA.organizationId },
    );
  });

  it('shows a tenant its own billing and none of another tenant', async () => {
    const account = await seedBillingAccount(database.db, ctxA);
    const seen = await withTenantTx(database.db, ctxB, (tx) =>
      tx.execute(sql`select id from billing.billing_accounts where id = ${account.id}`),
    );
    expect(seen.rows).toEqual([]);
  });

  it('hides a draft price, and never lets an approved one change', async () => {
    const draft = await seedRateCard({ approve: false });
    const seen = await withTenantTx(database.db, ctxA, (tx) =>
      tx.execute(sql`select id from billing.rate_cards where id = ${draft.rateCardId}`),
    );
    expect(seen.rows).toEqual([]);

    const approved = await seedRateCard();
    await expect(
      asRole('ensemus_operator', (client) =>
        client.query(
          `update billing.rate_card_lines set microcredits_per_unit = 1 where rate_card_id = $1`,
          [approved.rateCardId],
        ),
      ),
    ).rejects.toMatchObject({ code: 'EN801' });
    await expect(
      asRole('ensemus_operator', (client) =>
        client.query(`update billing.rate_cards set status = 'draft' where id = $1`, [
          approved.rateCardId,
        ]),
      ),
    ).rejects.toMatchObject({ code: 'EN801' });
  });

  it('refuses to approve a Cloud plan without a card, or a BYOM plan with one (QA-027)', async () => {
    const draftCard = await seedRateCard({ approve: false });
    await expect(seedPlan({ mode: 'cloud', rateCard: draftCard })).rejects.toMatchObject({
      code: 'EN801',
    });
    const card = await seedRateCard();
    const byom = await seedPlan({ mode: 'byom', approve: false });
    await expect(
      asRole('ensemus_operator', (client) =>
        client.query(
          `update billing.plan_versions
              set rate_card_id = $2, status = 'approved', approved_by = 'x', approved_at = now()
            where id = $1`,
          [byom.planVersionId, card.rateCardId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('refuses to open an invoice without an approved card, a tax decision, or lines that add up', async () => {
    const card = await seedRateCard();
    const plan = await seedPlan({ mode: 'cloud', rateCard: card });
    const subscription = await seedSubscription(database.db, ctxB, plan);
    const period = await withTenantTx(database.db, ctxB, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into billing.billing_periods
          (organization_id, subscription_id, plan_version_id, starts_at, ends_at)
        values (${ctxB.organizationId}, ${subscription.id}, ${plan.planVersionId},
                now() - interval '40 days', now() - interval '10 days')
        returning id`),
    );
    const invoiceId = randomUUID();
    await withTenantTx(database.db, ctxB, (tx) =>
      tx.insert(invoices).values({
        organizationId: ctxB.organizationId,
        id: invoiceId,
        kind: 'subscription',
        currency: card.currency,
        subscriptionId: subscription.id,
        billingPeriodId: period.rows[0]!.id,
        planVersionId: plan.planVersionId,
        totalMicros: 5000n,
        subtotalMicros: 5000n,
      }),
    );
    await expect(
      withTenantTx(database.db, ctxB, (tx) =>
        tx.update(invoices).set({ status: 'open' }).where(eq(invoices.id, invoiceId)),
      ),
    ).rejects.toEqual(sqlState('EN802'));
    await withTenantTx(database.db, ctxB, (tx) =>
      tx.insert(invoiceLines).values({
        organizationId: ctxB.organizationId,
        invoiceId,
        lineNo: 1,
        kind: 'usage',
        amountMicros: 4000n,
      }),
    );
    await expect(
      withTenantTx(database.db, ctxB, (tx) =>
        tx
          .update(invoices)
          .set({
            status: 'open',
            rateCardId: card.rateCardId,
            invoiceNumber: 1,
            issuedAt: new Date(),
            dueAt: new Date(),
            billTo: {},
          })
          .where(eq(invoices.id, invoiceId)),
      ),
    ).rejects.toThrow();
  });

  it('refuses a second payment attempt while the first could have charged', async () => {
    const card = await seedRateCard();
    const plan = await seedPlan({ mode: 'cloud', rateCard: card });
    const tenant = await makeTenant('saas-pay');
    const subscription = await seedSubscription(database.db, tenant, plan);
    const treatment = await asRole('ensemus_operator', async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into billing.tax_treatments (country_code, version, treatment, adviser_ref, drafted_by)
         values ('XP', floor(random() * 1000000)::int + 1, 'not_collected', 'test', 'test') returning id`,
      );
      await client.query(
        `update billing.tax_treatments set status = 'approved', approved_by = 'test', approved_at = now()
          where id = $1`,
        [rows[0]!.id],
      );
      return rows[0]!.id;
    });
    const invoiceId = randomUUID();
    const period = await withTenantTx(database.db, tenant, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into billing.billing_periods
          (organization_id, subscription_id, plan_version_id, starts_at, ends_at)
        values (${tenant.organizationId}, ${subscription.id}, ${plan.planVersionId},
                now() - interval '40 days', now() - interval '10 days')
        returning id`),
    );
    await withTenantTx(database.db, tenant, async (tx) => {
      await tx.insert(invoices).values({
        organizationId: tenant.organizationId,
        id: invoiceId,
        kind: 'subscription',
        currency: card.currency,
        subscriptionId: subscription.id,
        billingPeriodId: period.rows[0]!.id,
        planVersionId: plan.planVersionId,
        rateCardId: card.rateCardId,
        subtotalMicros: 5000n,
        totalMicros: 5000n,
      });
      await tx.insert(invoiceLines).values({
        organizationId: tenant.organizationId,
        invoiceId,
        lineNo: 1,
        kind: 'platform_fee',
        amountMicros: 5000n,
      });
      await tx
        .update(invoices)
        .set({
          status: 'open',
          taxTreatmentId: treatment,
          invoiceNumber: 1,
          issuedAt: new Date(),
          dueAt: new Date(),
          billTo: {},
        })
        .where(eq(invoices.id, invoiceId));
    });
    const paymentId = randomUUID();
    await withTenantTx(database.db, tenant, (tx) =>
      tx.insert(payments).values({
        organizationId: tenant.organizationId,
        id: paymentId,
        invoiceId,
        amountMicros: 5000n,
        currency: card.currency,
        idempotencyKey: `test-${paymentId}`,
        processor: 'test_processor',
        requestedByRef: 'test',
      }),
    );
    await withTenantTx(database.db, tenant, (tx) =>
      tx.insert(paymentAttempts).values({
        organizationId: tenant.organizationId,
        paymentId,
        attemptNo: 1,
        idempotencyKey: `test-${paymentId}`,
        runId: 'test-run',
      }),
    );
    await expect(
      withTenantTx(database.db, tenant, (tx) =>
        tx.insert(paymentAttempts).values({
          organizationId: tenant.organizationId,
          paymentId,
          attemptNo: 2,
          idempotencyKey: `test-${paymentId}`,
          runId: 'test-run-2',
        }),
      ),
    ).rejects.toEqual(sqlState('EN803'));
    await expect(
      withTenantTx(database.db, tenant, (tx) =>
        tx.update(payments).set({ status: 'succeeded' }).where(eq(payments.id, paymentId)),
      ),
    ).rejects.toEqual(sqlState('EN803'));
    await expect(
      withTenantTx(database.db, tenant, (tx) =>
        tx.insert(payments).values({
          organizationId: tenant.organizationId,
          invoiceId,
          amountMicros: 1n,
          currency: card.currency,
          idempotencyKey: `test-other-${paymentId}`,
          processor: 'test_processor',
          requestedByRef: 'test',
        }),
      ),
    ).rejects.toEqual(sqlState('EN803'));
  });

  it('keeps the balance what the ledger adds up to, and credits no unpaid top-up', async () => {
    const tenant = await makeTenant('saas-credit');
    await withTenantTx(database.db, tenant, (tx) =>
      tx.insert(creditLedger).values({
        organizationId: tenant.organizationId,
        idempotencyKey: 'allocation:one',
        kind: 'allocation',
        amountMicrocredits: 700n,
      }),
    );
    await withTenantTx(database.db, tenant, (tx) =>
      tx.insert(creditLedger).values({
        organizationId: tenant.organizationId,
        idempotencyKey: 'usage:one',
        kind: 'consumption',
        amountMicrocredits: -900n,
      }),
    );
    const [account] = await withTenantTx(database.db, tenant, (tx) =>
      tx.select().from(creditAccounts),
    );
    expect(account?.balanceMicrocredits).toBe(-200n);
    await expect(
      withTenantTx(database.db, tenant, (tx) =>
        tx.update(creditLedger).set({ amountMicrocredits: 1n }),
      ),
    ).rejects.toThrow();
  });

  it('makes a legal hold stop a deletion, below the application (LIFE-03)', async () => {
    const tenant = await makeTenant('saas-hold');
    const holdId = randomUUID();
    await withTenantTx(database.db, tenant, async (tx) => {
      await tx.insert(legalHolds).values({
        organizationId: tenant.organizationId,
        id: holdId,
        matterRef: 'TEST-1',
        placedByMembershipId: tenant.membershipId,
      });
      await tx.insert(legalHoldScopes).values({
        organizationId: tenant.organizationId,
        holdId,
        scopeType: 'organization',
      });
    });
    const write = () =>
      withTenantTx(database.db, tenant, (tx) =>
        tx.insert(tombstones).values({
          organizationId: tenant.organizationId,
          targetType: 'artifact',
          targetId: randomUUID(),
          reasonCode: 'USER_DELETED',
        }),
      );
    await expect(write()).rejects.toEqual(sqlState('EN804'));
    // A deletion that came before the hold is a past fact, and a restore can still re-apply it.
    await withTenantTx(database.db, tenant, (tx) =>
      tx.insert(tombstones).values({
        organizationId: tenant.organizationId,
        targetType: 'artifact',
        targetId: randomUUID(),
        reasonCode: 'USER_DELETED',
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    );
    await withTenantTx(database.db, tenant, (tx) =>
      tx
        .update(legalHolds)
        .set({
          status: 'released',
          releasedByMembershipId: tenant.membershipId,
          releasedAt: new Date(),
          releaseReasonCode: 'TEST_DONE',
        })
        .where(eq(legalHolds.id, holdId)),
    );
    await write();
  });

  it('refuses to start erasing while a hold is active or the steps are not done (LIFE-04)', async () => {
    const person = await makeTenant('saas-off');
    const tenant = await nativeSovereignContext(database.db, person.userId, person.organizationId);
    const { offboardingId } = await requestOffboarding(
      database.db,
      tenant,
      { confirmName: `saas-off ${tenant.userId}` },
      createOffboardingAgentHaltPort(),
    );
    await expect(
      withAccountTx(database.db, createServiceContext(tenant.organizationId), (tx) =>
        tx.update(offboardings).set({ state: 'erasing' }).where(eq(offboardings.id, offboardingId)),
      ),
    ).rejects.toEqual(sqlState('EN805'));
  });

  it('refuses a standing change with no record beside it', async () => {
    await expect(
      withTenantTx(database.db, ctxB, (tx) =>
        tx.execute(sql`update org.organizations set lifecycle = 'suspended'`),
      ),
    ).rejects.toEqual(sqlState('EN807'));
  });

  it('makes writes in a tenant that is not served in full fail in PostgreSQL itself', async () => {
    const tenant = await makeTenant('saas-ro');
    await withTenantTx(database.db, tenant, async (tx) => {
      await tx.execute(sql`
        insert into billing.standing_changes
          (organization_id, from_lifecycle, to_lifecycle, reason_code, actor_type, actor_ref)
        values (${tenant.organizationId}, 'active', 'read_only', 'TEST', 'system', 'test')`);
      await tx.execute(sql`update org.organizations set lifecycle = 'read_only'`);
    });
    const context = await resolveTenantContext(database.db, tenant.userId, tenant.organizationId);
    expect(context.serving).toBe('read_only');
    await expect(
      withTenantTx(database.db, context, (tx) =>
        tx.execute(sql`insert into support.tickets
          (organization_id, subject, category, opened_by_membership_id)
          values (${tenant.organizationId}, 'x', 'other', ${tenant.membershipId})`),
      ),
    ).rejects.toEqual(sqlState('25006'));
    await withTenantTx(database.db, context, (tx) => tx.execute(sql`select 1`));
  });

  it('needs two different people and a time limit before a break-glass request is authorized', async () => {
    const ticketId = randomUUID();
    const requestId = randomUUID();
    await asRole('ensemus_support', (client) =>
      client.query(
        `insert into support.break_glass_requests
           (organization_id, id, ticket_id, requested_by, reason_code, scope_type, scope_id, requested_minutes)
         values ($1, $2, $3, 'agent@example.invalid', 'TEST', 'work_unit', $4, 15)`,
        [ctxA.organizationId, requestId, ticketId, randomUUID()],
      ),
    );
    await expect(
      asRole('ensemus_operator', (client) =>
        client.query(
          `update support.break_glass_requests
              set operator_authorizer = 'agent@example.invalid', operator_authorized_at = now()
            where id = $1`,
          [requestId],
        ),
      ),
    ).rejects.toThrow(/break_glass_requests_two_people/);
    await expect(
      withTenantTx(database.db, ctxA, (tx) =>
        tx.execute(sql`update support.break_glass_requests set state = 'authorized',
                         customer_authorizer_membership_id = ${ctxA.membershipId},
                         customer_authorized_at = now(), authorized_from = now(),
                         expires_at = now() + interval '1 hour'
                       where id = ${requestId}`),
      ),
    ).rejects.toThrow();
  });

  it('shows the application role published incidents only, and no drill', async () => {
    const hidden = await asRole('ensemus_operator', async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into operations.incidents
           (severity, origin, public_title, commander_ref, started_at, is_drill)
         values ('medium', 'ensemus', 'A drill', 'test', now(), true) returning id`,
      );
      return rows[0]!.id;
    });
    const seen = await database.db.run((tx) =>
      tx.execute(sql`select id from operations.incidents where id = ${hidden}`),
    );
    expect(seen.rows).toEqual([]);
    await expect(
      database.db.run((tx) => tx.execute(sql`select * from operations.vulnerability_reports`)),
    ).rejects.toThrow();
  });
});
