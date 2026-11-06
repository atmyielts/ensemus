// Owned by the subscriptions slice (COMM-01, OPS-21). See docs/06-delivery/m8-slices.md and ADR-032 D5.
import {
  billingAccounts,
  billingPeriods,
  collectionPolicies,
  idempotencyKeys,
  memberships,
  organizations,
  subscriptionChanges,
  subscriptions,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { createServiceContext } from '@ensemus/database/service';
import { can } from '@ensemus/domain/policy';
import { canStartOn, periodEnd } from '@ensemus/saas/catalog';
import { planChangeEffect } from '@ensemus/saas/entitlements';
import {
  AGGREGATE_SUBSCRIPTION,
  SUBSCRIPTION_STARTED,
  SUBSCRIPTION_PLAN_CHANGED,
  SUBSCRIPTION_CANCEL_REQUESTED,
  SUBSCRIPTION_CANCELED,
} from '@ensemus/saas/events';
import { saveBillingAccountSchema } from '@ensemus/contracts/saas';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { emit } from '../events';
import { auditAction } from '../work';
import { requestHash } from '../idempotency';
import { idSchema } from '../ids';
import { loadPlanTerms, requirePublishedRateCard } from './catalog';
import { allocatePeriodCreditsInTx } from './credits';
import type { AgentHaltPort } from './ports';
import { setTenantStandingInTx } from './standing';

const requireBilling = (context: TenantContext, manage: boolean, service = false) => {
  if (service && context.actorType === 'service') return;
  if (
    context.actorType !== 'user' ||
    !can(context.role, manage ? 'billing.manage' : 'billing.view')
  )
    throw new AppError('NOT_FOUND');
};
const identifier = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const actorRef = (context: TenantContext) =>
  context.actorType === 'service' ? 'system:subscription' : context.membershipId;
const versionCheck = (actual: number, expected: number) => {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new AppError('INVALID_INPUT');
  if (actual !== expected) throw new AppError('VERSION_CONFLICT');
};
async function lockOrganization(tx: Tx, context: TenantContext) {
  const [org] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
  return org;
}
async function liveSubscription(tx: Tx, context: TenantContext) {
  const [sub] = await tx
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.organizationId, context.organizationId),
        ne(subscriptions.status, 'canceled'),
      ),
    )
    .for('update');
  if (!sub) throw new AppError('NO_SUBSCRIPTION');
  return sub;
}
async function memberCounts(tx: Tx, context: TenantContext) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(eq(memberships.organizationId, context.organizationId), eq(memberships.status, 'active')),
    );
  return { activeMembers: row!.n };
}
async function subscriptionEvent(
  tx: Tx,
  context: TenantContext,
  sub: { id: string; version: number },
  eventType: string,
) {
  await emit(tx, context, {
    eventType,
    aggregateType: AGGREGATE_SUBSCRIPTION,
    aggregateId: sub.id,
    aggregateVersion: sub.version,
    classification: 'internal',
    payload: { subscription_id: sub.id },
  });
}
async function openPeriod(
  tx: Tx,
  context: TenantContext,
  sub: typeof subscriptions.$inferSelect,
  plan: NonNullable<Awaited<ReturnType<typeof loadPlanTerms>>>,
) {
  const [period] = await tx
    .insert(billingPeriods)
    .values({
      organizationId: context.organizationId,
      subscriptionId: sub.id,
      planVersionId: plan.planVersionId,
      rateCardId: plan.rateCardId,
      startsAt: sub.currentPeriodStart,
      endsAt: sub.currentPeriodEnd,
    })
    .returning();
  if (plan.commercialMode === 'cloud') {
    if (plan.rateCardId === null || plan.includedMicrocredits === null)
      throw new AppError('RATE_CARD_NOT_APPROVED');
    await allocatePeriodCreditsInTx(tx, createServiceContext(context.organizationId), {
      billingPeriodId: period!.id,
      includedMicrocredits: plan.includedMicrocredits,
      rateCardId: plan.rateCardId,
    });
  }
}

export type BillingAccountInput = {
  billingName: string;
  billingEmail: string;
  countryCode: string;
  regionCode: string;
  postalCode: string | null;
  taxId: string | null;
};

