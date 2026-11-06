import { randomUUID } from 'node:crypto';
import {
  createOrganization,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createEntitlementChecker, getEntitlements } from '@ensemus/application/saas/entitlements';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { seedPlan, seedRateCard, seedSubscription } from '../helpers/saas';
import { urls } from '../helpers/stack';

describe('licensed access is isolated from billing administration', () => {
  const database = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });
  let owner: TenantContext;
  let member: TenantContext;
  let other: TenantContext;
  async function tenant(mode: 'cloud' | 'byom' = 'byom') {
    const userId = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values ($1,$2,$3)', [
      userId,
      'Same name',
      `${userId}@example.invalid`,
    ]);
    const row = await createOrganization(database.db, {
      userId,
      name: 'Same name',
      commercialMode: mode,
    });
    return resolveTenantContext(database.db, userId, row.organizationId);
  }
  beforeAll(async () => {
    await auth.connect();
    owner = await tenant();
    other = await tenant();
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: owner.organizationId, userId: other.userId, role: 'member' }),
    );
    member = await resolveTenantContext(database.db, other.userId, owner.organizationId);
    await seedSubscription(database.db, owner, await seedPlan({ mode: 'byom' }));
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  it('a member can read licensed features and BYOM has no platform model balance', async () => {
    expect(await getEntitlements(database.db, member, { billingEnabled: true })).toEqual({
      mode: 'byom',
      features: ['work'],
      capacity: { balanceMicrocredits: null, includedMicrocredits: null, maxActiveMembers: null },
    });
    expect((await getEntitlements(database.db, other, { billingEnabled: true })).features).toEqual(
      [],
    );
  });
  it('BYOM gateway calls are customer billed and unknown features refuse', async () => {
    const checker = createEntitlementChecker(database.db, true);
    expect(await checker.check(member, 'model.call')).toEqual({
      ok: true,
      commercialMode: 'byom',
      billable: false,
    });
    expect(await checker.check(member, 'unlicensed')).toEqual({
      ok: false,
      code: 'ENTITLEMENT_DENIED',
    });
    expect((await checker.decide(other, { kind: 'feature', feature: 'work' })).code).toBe(
      'NO_SUBSCRIPTION',
    );
  });
  it('disabled hosted billing refuses and does not invent a subscription', async () => {
    expect(await createEntitlementChecker(database.db, false).check(member, 'work')).toEqual({
      ok: false,
      code: 'ENTITLEMENT_DENIED',
    });
  });
  it('QA-026: a Cloud call at zero refuses without creating an invoice or a charge', async () => {
    const cloud = await tenant('cloud');
    await seedSubscription(
      database.db,
      cloud,
      await seedPlan({ mode: 'cloud', rateCard: await seedRateCard() }),
    );
    const checker = createEntitlementChecker(database.db, true);
    expect(
      await checker.decide(cloud, { kind: 'model_capacity', estimatedMicrocredits: 0n }),
    ).toEqual({ allowed: false, code: 'CREDITS_EXHAUSTED', remedy: 'top_up' });
    expect(await checker.check(cloud, 'model.call')).toEqual({
      ok: false,
      code: 'ENTITLEMENT_DENIED',
    });
    const rows = await withTenantTx(database.db, cloud, (tx) =>
      tx.execute(
        sql`select (select count(*)::int from billing.invoices) as invoices,(select count(*)::int from billing.payments) as payments`,
      ),
    );
    expect(rows.rows[0]).toEqual({ invoices: 0, payments: 0 });
  });
});
