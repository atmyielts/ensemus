// Owned by the credits slice (BILL-04, BILL-05). See docs/06-delivery/m8-slices.md and ADR-032 D2, D9.
import {
  billingPeriods,
  creditAccounts,
  creditLedger,
  memberships,
  organizations,
  subscriptions,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { can } from '@ensemus/domain/policy';
import { priceUsage } from '@ensemus/saas/catalog';
import { creditKeys } from '@ensemus/saas/credits';
import {
  AGGREGATE_ORGANIZATION,
  CREDITS_EXHAUSTED,
  NOTIFY_CREDITS_EXHAUSTED,
  organizationTargetRef,
} from '@ensemus/saas/events';
import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { loadEntitlementMetadataInTx } from './entitlement-metadata';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { emit } from '../events';
import { notify } from '../work';
import { loadPlanTerms, requirePublishedRateCard } from './catalog';
import type { UsageLedgerPort } from './ports';

export type CreditSummary = {
  /** Null for BYOM, whose provider bills its customer, so Ensemus shows no balance at all. */
  balanceMicrocredits: bigint | null;
  includedMicrocredits: bigint | null;
  overagePolicy: 'pause' | 'explicit_top_up' | null;
  recent: readonly { kind: string; amountMicrocredits: bigint; occurredAt: Date }[];
};

/** `billing.view`. */
export async function getCreditSummary(
  database: AppDatabase,
  context: TenantContext,
): Promise<CreditSummary> {
  if (context.actorType !== 'user' || !can(context.role, 'billing.view'))
    throw new AppError('NOT_FOUND');
  return withAccountTx(database, context, async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, context.organizationId));
    if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
    if (org.commercialMode !== 'cloud')
      return {
        balanceMicrocredits: null,
        includedMicrocredits: null,
        overagePolicy: null,
        recent: [],
      };
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, context.organizationId))
      .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
      .limit(1);
    const plan = sub ? await loadPlanTerms(tx, sub.planVersionId) : null;
    const recent = await tx
      .select({
        kind: creditLedger.kind,
        amountMicrocredits: creditLedger.amountMicrocredits,
        occurredAt: creditLedger.occurredAt,
      })
      .from(creditLedger)
      .where(eq(creditLedger.organizationId, context.organizationId))
      .orderBy(desc(creditLedger.occurredAt), desc(creditLedger.id))
      .limit(100);
    return {
      balanceMicrocredits: await loadCreditBalanceInTx(tx, context),
      includedMicrocredits: plan?.includedMicrocredits ?? null,
      overagePolicy: plan?.overagePolicy ?? null,
      recent,
    };
  });
}

/** Service only, once per period, by key. A plan with no allowance allocates nothing. */
export async function allocatePeriodCreditsInTx(
  tx: Tx,
  context: TenantContext,
  input: { billingPeriodId: string; includedMicrocredits: bigint; rateCardId: string },
): Promise<void> {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
  if (
    !idSchema.safeParse(input.billingPeriodId).success ||
    !idSchema.safeParse(input.rateCardId).success ||
    input.includedMicrocredits < 0n
  )
    throw new AppError('INVALID_INPUT');
  const [period] = await tx
    .select()
    .from(billingPeriods)
    .where(
      and(
        eq(billingPeriods.organizationId, context.organizationId),
        eq(billingPeriods.id, input.billingPeriodId),
      ),
    );
  if (!period) throw new AppError('NOT_FOUND');
  const plan = await loadPlanTerms(tx, period.planVersionId);
  if (
    !plan ||
    plan.commercialMode !== 'cloud' ||
    plan.rateCardId !== input.rateCardId ||
    period.rateCardId !== input.rateCardId ||
    plan.includedMicrocredits !== input.includedMicrocredits
  )
    throw new AppError('INVALID_INPUT');
  await requirePublishedRateCard(tx, input.rateCardId);
  if (input.includedMicrocredits === 0n) return;
  await tx
    .insert(creditLedger)
    .values({
      organizationId: context.organizationId,
      idempotencyKey: creditKeys.allocation(input.billingPeriodId),
      kind: 'allocation',
      amountMicrocredits: input.includedMicrocredits,
      billingPeriodId: input.billingPeriodId,
      rateCardId: input.rateCardId,
    })
    .onConflictDoNothing();
}

/**
 * Service only. Reads new ledger entries through the port and writes one consumption row per billable entry,
 * keyed by the entry's own ID, so it can run any number of times. Priced by the period's card, and refuses
 * without one. A non-billable entry is skipped, so BYOM is never charged (QA-027). Emits CREDITS_LOW and
 * CREDITS_EXHAUSTED once each, on crossing.
 */