export type BillingOverview = {
  lifecycle: string;
  billingEnabled: boolean;
  scheduledPlanChange: {
    planVersionId: string;
    effectiveAt: Date;
    excess: Readonly<Record<string, number>>;
  } | null;
  account: (BillingAccountInput & { version: number }) | null;
  subscription: {
    id: string;
    planVersionId: string;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    version: number;
  } | null;
};

/** `billing.view`. Works in any standing, since someone suspended still has to see why. */
export async function getBillingOverview(
  database: AppDatabase,
  context: TenantContext,
  options: { billingEnabled: boolean },
): Promise<BillingOverview> {
  requireBilling(context, false);
  return withAccountTx(database, context, async (tx) => {
    const [org] = await tx
      .select({ lifecycle: organizations.lifecycle })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId));
    if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
    const [account] = await tx
      .select({
        billingName: billingAccounts.billingName,
        billingEmail: billingAccounts.billingEmail,
        countryCode: billingAccounts.countryCode,
        regionCode: billingAccounts.regionCode,
        postalCode: billingAccounts.postalCode,
        taxId: billingAccounts.taxId,
        version: billingAccounts.version,
      })
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, context.organizationId));
    const [subscription] = await tx
      .select({
        id: subscriptions.id,
        planVersionId: subscriptions.planVersionId,
        status: subscriptions.status,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        version: subscriptions.version,
      })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, context.organizationId))
      .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
      .limit(1);
    const [change] = subscription
      ? await tx
          .select()
          .from(subscriptionChanges)
          .where(
            and(
              eq(subscriptionChanges.subscriptionId, subscription.id),
              eq(subscriptionChanges.kind, 'plan_changed'),
            ),
          )
          .orderBy(desc(subscriptionChanges.occurredAt), desc(subscriptionChanges.id))
          .limit(1)
      : [];
    const scheduledPlanChange =
      change?.toPlanVersionId &&
      subscription?.status !== 'canceled' &&
      change.toPlanVersionId !== subscription?.planVersionId &&
      change.effectiveAt >= subscription!.currentPeriodEnd
        ? {
            planVersionId: change.toPlanVersionId,
            effectiveAt: change.effectiveAt,
            excess: change.excess as Readonly<Record<string, number>>,
          }
        : null;
    return {
      lifecycle: org.lifecycle,
      billingEnabled: options.billingEnabled,
      scheduledPlanChange,
      account: account ?? null,
      subscription: subscription ?? null,
    };
  });
}

/** `billing.manage`. Creating needs no version, and updating needs the one the person saw. */
export async function saveBillingAccount(
  database: AppDatabase,
  context: TenantContext,
  input: BillingAccountInput & { expectedVersion: number | null },
): Promise<{ version: number }> {
  requireBilling(context, true);
  const parsed = saveBillingAccountSchema.safeParse({
    billing_name: input.billingName,
    billing_email: input.billingEmail,
    country_code: input.countryCode,
    region_code: input.regionCode,
    postal_code: input.postalCode,
    tax_id: input.taxId,
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const data = parsed.data;
  const values = {
    billingName: data.billing_name,
    billingEmail: data.billing_email,
    countryCode: data.country_code,
    regionCode: data.region_code,
    postalCode: data.postal_code,
    taxId: data.tax_id,
  };
  return withAccountTx(database, context, async (tx) => {
    await lockOrganization(tx, context);
    const [current] = await tx
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, context.organizationId))
      .for('update');
    if (!current) {
      if (input.expectedVersion !== null) throw new AppError('VERSION_CONFLICT');
      const [created] = await tx
        .insert(billingAccounts)
        .values({
          ...values,
          organizationId: context.organizationId,
          createdByMembershipId: context.membershipId,
        })
        .returning({ id: billingAccounts.id });
      await auditAction(tx, context, 'billing.account_saved', `billing_account:${created!.id}`);
      return { version: 1 };
    }
    if (input.expectedVersion === null) throw new AppError('VERSION_CONFLICT');
    versionCheck(current.version, input.expectedVersion);
    await tx
      .update(billingAccounts)
      .set({ ...values, version: current.version + 1, updatedAt: new Date() })
      .where(eq(billingAccounts.id, current.id));
    await auditAction(tx, context, 'billing.account_saved', `billing_account:${current.id}`);
    return { version: current.version + 1 };
  });
}

