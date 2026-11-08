// BILL-04: actual application/operator roles, catalog publication and exact provider reconciliation.
// Requires the integrator's stitched M8 migrations. Written here; never starts a container itself.
import { randomUUID } from 'node:crypto';
import {
  createOrganization,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import {
  listAvailablePlans,
  listTopUpOffers,
  loadPlanTerms,
  requirePublishedRateCard,
} from '@ensemus/application/saas/catalog';
import {
  approvePlanVersion,
  approveRateCard,
  draftPlanVersion,
  draftRateCard,
  enterProviderBill,
  publishCollectionPolicy,
  publishTaxTreatment,
  reconcileProviderBill,
} from '@ensemus/application/saas/operator-catalog';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../../packages/database/src/schema';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBillingAccount, seedSubscription, TEST_OPERATOR, testAmount } from '../helpers/saas';
import { urls } from '../helpers/stack';

const code = () => `test-${randomUUID()}`;
const errorCode = (value: string) => expect.objectContaining({ code: value });

describe('catalog and publication through real roles', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let pool: pg.Pool;
  let operator: ReturnType<typeof drizzle<typeof schema>>;
  let cloud: TenantContext;
  let other: TenantContext;
  let byom: TenantContext;
  let member: TenantContext;

  async function tenant(mode: 'cloud' | 'byom', label: string) {
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      label,
      `${userId}@example.invalid`,
    ]);
    const { organizationId } = await createOrganization(database.db, {
      userId,
      name: `Catalog ${label}`,
      commercialMode: mode,
    });
    return resolveTenantContext(database.db, userId, organizationId);
  }

  const cardInput = () => ({
    operatorRef: TEST_OPERATOR,
    code: code(),
    currency: 'XTS',
    minorUnitExponent: 2,
    lines: [{ meter: 'test.units', unit: 'unit', microcreditsPerUnit: testAmount() }],
    topUpOffers: [{ code: 'test', microcredits: testAmount(), priceMicros: testAmount() }],
  });

  async function publishedCard() {
    const input = cardInput();
    const made = await draftRateCard(operator, input);
    await approveRateCard(operator, {
      operatorRef: TEST_OPERATOR,
      rateCardId: made.rateCardId,
      effectiveFrom: new Date(Date.now() - 1_000),
    });
    return { ...made, input };
  }

  async function publishedPlan(mode: 'cloud' | 'byom', rateCardId: string | null) {
    const input = {
      operatorRef: TEST_OPERATOR,
      planCode: code(),
      displayName: 'A test plan',
      commercialMode: mode,
      currency: 'XTS',
      billingInterval: 'month' as const,
      paymentTermsDays: 0,
      minorUnitExponent: 2,
      platformFeeMicros: testAmount(),
      includedMicrocredits: mode === 'cloud' ? testAmount() : null,
      rateCardId,
      overagePolicy: mode === 'cloud' ? ('explicit_top_up' as const) : null,
      features: ['work'],
      maxActiveMembers: null,
    };
    const made = await draftPlanVersion(operator, input);
    await approvePlanVersion(operator, {
      operatorRef: TEST_OPERATOR,
      planVersionId: made.planVersionId,
    });
    const identity = await pool.query<{ plan_id: string }>(
      'select plan_id from billing.plan_versions where id = $1',
      [made.planVersionId],
    );
    return {
      ...made,
      input,
      planId: identity.rows[0]!.plan_id,
      platformFeeMicros: input.platformFeeMicros,
      includedMicrocredits: input.includedMicrocredits,
    };
  }

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    // Every connection, including transaction checkouts, keeps the restricted operator role.
    pool = new pg.Pool({
      connectionString: urls.superuser(),
      options: '-c role=ensemus_operator',
      max: 4,
    });
    operator = drizzle(pool, { schema, casing: 'snake_case' });
    cloud = await tenant('cloud', 'cloud');
    other = await tenant('cloud', 'other');
    byom = await tenant('byom', 'byom');
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'Member',
      `${userId}@example.invalid`,
    ]);
    await withTenantTx(database.db, cloud, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: cloud.organizationId, userId, role: 'member' }),
    );
    member = await resolveTenantContext(database.db, userId, cloud.organizationId);
  });

  afterAll(async () => {
    await pool?.end();
    await auth?.end();
    await database?.close();
  });

  it('refuses a member before reading billing data', async () => {
    await expect(listAvailablePlans(database.db, member)).rejects.toEqual(errorCode('NOT_FOUND'));
    await expect(listTopUpOffers(database.db, member)).rejects.toEqual(errorCode('NOT_FOUND'));
  });

  it('gives the application role no catalog write authority', async () => {
    await expect(
      withTenantTx(database.db, cloud, (tx) =>
        tx.execute(
          sql`insert into billing.rate_cards (code, version, currency, minor_unit_exponent, drafted_by) values (${code()}, 1, 'XTS', 2, 'test')`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('hides draft cards and plans from a tenant and refuses empty approval', async () => {
    const draft = await draftRateCard(operator, { ...cardInput(), lines: [], topUpOffers: [] });
    await expect(
      withTenantTx(database.db, cloud, (tx) => requirePublishedRateCard(tx, draft.rateCardId)),
    ).rejects.toEqual(errorCode('RATE_CARD_NOT_APPROVED'));
    await expect(
      approveRateCard(operator, {
        operatorRef: TEST_OPERATOR,
        rateCardId: draft.rateCardId,
        effectiveFrom: new Date(),
      }),
    ).rejects.toEqual(errorCode('RATE_CARD_NOT_APPROVED'));
    const plan = await draftPlanVersion(operator, {
      operatorRef: TEST_OPERATOR,
      planCode: code(),
      displayName: 'Draft',
      commercialMode: 'byom',
      currency: 'XTS',
      billingInterval: 'year',
      paymentTermsDays: 0,
      minorUnitExponent: 2,
      platformFeeMicros: testAmount(),
      includedMicrocredits: null,
      rateCardId: null,
      overagePolicy: null,
      features: [],
      maxActiveMembers: null,
    });
    expect(
      await withTenantTx(database.db, byom, (tx) => loadPlanTerms(tx, plan.planVersionId)),
    ).toBeNull();
    expect(
      (await listAvailablePlans(database.db, byom)).some(
        (row) => row.planVersionId === plan.planVersionId,
      ),
    ).toBe(false);
  });

  it('serializes concurrent versions of one immutable plan without UPDATE authority', async () => {
    const input = {
      operatorRef: TEST_OPERATOR,
      planCode: code(),
      displayName: 'Concurrent immutable plan',
      commercialMode: 'byom' as const,
      currency: 'XTS',
      billingInterval: 'month' as const,
      paymentTermsDays: 0,
      minorUnitExponent: 2,
      platformFeeMicros: testAmount(),
      includedMicrocredits: null,
      rateCardId: null,
      overagePolicy: null,
      features: ['work'],
      maxActiveMembers: null,
    };
    const versions = await Promise.all([
      draftPlanVersion(operator, input),
      draftPlanVersion(operator, input),
    ]);
    expect(versions.map((row) => row.version).sort()).toEqual([1, 2]);
    expect(new Set(versions.map((row) => row.planVersionId)).size).toBe(2);
    expect(
      (await pool.query('select code from billing.plans where code=$1', [input.planCode])).rows,
    ).toEqual([{ code: input.planCode }]);
    await expect(
      pool.query('update billing.plans set display_name=$1 where code=$2', [
        'Changed',
        input.planCode,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps approved prices immutable and permits historical reads after retirement', async () => {
    const first = await publishedCard();
    const second = await draftRateCard(operator, first.input);
    expect(second.version).toBe(first.version + 1);
    await approveRateCard(operator, {
      operatorRef: TEST_OPERATOR,
      rateCardId: second.rateCardId,
      effectiveFrom: new Date(),
    });
    const old = await withTenantTx(database.db, cloud, (tx) =>
      requirePublishedRateCard(tx, first.rateCardId),
    );
    expect(old.status).toBe('retired');
    expect(old.lines).toEqual(first.input.lines);
    await expect(
      pool.query('update billing.rate_cards set status = $1 where id = $2', [
        'draft',
        second.rateCardId,
      ]),
    ).rejects.toMatchObject({ code: 'EN801' });
    await expect(
      pool.query('delete from billing.rate_card_lines where rate_card_id = $1', [
        second.rateCardId,
      ]),
    ).rejects.toMatchObject({ code: 'EN801' });
  });

  it('lets one concurrent approval win and records one approval audit', async () => {
    const draft = await draftRateCard(operator, cardInput());
    const input = {
      operatorRef: TEST_OPERATOR,
      rateCardId: draft.rateCardId,
      effectiveFrom: new Date(),
    };
    const results = await Promise.allSettled([
      approveRateCard(operator, input),
      approveRateCard(operator, input),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const audits = await pool.query(
      'select action from billing.operator_actions where target_ref = $1',
      [`rate_card:${draft.rateCardId}`],
    );
    expect(audits.rows.filter((row) => row.action === 'catalog.rate_card.approved')).toHaveLength(
      1,
    );
  });

  it('refuses a Cloud plan tied to a draft card or a different currency', async () => {
    const draft = await draftRateCard(operator, cardInput());
    const make = (rateCardId: string, currency: string) =>
      draftPlanVersion(operator, {
        operatorRef: TEST_OPERATOR,
        planCode: code(),
        displayName: 'Test',
        commercialMode: 'cloud',
        currency,
        billingInterval: 'month',
        paymentTermsDays: 0,
        minorUnitExponent: 2,
        platformFeeMicros: testAmount(),
        includedMicrocredits: testAmount(),
        rateCardId,
        overagePolicy: 'pause',
        features: [],
        maxActiveMembers: null,
      });
    const unpriced = await make(draft.rateCardId, 'XTS');
    await expect(
      approvePlanVersion(operator, {
        operatorRef: TEST_OPERATOR,
        planVersionId: unpriced.planVersionId,
      }),
    ).rejects.toEqual(errorCode('RATE_CARD_NOT_APPROVED'));
    const card = await publishedCard();
    const foreignCurrency = await make(card.rateCardId, 'XXX');
    await expect(
      approvePlanVersion(operator, {
        operatorRef: TEST_OPERATOR,
        planVersionId: foreignCurrency.planVersionId,
      }),
    ).rejects.toEqual(errorCode('RATE_CARD_NOT_APPROVED'));
  });

  it('shows approved mode-matched plans and only this tenant’s quoted offers', async () => {
    const cardA = await publishedCard();
    const cardB = await publishedCard();
    const planA = await publishedPlan('cloud', cardA.rateCardId);
    const planB = await publishedPlan('cloud', cardB.rateCardId);
    const ownKey = await publishedPlan('byom', null);
    expect(
      (await listAvailablePlans(database.db, cloud)).some(
        (row) => row.planVersionId === ownKey.planVersionId,
      ),
    ).toBe(false);
    expect(
      (await listAvailablePlans(database.db, byom)).some(
        (row) => row.planVersionId === ownKey.planVersionId,
      ),
    ).toBe(true);
    for (const [context, plan] of [
      [cloud, planA],
      [other, planB],
    ] as const) {
      await seedBillingAccount(database.db, context);
      await seedSubscription(database.db, context, plan);
    }
    const offers = await listTopUpOffers(database.db, cloud);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      rateCardId: cardA.rateCardId,
      currency: 'XTS',
      microcredits: cardA.input.topUpOffers[0]!.microcredits,
      priceMicros: cardA.input.topUpOffers[0]!.priceMicros,
    });
    expect(offers.some((offer) => offer.rateCardId === cardB.rateCardId)).toBe(false);
    expect(await listTopUpOffers(database.db, byom)).toEqual([]);
  });

  it('validates collection steps and publishes versioned tax guidance with its basis', async () => {
    await expect(
      publishCollectionPolicy(operator, {
        operatorRef: TEST_OPERATOR,
        termsRef: 'test-terms',
        steps: [{ afterDays: -1, action: 'suspend' }],
      }),
    ).rejects.toEqual(errorCode('INVALID_INPUT'));
    const policy = await publishCollectionPolicy(operator, {
      operatorRef: TEST_OPERATOR,
      termsRef: 'test-terms',
      steps: [{ afterDays: 0, action: 'notify' }],
    });
    const tax = await publishTaxTreatment(operator, {
      operatorRef: TEST_OPERATOR,
      countryCode: 'XX',
      regionCode: code().slice(0, 8).toUpperCase(),
      treatment: 'not_collected',
      adviserRef: 'test-adviser',
    });
    expect(policy.version).toBeGreaterThan(0);
    expect(tax.version).toBeGreaterThan(0);
    for (const target of [
      `collection_policy:${policy.policyId}`,
      `tax_treatment:${tax.treatmentId}`,
    ]) {
      expect(
        (
          await pool.query(
            'select operator_ref from billing.operator_actions where target_ref = $1',
            [target],
          )
        ).rows,
      ).toEqual([{ operator_ref: TEST_OPERATOR }]);
    }
  });

  it('reports exact provider differences without deciding from a tolerance', async () => {
    const amount = testAmount();
    const ledgerCost = amount + 1n;
    const from = new Date('2033-01-01T00:00:00Z');
    const to = new Date('2033-02-01T00:00:00Z');
    const bill = await enterProviderBill(operator, {
      operatorRef: TEST_OPERATOR,
      providerKind: 'test_provider',
      periodStart: from,
      periodEnd: to,
      currency: 'XTS',
      amountMicros: amount,
      sourceRef: 'test-invoice',
    });
    const reader = {
      sumProviderCost: async (input: { providerKind: string; from: Date; to: Date }) => {
        expect(input).toEqual({ providerKind: 'test_provider', from, to });
        return ledgerCost;
      },
    };
    expect(
      await reconcileProviderBill(
        operator,
        { operatorRef: TEST_OPERATOR, ...bill, decision: null },
        reader,
      ),
    ).toEqual({ ledgerCostMicros: ledgerCost, differenceMicros: amount - ledgerCost });
    expect(
      (
        await pool.query('select status from billing.provider_bills where id = $1', [
          bill.providerBillId,
        ])
      ).rows[0]?.status,
    ).toBe('open');
    await reconcileProviderBill(
      operator,
      { operatorRef: TEST_OPERATOR, ...bill, decision: 'reconciled' },
      reader,
    );
    expect(
      (
        await pool.query('select status, reviewed_by from billing.provider_bills where id = $1', [
          bill.providerBillId,
        ])
      ).rows[0],
    ).toEqual({ status: 'reconciled', reviewed_by: TEST_OPERATOR });
    await reconcileProviderBill(
      operator,
      { operatorRef: TEST_OPERATOR, ...bill, decision: null },
      { sumProviderCost: async () => ledgerCost + 1n },
    );
    expect(
      (
        await pool.query('select status, reviewed_by from billing.provider_bills where id = $1', [
          bill.providerBillId,
        ])
      ).rows[0],
    ).toEqual({ status: 'open', reviewed_by: null });
  });

  it('does not let an older comparison overwrite a decision made while the ledger was being read', async () => {
    const amount = testAmount();
    const bill = await enterProviderBill(operator, {
      operatorRef: TEST_OPERATOR,
      providerKind: 'test_provider',
      periodStart: new Date('2034-01-01T00:00:00Z'),
      periodEnd: new Date('2034-02-01T00:00:00Z'),
      currency: 'XTS',
      amountMicros: amount,
      sourceRef: 'test-comparison-race',
    });
    let started!: () => void;
    let resume!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const continued = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const old = reconcileProviderBill(
      operator,
      { operatorRef: TEST_OPERATOR, ...bill, decision: null },
      {
        sumProviderCost: async () => {
          started();
          await continued;
          return amount;
        },
      },
    );
    await reading;
    await reconcileProviderBill(
      operator,
      { operatorRef: TEST_OPERATOR, ...bill, decision: 'disputed' },
      { sumProviderCost: async () => amount + 1n },
    );
    const refused = expect(old).rejects.toEqual(errorCode('VERSION_CONFLICT'));
    resume();
    await refused;
    expect(
      (
        await pool.query('select status from billing.provider_bills where id = $1', [
          bill.providerBillId,
        ])
      ).rows[0]?.status,
    ).toBe('disputed');
  });
});