export async function consumeUsage(
  database: AppDatabase,
  context: TenantContext,
  usage: UsageLedgerPort,
  input: { limit: number },
): Promise<{ entries: number; microcredits: bigint; exhausted: boolean; more: boolean }> {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000)
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .for('no key update');
    if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
    if (org.commercialMode !== 'cloud')
      return { entries: 0, microcredits: 0n, exhausted: false, more: false };
    await tx
      .insert(creditAccounts)
      .values({ organizationId: context.organizationId })
      .onConflictDoNothing();
    const [account] = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.organizationId, context.organizationId))
      .for('update');
    const page = await usage.listSince(tx, context, {
      after: account!.usageCursor,
      limit: input.limit,
    });
    let entries = 0;
    let microcredits = 0n;
    for (const entry of page.entries) {
      if (!entry.billable) continue;
      if (!idSchema.safeParse(entry.id).success || !Number.isFinite(entry.occurredAt.getTime()))
        throw new AppError('INVALID_INPUT');
      const [existing] = await tx
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.idempotencyKey, creditKeys.consumption(entry.id)));
      if (existing) continue;
      const [original] =
        entry.status === 'correction' && entry.correctsUsageId
          ? await tx
              .select()
              .from(creditLedger)
              .where(eq(creditLedger.usageRef, entry.correctsUsageId))
          : [];
      if (entry.status === 'correction' && !original)
        throw new AppError('PREREQUISITES_INCOMPLETE');
      const [period] = original?.billingPeriodId
        ? await tx
            .select()
            .from(billingPeriods)
            .where(eq(billingPeriods.id, original.billingPeriodId))
        : await tx
            .select()
            .from(billingPeriods)
            .where(
              and(
                eq(billingPeriods.organizationId, context.organizationId),
                lte(billingPeriods.startsAt, entry.occurredAt),
                gt(billingPeriods.endsAt, entry.occurredAt),
              ),
            )
            .orderBy(desc(billingPeriods.startsAt))
            .limit(1);
      if (!period?.rateCardId) throw new AppError('RATE_CARD_NOT_APPROVED');
      const card = await requirePublishedRateCard(tx, period.rateCardId);
      const priced = priceUsage(
        card,
        [{ meter: entry.meter, unit: entry.unit, quantity: entry.quantity }],
        original ? period.startsAt : entry.occurredAt,
      );
      if (!priced.ok) throw new AppError('RATE_CARD_NOT_APPROVED');
      const amount = -priced.meters[0]!.microcredits;
      if (amount < -9223372036854775808n || amount > 9223372036854775807n)
        throw new AppError('INVALID_INPUT');
      if (entry.status !== 'correction' && amount > 0n) throw new AppError('INVALID_INPUT');
      const written = await tx
        .insert(creditLedger)
        .values({
          organizationId: context.organizationId,
          idempotencyKey: creditKeys.consumption(entry.id),
          kind: original ? 'correction' : 'consumption',
          amountMicrocredits: amount,
          billingPeriodId: period.id,
          rateCardId: period.rateCardId,
          usageRef: entry.id,
          correctsId: original?.id ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: creditLedger.id });
      if (written.length) {
        entries += 1;
        microcredits -= amount;
      }
    }
    if (page.nextCursor !== null && page.nextCursor !== account!.usageCursor)
      await tx
        .update(creditAccounts)
        .set({ usageCursor: page.nextCursor, updatedAt: new Date() })
        .where(eq(creditAccounts.organizationId, context.organizationId));
    const balance = await loadCreditBalanceInTx(tx, context);
    if (account!.balanceMicrocredits > 0n && balance <= 0n) {
      await emit(tx, context, {
        eventType: CREDITS_EXHAUSTED,
        aggregateType: AGGREGATE_ORGANIZATION,
        aggregateId: context.organizationId,
        aggregateVersion: account!.version + entries,
        classification: 'internal',
        payload: { organization_id: context.organizationId },
      });
      const owners = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
      await notify(
        tx,
        context,
        owners.map((row) => row.id),
        NOTIFY_CREDITS_EXHAUSTED,
        organizationTargetRef(context.organizationId),
      );
    }
    return {
      entries,
      microcredits,
      exhausted: balance <= 0n,
      more: page.more ?? page.nextCursor !== null,
    };
  });
}

/** What the entitlement check asks when a Cloud model call is about to start. */
export async function loadCreditBalanceInTx(tx: Tx, context: TenantContext): Promise<bigint> {
  // The SQL function checks the real caller and current tenant; no raw account/usage cursor read.
  if(!context.organizationId) throw new AppError('NOT_FOUND');
  return (await loadEntitlementMetadataInTx(tx,context)).balanceMicrocredits;
}