/**
 * `billing.manage`, or the service context when provisioning. Refuses a draft plan, a plan for another
 * mode, and Sovereign outright. Opens the first period, allocates its credits, and emits SUBSCRIPTION_STARTED.
 */
export async function startSubscription(
  database: AppDatabase,
  context: TenantContext,
  input: { planVersionId: string; startsAt?: Date },
): Promise<{ subscriptionId: string }> {
  requireBilling(context, true, true);
  return withAccountTx(database, context, (tx) => startSubscriptionInTx(tx, context, input));
}

/** Provisioning uses this inside the same transaction as its tenant and invitation. */
export async function startSubscriptionInTx(
  tx: Tx,
  context: TenantContext,
  input: { planVersionId: string; startsAt?: Date },
): Promise<{ subscriptionId: string }> {
  requireBilling(context, true, true);
  const id = identifier(input.planVersionId);
  if (context.actorType !== 'service' && input.startsAt !== undefined)
    throw new AppError('INVALID_INPUT');
  const startsAt = input.startsAt ?? new Date();
  if (!Number.isFinite(startsAt.getTime())) throw new AppError('INVALID_INPUT');
  const org = await lockOrganization(tx, context);
  if (org.commercialMode === 'sovereign') throw new AppError('BILLING_NOT_ENABLED');
  if (org.lifecycle !== 'active') throw new AppError('INVALID_TRANSITION');
  const [existing] = await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.organizationId, context.organizationId),
        ne(subscriptions.status, 'canceled'),
      ),
    );
  if (existing) throw new AppError('SUBSCRIPTION_EXISTS');
  const plan = await loadPlanTerms(tx, id);
  if (!plan || !canStartOn(plan, org.commercialMode)) throw new AppError('PLAN_NOT_AVAILABLE');
  if (plan.rateCardId) {
    const card = await requirePublishedRateCard(tx, plan.rateCardId);
    if (card.status !== 'approved' || !card.effectiveFrom || card.effectiveFrom > startsAt)
      throw new AppError('RATE_CARD_NOT_APPROVED');
  }
  const [policy] = await tx
    .select({ id: collectionPolicies.id })
    .from(collectionPolicies)
    .where(eq(collectionPolicies.status, 'approved'))
    .orderBy(desc(collectionPolicies.version))
    .limit(1);
  let sub: typeof subscriptions.$inferSelect;
  try {
    const rows = await tx
      .insert(subscriptions)
      .values({
        organizationId: context.organizationId,
        planVersionId: id,
        currentPeriodStart: startsAt,
        currentPeriodEnd: periodEnd(startsAt, plan.billingInterval),
        createdByRef: actorRef(context),
        collectionPolicyId: policy?.id ?? null,
      })
      .returning();
    sub = rows[0]!;
  } catch (error) {
    if (pgCode(error) === '23505') throw new AppError('SUBSCRIPTION_EXISTS');
    throw error;
  }
  await openPeriod(tx, context, sub, plan);
  await tx.insert(subscriptionChanges).values({
    organizationId: context.organizationId,
    subscriptionId: sub.id,
    kind: 'created',
    toPlanVersionId: id,
    effectiveAt: startsAt,
    actorRef: actorRef(context),
  });
  await subscriptionEvent(tx, context, sub, SUBSCRIPTION_STARTED);
  return { subscriptionId: sub.id };
}

