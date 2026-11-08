// Owned by the catalog slice (BILL-04). See docs/06-delivery/m8-slices.md and ADR-032 D2.
import {
  organizations,
  plans,
  planVersions,
  rateCardLines,
  billingRateCards,
  subscriptions,
  topUpOffers,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { can } from '@ensemus/domain/policy';
import type { PlanTerms, RateCardFacts } from '@ensemus/saas/catalog';
import type { TopUpQuote } from '@ensemus/saas/credits';
import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';

function requireBillingView(context: TenantContext) {
  if (context.actorType !== 'user' || !can(context.role, 'billing.view')) {
    throw new AppError('NOT_FOUND');
  }
}

const TERMS = {
  planVersionId: planVersions.id,
  commercialMode: plans.commercialMode,
  status: planVersions.status,
  currency: planVersions.currency,
  billingInterval: planVersions.billingInterval,
  paymentTermsDays: planVersions.paymentTermsDays,
  minorUnitExponent: planVersions.minorUnitExponent,
  platformFeeMicros: planVersions.platformFeeMicros,
  includedMicrocredits: planVersions.includedMicrocredits,
  rateCardId: planVersions.rateCardId,
  overagePolicy: planVersions.overagePolicy,
  features: planVersions.features,
  maxActiveMembers: planVersions.maxActiveMembers,
};

type TermsRow = {
  [Key in keyof typeof TERMS]: unknown;
} & {
  commercialMode: string;
  status: string;
  billingInterval: string;
  overagePolicy: string | null;
};

// The SQL constraints hold these values. Refuse an unexpected row rather than asserting a wider plan.
function termsOf<Row extends TermsRow>(row: Row): Row & PlanTerms {
  if (
    (row.commercialMode !== 'cloud' && row.commercialMode !== 'byom') ||
    !['approved', 'retired'].includes(row.status) ||
    (row.billingInterval !== 'month' && row.billingInterval !== 'year') ||
    (row.overagePolicy !== null && !['pause', 'explicit_top_up'].includes(row.overagePolicy))
  ) {
    throw new AppError('PLAN_NOT_AVAILABLE');
  }
  return row as Row & PlanTerms;
}

/** Approved plan versions this tenant's mode could start on. Empty until the owner approves one. */
export async function listAvailablePlans(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly (PlanTerms & { planCode: string; displayName: string })[]> {
  requireBillingView(context);
  return withAccountTx(database, context, async (tx) => {
    const [organization] = await tx
      .select({ mode: organizations.commercialMode })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId));
    if (!organization) throw new AppError('NOT_FOUND');
    if (organization.mode === 'sovereign') return [];
    const rows = await tx
      .select({ ...TERMS, planCode: plans.code, displayName: plans.displayName })
      .from(planVersions)
      .innerJoin(plans, eq(plans.id, planVersions.planId))
      .where(
        and(
          eq(planVersions.status, 'approved'),
          isNotNull(planVersions.minorUnitExponent),
          eq(plans.commercialMode, organization.mode),
        ),
      )
      .orderBy(asc(plans.code), asc(planVersions.version));
    return rows.map(termsOf);
  });
}

/** One plan version's terms. Null for a draft or an unknown ID: to a tenant, a draft does not exist. */
export async function loadPlanTerms(tx: Tx, planVersionId: string): Promise<PlanTerms | null> {
  const id = idSchema.safeParse(planVersionId);
  if (!id.success) return null;
  const [row] = await tx
    .select(TERMS)
    .from(planVersions)
    .innerJoin(plans, eq(plans.id, planVersions.planId))
    .where(
      and(eq(planVersions.id, id.data), inArray(planVersions.status, ['approved', 'retired'])),
    );
  return row ? termsOf(row) : null;
}

/**
 * The card and its lines, or throws RATE_CARD_NOT_APPROVED. A retired card loads, because it still prices
 * the time it was in force. Everything that prices anything goes through here.
 */
export async function requirePublishedRateCard(tx: Tx, rateCardId: string): Promise<RateCardFacts> {
  const id = idSchema.safeParse(rateCardId);
  if (!id.success) throw new AppError('RATE_CARD_NOT_APPROVED');
  const [card] = await tx
    .select({
      id: billingRateCards.id,
      status: billingRateCards.status,
      currency: billingRateCards.currency,
      minorUnitExponent: billingRateCards.minorUnitExponent,
      effectiveFrom: billingRateCards.effectiveFrom,
    })
    .from(billingRateCards)
    .where(
      and(
        eq(billingRateCards.id, id.data),
        inArray(billingRateCards.status, ['approved', 'retired']),
      ),
    );
  if (!card || (card.status !== 'approved' && card.status !== 'retired')) {
    throw new AppError('RATE_CARD_NOT_APPROVED');
  }
  const lines = await tx
    .select({
      meter: rateCardLines.meter,
      unit: rateCardLines.unit,
      microcreditsPerUnit: rateCardLines.microcreditsPerUnit,
    })
    .from(rateCardLines)
    .where(eq(rateCardLines.rateCardId, card.id))
    .orderBy(asc(rateCardLines.meter));
  return { ...card, status: card.status, lines };
}

/** Offers on the plan's current card, each already quoted. Empty if its plan does not allow top-ups. */
export async function listTopUpOffers(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly TopUpQuote[]> {
  requireBillingView(context);
  return withAccountTx(database, context, (tx) =>
    tx
      .select({
        offerId: topUpOffers.id,
        rateCardId: topUpOffers.rateCardId,
        microcredits: topUpOffers.microcredits,
        priceMicros: topUpOffers.priceMicros,
        currency: billingRateCards.currency,
      })
      .from(subscriptions)
      .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
      .innerJoin(plans, eq(plans.id, planVersions.planId))
      .innerJoin(billingRateCards, eq(billingRateCards.id, planVersions.rateCardId))
      .innerJoin(topUpOffers, eq(topUpOffers.rateCardId, billingRateCards.id))
      .where(
        and(
          eq(subscriptions.organizationId, context.organizationId),
          eq(subscriptions.status, 'active'),
          eq(organizations.lifecycle, 'active'),
          eq(plans.commercialMode, 'cloud'),
          eq(planVersions.overagePolicy, 'explicit_top_up'),
          inArray(planVersions.status, ['approved', 'retired']),
          inArray(billingRateCards.status, ['approved', 'retired']),
          lte(billingRateCards.effectiveFrom, new Date()),
        ),
      )
      .orderBy(asc(topUpOffers.code), asc(topUpOffers.id)),
  );
}
