import { randomUUID } from 'node:crypto';
import {
  createOrganization,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  getBillingOverview,
  saveBillingAccount,
  startSubscription,
  changePlan,
  requestCancellation,
  withdrawCancellation,
  advanceSubscriptionInTx,
} from '@ensemus/application/saas/subscriptions';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { seedPlan } from '../helpers/saas';
import { urls } from '../helpers/stack';

describe('subscriptions in the application role', () => {
  const db = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });
  let owner: TenantContext;
  let other: TenantContext;
  let member: TenantContext;
  const account = {
    billingName: 'Test account',
    billingEmail: 'billing@example.invalid',
    countryCode: 'XX',
    regionCode: '',
    postalCode: null,
    taxId: null,
  };
  async function tenant(mode: 'cloud' | 'byom' | 'sovereign' = 'byom') {
    const id = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values ($1,$2,$3)', [
      id,
      'Same name',
      `${id}@example.invalid`,
    ]);
    const made = await createOrganization(db.db, {
      userId: id,
      name: 'Same name',
      commercialMode: mode,
    });
    return resolveTenantContext(db.db, id, made.organizationId);
  }
  beforeAll(async () => {
    await auth.connect();
    owner = await tenant();
    other = await tenant();
    await withTenantTx(db.db, owner, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: owner.organizationId, userId: other.userId, role: 'member' }),
    );
    member = await resolveTenantContext(db.db, other.userId, owner.organizationId);
  });
  afterAll(async () => {
    await auth.end();
    await db.close();
  });
  it('denies member billing reads and writes as not found before touching data', async () => {
    for (const call of [
      () => getBillingOverview(db.db, member, { billingEnabled: true }),
      () => saveBillingAccount(db.db, member, { ...account, expectedVersion: null }),
      () => startSubscription(db.db, member, { planVersionId: randomUUID() }),
      () => requestCancellation(db.db, member, { expectedVersion: 1 }),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('account updates require the observed version and remain tenant isolated', async () => {
    await expect(
      saveBillingAccount(db.db, owner, { ...account, expectedVersion: null }),
    ).resolves.toEqual({ version: 1 });
    await expect(
      saveBillingAccount(db.db, owner, { ...account, expectedVersion: null }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      saveBillingAccount(db.db, owner, { ...account, expectedVersion: 1 }),
    ).resolves.toEqual({ version: 2 });
    expect((await getBillingOverview(db.db, other, { billingEnabled: true })).account).toBeNull();
  });
  it('refuses draft, wrong mode and Sovereign before creating a subscription', async () => {
    const draft = await seedPlan({ mode: 'byom', approve: false });
    await expect(startSubscription(db.db, owner, draft)).rejects.toMatchObject({
      code: 'PLAN_NOT_AVAILABLE',
    });
    const plan = await seedPlan({ mode: 'byom' });
    await expect(startSubscription(db.db, await tenant('cloud'), plan)).rejects.toMatchObject({
      code: 'PLAN_NOT_AVAILABLE',
    });
    await expect(startSubscription(db.db, await tenant('sovereign'), plan)).rejects.toMatchObject({
      code: 'BILLING_NOT_ENABLED',
    });
  });
  it('serializes starts and cancellation with optimistic versions; another tenant cannot advance it', async () => {
    const plan = await seedPlan({ mode: 'byom' });
    const attempts = await Promise.allSettled([
      startSubscription(db.db, owner, plan),
      startSubscription(db.db, owner, plan),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'SUBSCRIPTION_EXISTS' },
    });
    const overview = await getBillingOverview(db.db, owner, { billingEnabled: true });
    const sub = overview.subscription!;
    await expect(
      requestCancellation(db.db, owner, { expectedVersion: sub.version - 1 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await requestCancellation(db.db, owner, { expectedVersion: sub.version });
    await withdrawCancellation(db.db, owner, { expectedVersion: sub.version + 1 });
    await expect(
      withTenantTx(db.db, createServiceContext(other.organizationId), (tx) =>
        advanceSubscriptionInTx(tx, createServiceContext(other.organizationId), {
          subscriptionId: sub.id,
          now: sub.currentPeriodEnd,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const service = createServiceContext(owner.organizationId);
    await expect(
      withTenantTx(db.db, service, (tx) =>
        advanceSubscriptionInTx(tx, service, {
          subscriptionId: sub.id,
          now: sub.currentPeriodStart,
        }),
      ),
    ).resolves.toBe('not_due');
    await requestCancellation(db.db, owner, { expectedVersion: sub.version + 2 });
    await expect(
      withTenantTx(db.db, service, (tx) =>
        advanceSubscriptionInTx(tx, service, { subscriptionId: sub.id, now: sub.currentPeriodEnd }),
      ),
    ).resolves.toBe('canceled');
    await expect(
      withTenantTx(db.db, service, (tx) =>
        advanceSubscriptionInTx(tx, service, { subscriptionId: sub.id, now: sub.currentPeriodEnd }),
      ),
    ).resolves.toBe('not_due');
  });
  it('records deferred downgrade and keeps every membership', async () => {
    const who = await tenant();
    const original = await seedPlan({ mode: 'byom' });
    await startSubscription(db.db, who, original);
    await withTenantTx(db.db, who, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: who.organizationId, userId: other.userId, role: 'member' }),
    );
    const next = await seedPlan({ mode: 'byom', features: [], maxActiveMembers: 1 });
    const before = await withTenantTx(db.db, who, (tx) =>
      tx.execute(sql`select count(*)::int as n from org.memberships`),
    );
    expect(
      (await changePlan(db.db, who, { toPlanVersionId: next.planVersionId, expectedVersion: 1 }))
        .effective,
    ).toBe('period_end');
    expect(
      await withTenantTx(db.db, who, (tx) =>
        tx.execute(sql`select count(*)::int as n from org.memberships`),
      ),
    ).toMatchObject({ rows: before.rows });
    const pending = await getBillingOverview(db.db, who, { billingEnabled: true });
    expect(pending.scheduledPlanChange).toMatchObject({
      planVersionId: next.planVersionId,
      excess: { activeMembers: 1 },
    });
    const service = createServiceContext(who.organizationId);
    const input = {
      subscriptionId: pending.subscription!.id,
      now: pending.subscription!.currentPeriodEnd,
    };
    await expect(
      withTenantTx(db.db, service, (tx) => advanceSubscriptionInTx(tx, service, input)),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    expect(
      (await getBillingOverview(db.db, who, { billingEnabled: true })).subscription!
        .currentPeriodEnd,
    ).toEqual(input.now);
    const agents = {
      haltTenantAgents: async () => undefined,
      releaseTenantAgents: async () => undefined,
    };
    expect(
      await withTenantTx(db.db, service, (tx) =>
        advanceSubscriptionInTx(tx, service, input, agents),
      ),
    ).toBe('advanced');
    expect((await getBillingOverview(db.db, who, { billingEnabled: true })).lifecycle).toBe(
      'read_only',
    );
    expect(
      await withTenantTx(db.db, service, (tx) =>
        advanceSubscriptionInTx(tx, service, input, agents),
      ),
    ).toBe('not_due');
    const after = await withTenantTx(db.db, service, (tx) =>
      tx.execute(sql`select count(*)::int as n from org.memberships`),
    );
    expect(after.rows).toEqual(before.rows);
  });
});