/** Locks the request before checking the live subscription, so concurrent retries replay the first result. */
export async function startSubscriptionOnce(
  database: AppDatabase,
  context: TenantContext,
  input: { planVersionId: string; requestKey: string },
): Promise<{ kind: 'fresh' | 'replayed'; subscriptionId: string } | { kind: 'conflict' }> {
  requireBilling(context, true);
  const planVersionId = identifier(input.planVersionId);
  if (
    input.requestKey.length < 8 ||
    input.requestKey.length > 128 ||
    /[\r\n\0]/.test(input.requestKey)
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const key = `subscription:${context.organizationId}:${context.membershipId}:${input.requestKey}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const [stored] = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.organizationId, context.organizationId),
          eq(idempotencyKeys.membershipId, context.membershipId),
          eq(idempotencyKeys.key, input.requestKey),
        ),
      );
    const hash = requestHash(['POST', 'billing/subscription', planVersionId]);
    if (stored) {
      if (stored.requestHash !== hash) return { kind: 'conflict' as const };
      const body = stored.responseBody as { subscription_id?: unknown };
      if (typeof body.subscription_id !== 'string') throw new AppError('VERSION_CONFLICT');
      return { kind: 'replayed' as const, subscriptionId: body.subscription_id };
    }
    const result = await startSubscriptionInTx(tx, context, { planVersionId });
    await tx.insert(idempotencyKeys).values({
      organizationId: context.organizationId,
      membershipId: context.membershipId,
      key: input.requestKey,
      requestHash: hash,
      responseStatus: 201,
      responseBody: { subscription_id: result.subscriptionId },
    });
    return { kind: 'fresh' as const, ...result };
  });
}

/**
 * `billing.manage`. Applies `planChangeEffect`, records the excess, and removes nothing. Anything over the
 * new plan's limits goes read-only for the person to remedy (OPS-21).
 */
export async function changePlan(
  database: AppDatabase,
  context: TenantContext,
  input: { toPlanVersionId: string; expectedVersion: number },
): Promise<{ effective: 'now' | 'period_end'; excess: Readonly<Record<string, number>> }> {
  requireBilling(context, true);
  const id = identifier(input.toPlanVersionId);
  return withAccountTx(database, context, async (tx) => {
    const org = await lockOrganization(tx, context);
    const sub = await liveSubscription(tx, context);
    versionCheck(sub.version, input.expectedVersion);
    const from = await loadPlanTerms(tx, sub.planVersionId);
    const to = await loadPlanTerms(tx, id);
    if (!from || !to || !canStartOn(to, org.commercialMode) || from.currency !== to.currency)
      throw new AppError('PLAN_NOT_AVAILABLE');
    // A change of billing calendar starts at a boundary, so the existing period keeps its terms.
    const effect = planChangeEffect(from, to, await memberCounts(tx, context));
    if (from.billingInterval !== to.billingInterval) effect.effective = 'period_end';
    if (effect.effective === 'now' && Object.keys(effect.excess).length > 0)
      effect.effective = 'period_end';
    await tx.insert(subscriptionChanges).values({
      organizationId: context.organizationId,
      subscriptionId: sub.id,
      kind: 'plan_changed',
      fromPlanVersionId: from.planVersionId,
      toPlanVersionId: id,
      effectiveAt: effect.effective === 'now' ? new Date() : sub.currentPeriodEnd,
      excess: effect.excess,
      actorRef: actorRef(context),
    });
    await tx
      .update(subscriptions)
      .set({
        ...(effect.effective === 'now' ? { planVersionId: id } : {}),
        version: sub.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, sub.id));
    await subscriptionEvent(
      tx,
      context,
      { ...sub, version: sub.version + 1 },
      SUBSCRIPTION_PLAN_CHANGED,
    );
    return effect;
  });
}

/** `billing.manage`. Service stays until the period ends, and the data stays after that. */
export async function requestCancellation(
  database: AppDatabase,
  context: TenantContext,
  input: { expectedVersion: number },
): Promise<void> {
  return cancellation(database, context, input.expectedVersion, true);
}

export async function withdrawCancellation(
  database: AppDatabase,
  context: TenantContext,
  input: { expectedVersion: number },
): Promise<void> {
  return cancellation(database, context, input.expectedVersion, false);
}

async function cancellation(
  database: AppDatabase,
  context: TenantContext,
  expectedVersion: number,
  requested: boolean,
) {
  requireBilling(context, true);
  return withAccountTx(database, context, async (tx) => {
    await lockOrganization(tx, context);
    const sub = await liveSubscription(tx, context);
    versionCheck(sub.version, expectedVersion);
    if (sub.cancelAtPeriodEnd === requested) return;
    await tx.insert(subscriptionChanges).values({
      organizationId: context.organizationId,
      subscriptionId: sub.id,
      kind: requested ? 'cancel_requested' : 'cancel_withdrawn',
      effectiveAt: sub.currentPeriodEnd,
      actorRef: actorRef(context),
    });
    await tx
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: requested, version: sub.version + 1, updatedAt: new Date() })
      .where(eq(subscriptions.id, sub.id));
    if (requested)
      await subscriptionEvent(
        tx,
        context,
        { ...sub, version: sub.version + 1 },
        SUBSCRIPTION_CANCEL_REQUESTED,
      );
  });
}

/** Service only, from the billing cycle. Moves a period on, or ends one marked to cancel. Repeats are safe. */
export async function advanceSubscriptionInTx(
  tx: Tx,
  context: TenantContext,
  input: { subscriptionId: string; now: Date },
  agents?: AgentHaltPort,
): Promise<'advanced' | 'canceled' | 'not_due'> {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
  const id = identifier(input.subscriptionId);
  if (!Number.isFinite(input.now.getTime())) throw new AppError('INVALID_INPUT');
  const org = await lockOrganization(tx, context);
  const [sub] = await tx
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.organizationId, context.organizationId), eq(subscriptions.id, id)))
    .for('update');
  if (!sub) throw new AppError('NOT_FOUND');
  if (sub.status === 'canceled' || sub.currentPeriodEnd > input.now) return 'not_due';
  const nextVersion = sub.version + 1;
  if (sub.cancelAtPeriodEnd) {
    await tx
      .update(subscriptions)
      .set({
        status: 'canceled',
        canceledAt: sub.currentPeriodEnd,
        version: nextVersion,
        updatedAt: input.now,
      })
      .where(eq(subscriptions.id, id));
    await tx.insert(subscriptionChanges).values({
      organizationId: context.organizationId,
      subscriptionId: id,
      kind: 'canceled',
      effectiveAt: sub.currentPeriodEnd,
      actorRef: actorRef(context),
    });
    await subscriptionEvent(tx, context, { ...sub, version: nextVersion }, SUBSCRIPTION_CANCELED);
    return 'canceled';
  }
  const [pending] = await tx
    .select()
    .from(subscriptionChanges)
    .where(
      and(eq(subscriptionChanges.subscriptionId, id), eq(subscriptionChanges.kind, 'plan_changed')),
    )
    .orderBy(desc(subscriptionChanges.occurredAt), desc(subscriptionChanges.id))
    .limit(1);
  const planId =
    pending?.toPlanVersionId && pending.effectiveAt <= sub.currentPeriodEnd
      ? pending.toPlanVersionId
      : sub.planVersionId;
  const plan = await loadPlanTerms(tx, planId);
  if (!plan || plan.commercialMode !== org.commercialMode) throw new AppError('PLAN_NOT_AVAILABLE');
  const counts = await memberCounts(tx, context);
  if (
    plan.maxActiveMembers !== null &&
    counts.activeMembers > plan.maxActiveMembers &&
    org.lifecycle === 'active'
  ) {
    if (!agents) throw new AppError('PREREQUISITES_INCOMPLETE');
    await setTenantStandingInTx(
      tx,
      context,
      {
        to: 'read_only',
        reasonCode: 'PLAN_LIMIT_EXCEEDED',
        actor: { type: 'system', ref: 'system:subscription' },
      },
      agents,
    );
  }
  const next = {
    ...sub,
    planVersionId: planId,
    currentPeriodStart: sub.currentPeriodEnd,
    currentPeriodEnd: periodEnd(sub.currentPeriodEnd, plan.billingInterval),
    version: nextVersion,
  };
  await tx
    .update(subscriptions)
    .set({
      planVersionId: planId,
      currentPeriodStart: next.currentPeriodStart,
      currentPeriodEnd: next.currentPeriodEnd,
      version: nextVersion,
      updatedAt: input.now,
    })
    .where(eq(subscriptions.id, id));
  await openPeriod(tx, context, next, plan);
  return 'advanced';
}
