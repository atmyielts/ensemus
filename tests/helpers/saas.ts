// Test seeds for ADR-032's tables, shared by every M8 slice. The price list goes in as `ensemus_operator`, by
// taking that role from the superuser connection, since the role cannot log in. Tenant rows go in as the
// application role, through the real triggers, so a seed can never reach a state the rules forbid. Every
// amount here is a random test value, so nothing can be mistaken for a price, and the codes say so.
import { randomInt, randomUUID } from 'node:crypto';
import { billingAccounts, subscriptions, withTenantTx } from '@ensemus/database';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import pg from 'pg';
import { urls } from './stack';

export type RoleName = 'ensemus_operator' | 'ensemus_support' | 'ensemus_eraser';

/** Runs `use` as a role that cannot log in, optionally with a tenant bound. It always rolls back on error. */
export async function asRole<T>(
  role: RoleName,
  use: (client: pg.Client) => Promise<T>,
  options: { organizationId?: string } = {},
): Promise<T> {
  const client = new pg.Client({ connectionString: urls.superuser() });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    if (options.organizationId) {
      await client.query(`select set_config('app.organization_id', $1, true)`, [
        options.organizationId,
      ]);
    }
    const result = await use(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export const testAmount = () => BigInt(randomInt(1_000, 1_000_000)) * 1_000n;
const testCode = (prefix: string) => `test-${prefix}-${randomUUID().slice(0, 8)}`;
export const TEST_OPERATOR = 'test-operator@example.invalid';

export type SeededRateCard = {
  rateCardId: string;
  currency: string;
  minorUnitExponent: number;
  meter: string;
  microcreditsPerUnit: bigint;
  topUpOfferId: string;
  topUpMicrocredits: bigint;
  topUpPriceMicros: bigint;
};

/** A rate card with one line and one offer. Pass `approve: false` for a draft, which nothing can bill from. */
export async function seedRateCard(
  options: { approve?: boolean; currency?: string; meter?: string } = {},
): Promise<SeededRateCard> {
  const currency = options.currency ?? 'XTS';
  const meter = options.meter ?? 'test.units';
  const microcreditsPerUnit = testAmount();
  const topUpMicrocredits = testAmount();
  const topUpPriceMicros = testAmount();
  return asRole('ensemus_operator', async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into billing.rate_cards (code, version, currency, minor_unit_exponent, drafted_by)
       values ($1, 1, $2, 2, $3) returning id`,
      [testCode('card'), currency, TEST_OPERATOR],
    );
    const rateCardId = rows[0]!.id;
    await client.query(
      `insert into billing.rate_card_lines (rate_card_id, meter, unit, microcredits_per_unit)
       values ($1, $2, 'unit', $3)`,
      [rateCardId, meter, microcreditsPerUnit.toString()],
    );
    const offer = await client.query<{ id: string }>(
      `insert into billing.top_up_offers (rate_card_id, code, microcredits, price_micros)
       values ($1, 'test', $2, $3) returning id`,
      [rateCardId, topUpMicrocredits.toString(), topUpPriceMicros.toString()],
    );
    if (options.approve !== false) {
      await client.query(
        `update billing.rate_cards
            set status = 'approved', approved_by = $2, approved_at = now(),
                effective_from = now() - interval '1 day'
          where id = $1`,
        [rateCardId, TEST_OPERATOR],
      );
    }
    return {
      rateCardId,
      currency,
      minorUnitExponent: 2,
      meter,
      microcreditsPerUnit,
      topUpOfferId: offer.rows[0]!.id,
      topUpMicrocredits,
      topUpPriceMicros,
    };
  });
}

export type SeededPlan = {
  planId: string;
  planVersionId: string;
  platformFeeMicros: bigint;
  includedMicrocredits: bigint | null;
};

/** An approved plan version. Cloud needs a card, and BYOM must not have one, as the database insists. */
export async function seedPlan(
  options:
    | {
        mode: 'cloud';
        rateCard: SeededRateCard;
        overagePolicy?: 'pause' | 'explicit_top_up';
        approve?: boolean;
      }
    | { mode: 'byom'; currency?: string; approve?: boolean },
): Promise<SeededPlan> {
  const platformFeeMicros = testAmount();
  const includedMicrocredits = options.mode === 'cloud' ? testAmount() : null;
  return asRole('ensemus_operator', async (client) => {
    const plan = await client.query<{ id: string }>(
      `insert into billing.plans (code, commercial_mode, display_name)
       values ($1, $2, 'A test plan') returning id`,
      [testCode('plan'), options.mode],
    );
    const planId = plan.rows[0]!.id;
    const version = await client.query<{ id: string }>(
      `insert into billing.plan_versions
         (plan_id, version, currency, billing_interval, payment_terms_days, platform_fee_micros,
          included_microcredits, rate_card_id, overage_policy, features, drafted_by)
       values ($1, 1, $2, 'month', 0, $3, $4, $5, $6, $7, $8) returning id`,
      [
        planId,
        options.mode === 'cloud' ? options.rateCard.currency : (options.currency ?? 'XTS'),
        platformFeeMicros.toString(),
        includedMicrocredits?.toString() ?? null,
        options.mode === 'cloud' ? options.rateCard.rateCardId : null,
        options.mode === 'cloud' ? (options.overagePolicy ?? 'explicit_top_up') : null,
        ['work'],
        TEST_OPERATOR,
      ],
    );
    const planVersionId = version.rows[0]!.id;
    if (options.approve !== false) {
      await client.query(
        `update billing.plan_versions set status = 'approved', approved_by = $2, approved_at = now()
          where id = $1`,
        [planVersionId, TEST_OPERATOR],
      );
    }
    return { planId, planVersionId, platformFeeMicros, includedMicrocredits };
  });
}

/** An approved set of steps, each of which a test names. */
export async function seedCollectionPolicy(
  steps: readonly { afterDays: number; action: string }[],
): Promise<string> {
  return asRole('ensemus_operator', async (client) => {
    const next = await client.query<{ n: number }>(
      `select coalesce(max(version), 0) + 1 as n from billing.collection_policies`,
    );
    const { rows } = await client.query<{ id: string }>(
      `insert into billing.collection_policies (version, terms_ref, steps, drafted_by)
       values ($1, 'test-terms', $2, $3) returning id`,
      [next.rows[0]!.n, JSON.stringify(steps), TEST_OPERATOR],
    );
    await client.query(
      `update billing.collection_policies set status = 'approved', approved_by = $2, approved_at = now()
        where id = $1`,
      [rows[0]!.id, TEST_OPERATOR],
    );
    return rows[0]!.id;
  });
}

/** What an adviser would say, for a test's made-up place. */
export async function seedTaxTreatment(
  options: {
    countryCode?: string;
    treatment?: 'provider_computed' | 'not_collected';
  } = {},
): Promise<{ treatmentId: string; countryCode: string }> {
  const countryCode = options.countryCode ?? 'XX';
  return asRole('ensemus_operator', async (client) => {
    const next = await client.query<{ n: number }>(
      `select coalesce(max(version), 0) + 1 as n from billing.tax_treatments
        where country_code = $1 and region_code = ''`,
      [countryCode],
    );
    const { rows } = await client.query<{ id: string }>(
      `insert into billing.tax_treatments (country_code, version, treatment, adviser_ref, drafted_by)
       values ($1, $2, $3, 'test-adviser', $4) returning id`,
      [countryCode, next.rows[0]!.n, options.treatment ?? 'not_collected', TEST_OPERATOR],
    );
    await client.query(
      `update billing.tax_treatments set status = 'approved', approved_by = $2, approved_at = now()
        where id = $1`,
      [rows[0]!.id, TEST_OPERATOR],
    );
    return { treatmentId: rows[0]!.id, countryCode };
  });
}

/** Who pays, for one tenant. Generated values, in a made-up place. */
export async function seedBillingAccount(
  database: AppDatabase,
  context: TenantContext,
  overrides: Partial<typeof billingAccounts.$inferInsert> = {},
) {
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .insert(billingAccounts)
      .values({
        organizationId: context.organizationId,
        billingName: 'A test customer',
        billingEmail: 'billing@example.invalid',
        countryCode: 'XX',
        ...overrides,
      })
      .returning();
    return row!;
  });
}

/** A live subscription on this plan, for slices that do not own starting one. */
export async function seedSubscription(
  database: AppDatabase,
  context: TenantContext,
  plan: SeededPlan,
  overrides: Partial<typeof subscriptions.$inferInsert> = {},
) {
  const now = new Date();
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .insert(subscriptions)
      .values({
        organizationId: context.organizationId,
        planVersionId: plan.planVersionId,
        currentPeriodStart: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
        createdByRef: 'test',
        ...overrides,
      })
      .returning();
    return row!;
  });
}
