// What the operator's commands do to the global price list, as `ensemus_operator`. It is here, and not in
// the web tier, because there is no web path to it at all. Owned by the catalog slice. See ADR-032 D2, D3.
import type { EnsemusDrizzle } from '@ensemus/database/operator';
import {
  collectionPolicies,
  operatorActions,
  plans,
  planVersions,
  providerBills,
  rateCardLines,
  billingRateCards,
  taxTreatments,
  topUpOffers,
} from '@ensemus/database';
import { collectionStepsSchema, minorUnitExponentSchema } from '@ensemus/contracts/saas';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import { requirePublishedRateCard } from './catalog';
import { UsageUnavailable, type ProviderCostPort } from './ports';

export type OperatorDb = EnsemusDrizzle;
export type OperatorRef = { operatorRef: string };

const I64_MAX = 9_223_372_036_854_775_807n;
const nonnegative = z.bigint().min(0n).max(I64_MAX);
const positive = z.bigint().min(1n).max(I64_MAX);
const signed = z
  .bigint()
  .min(-I64_MAX - 1n)
  .max(I64_MAX);
const reference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value));
const catalogCode = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const operator = { operatorRef: reference };
export const catalogDateWireSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

/** Shared only with the operator command's wire parser; services validate again before a transaction. */
export const catalogInputSchemas = {
  draftRateCard: z.strictObject({
    ...operator,
    code: catalogCode,
    currency,
    minorUnitExponent: minorUnitExponentSchema,
    lines: z
      .array(
        z.strictObject({
          meter: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/),
          unit: reference,
          microcreditsPerUnit: nonnegative,
        }),
      )
      .refine((rows) => new Set(rows.map((row) => row.meter)).size === rows.length),
    topUpOffers: z
      .array(z.strictObject({ code: catalogCode, microcredits: positive, priceMicros: positive }))
      .refine((rows) => new Set(rows.map((row) => row.code)).size === rows.length),
  }),
  approveRateCard: z.strictObject({ ...operator, rateCardId: idSchema, effectiveFrom: z.date() }),
  draftPlanVersion: z.strictObject({
    ...operator,
    planCode: catalogCode,
    displayName: reference,
    commercialMode: z.enum(['cloud', 'byom']),
    currency,
    billingInterval: z.enum(['month', 'year']),
    paymentTermsDays: z.int().min(0),
    minorUnitExponent: minorUnitExponentSchema,
    platformFeeMicros: nonnegative,
    includedMicrocredits: nonnegative.nullable(),
    rateCardId: idSchema.nullable(),
    overagePolicy: z.enum(['pause', 'explicit_top_up']).nullable(),
    features: z.array(reference).refine((values) => new Set(values).size === values.length),
    maxActiveMembers: z.int().positive().nullable(),
  }),
  approvePlanVersion: z.strictObject({ ...operator, planVersionId: idSchema }),
  publishCollectionPolicy: z.strictObject({
    ...operator,
    termsRef: reference,
    steps: collectionStepsSchema,
  }),
  publishTaxTreatment: z.strictObject({
    ...operator,
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    regionCode: z.string().regex(/^[A-Z0-9-]{0,16}$/),
    treatment: z.enum(['provider_computed', 'not_collected']),
    adviserRef: reference,
  }),
  enterProviderBill: z
    .strictObject({
      ...operator,
      providerKind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      periodStart: z.date(),
      periodEnd: z.date(),
      currency,
      amountMicros: signed,
      sourceRef: reference,
    })
    .refine((value) => value.periodEnd > value.periodStart),
  reconcileProviderBill: z.strictObject({
    ...operator,
    providerBillId: idSchema,
    decision: z.enum(['reconciled', 'disputed']).nullable(),
  }),
};

function inputOf<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

type CatalogTx = Parameters<Parameters<OperatorDb['transaction']>[0]>[0];

async function lock(tx: CatalogTx, key: string) {
  // A row lock cannot serialize the first draft of a code that has no row yet.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`catalog:${key}`}, 0))`);
}

async function audit(
  tx: CatalogTx,
  operatorRef: string,
  action: string,
  targetRef: string,
  reasonCode?: string,
) {
  await tx
    .insert(operatorActions)
    .values({ operatorRef, action, targetRef, ...(reasonCode ? { reasonCode } : {}) });
}

async function catalogWrite<T>(db: OperatorDb, use: (tx: CatalogTx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(use);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = pgCode(error);
    if (code === 'EN801') throw new AppError('RATE_CARD_NOT_APPROVED');
    if (code === '23505') throw new AppError('VERSION_CONFLICT');
    if (code === '23503' || code === '23514' || code === '22003')
      throw new AppError('INVALID_INPUT');
    throw error;
  }
}

export type DraftRateCardInput = OperatorRef & {
  code: string;
  currency: string;
  minorUnitExponent: number;
  lines: readonly { meter: string; unit: string; microcreditsPerUnit: bigint }[];
  topUpOffers: readonly { code: string; microcredits: bigint; priceMicros: bigint }[];
};

/** Writes the next version as a draft. Every number comes from the caller: there are no defaults. */
export async function draftRateCard(
  db: OperatorDb,
  input: DraftRateCardInput,
): Promise<{ rateCardId: string; version: number }> {
  const value = inputOf(catalogInputSchemas.draftRateCard, input);
  return catalogWrite(db, async (tx) => {
    await lock(tx, `card:${value.code}`);
    const [latest] = await tx
      .select({ version: sql<number>`coalesce(max(${billingRateCards.version}), 0)::int` })
      .from(billingRateCards)
      .where(eq(billingRateCards.code, value.code));
    const version = (latest?.version ?? 0) + 1;
    const [card] = await tx
      .insert(billingRateCards)
      .values({
        code: value.code,
        version,
        currency: value.currency,
        minorUnitExponent: value.minorUnitExponent,
        draftedBy: value.operatorRef,
      })
      .returning({ id: billingRateCards.id });
    if (!card) throw new AppError('INVALID_STATE');
    if (value.lines.length)
      await tx
        .insert(rateCardLines)
        .values(value.lines.map((line) => ({ ...line, rateCardId: card.id })));
    if (value.topUpOffers.length)
      await tx
        .insert(topUpOffers)
        .values(value.topUpOffers.map((offer) => ({ ...offer, rateCardId: card.id })));
    await audit(tx, value.operatorRef, 'catalog.rate_card.drafted', `rate_card:${card.id}`);
    return { rateCardId: card.id, version };
  });
}

/** Approves a draft from a set date, and retires what it replaces only for new periods. Audited. */
export async function approveRateCard(
  db: OperatorDb,
  input: OperatorRef & { rateCardId: string; effectiveFrom: Date },
): Promise<void> {
  const value = inputOf(catalogInputSchemas.approveRateCard, input);
  return catalogWrite(db, async (tx) => {
    const [identity] = await tx
      .select({ code: billingRateCards.code })
      .from(billingRateCards)
      .where(eq(billingRateCards.id, value.rateCardId));
    if (!identity) throw new AppError('NOT_FOUND');
    await lock(tx, `card:${identity.code}`);
    const [card] = await tx
      .select()
      .from(billingRateCards)
      .where(eq(billingRateCards.id, value.rateCardId))
      .for('update');
    if (!card || card.status !== 'draft') throw new AppError('INVALID_STATE');
    const [line] = await tx
      .select({ meter: rateCardLines.meter })
      .from(rateCardLines)
      .where(eq(rateCardLines.rateCardId, card.id))
      .limit(1);
    if (!line) throw new AppError('RATE_CARD_NOT_APPROVED');
    const now = new Date();
    await tx
      .update(billingRateCards)
      .set({ status: 'retired', retiredAt: now })
      .where(
        and(eq(billingRateCards.code, identity.code), eq(billingRateCards.status, 'approved')),
      );
    await tx
      .update(billingRateCards)
      .set({
        status: 'approved',
        effectiveFrom: value.effectiveFrom,
        approvedBy: value.operatorRef,
        approvedAt: now,
      })
      .where(eq(billingRateCards.id, card.id));
    await audit(tx, value.operatorRef, 'catalog.rate_card.approved', `rate_card:${card.id}`);
  });
}

export type DraftPlanVersionInput = OperatorRef & {
  planCode: string;
  displayName: string;
  commercialMode: 'cloud' | 'byom';
  currency: string;
  billingInterval: 'month' | 'year';
  paymentTermsDays: number;
  minorUnitExponent: number;
  platformFeeMicros: bigint;
  includedMicrocredits: bigint | null;
  rateCardId: string | null;
  overagePolicy: 'pause' | 'explicit_top_up' | null;
  features: readonly string[];
  maxActiveMembers: number | null;
};

export async function draftPlanVersion(
  db: OperatorDb,
  input: DraftPlanVersionInput,
): Promise<{ planVersionId: string; version: number }> {
  const value = inputOf(catalogInputSchemas.draftPlanVersion, input);
  return catalogWrite(db, async (tx) => {
    await lock(tx, `plan:${value.planCode}`);
    await tx
      .insert(plans)
      .values({
        code: value.planCode,
        commercialMode: value.commercialMode,
        displayName: value.displayName,
      })
      .onConflictDoNothing({ target: plans.code });
    const [plan] = await tx
      .select()
      .from(plans)
      .where(eq(plans.code, value.planCode))
      .for('update');
    if (
      !plan ||
      plan.commercialMode !== value.commercialMode ||
      plan.displayName !== value.displayName
    )
      throw new AppError('INVALID_INPUT');
    const [latest] = await tx
      .select({ version: sql<number>`coalesce(max(${planVersions.version}), 0)::int` })
      .from(planVersions)
      .where(eq(planVersions.planId, plan.id));
    const version = (latest?.version ?? 0) + 1;
    const [row] = await tx
      .insert(planVersions)
      .values({
        planId: plan.id,
        version,
        currency: value.currency,
        billingInterval: value.billingInterval,
        paymentTermsDays: value.paymentTermsDays,
        minorUnitExponent: value.minorUnitExponent,
        platformFeeMicros: value.platformFeeMicros,
        includedMicrocredits: value.includedMicrocredits,
        rateCardId: value.rateCardId,
        overagePolicy: value.overagePolicy,
        features: value.features,
        maxActiveMembers: value.maxActiveMembers,
        draftedBy: value.operatorRef,
      })
      .returning({ id: planVersions.id });
    if (!row) throw new AppError('INVALID_STATE');
    await audit(tx, value.operatorRef, 'catalog.plan.drafted', `plan_version:${row.id}`);
    return { planVersionId: row.id, version };
  });
}

export async function approvePlanVersion(
  db: OperatorDb,
  input: OperatorRef & { planVersionId: string },
): Promise<void> {
  const value = inputOf(catalogInputSchemas.approvePlanVersion, input);
  return catalogWrite(db, async (tx) => {
    const [identity] = await tx
      .select({ planId: planVersions.planId })
      .from(planVersions)
      .where(eq(planVersions.id, value.planVersionId));
    if (!identity) throw new AppError('NOT_FOUND');
    await lock(tx, `plan-version:${identity.planId}`);
    const [version] = await tx
      .select()
      .from(planVersions)
      .where(eq(planVersions.id, value.planVersionId))
      .for('update');
    if (!version || version.status !== 'draft') throw new AppError('INVALID_STATE');
    const [plan] = await tx.select().from(plans).where(eq(plans.id, version.planId));
    if (!plan) throw new AppError('PLAN_NOT_AVAILABLE');
    if (version.minorUnitExponent === null) throw new AppError('PLAN_NOT_AVAILABLE');
    if (plan.commercialMode === 'byom') {
      if (
        version.rateCardId !== null ||
        version.includedMicrocredits !== null ||
        version.overagePolicy !== null
      )
        throw new AppError('PLAN_NOT_AVAILABLE');
    } else {
      if (
        !version.rateCardId ||
        version.includedMicrocredits === null ||
        version.overagePolicy === null
      )
        throw new AppError('RATE_CARD_NOT_APPROVED');
      const card = await requirePublishedRateCard(tx, version.rateCardId);
      if (
        card.status !== 'approved' ||
        card.currency !== version.currency ||
        card.minorUnitExponent !== version.minorUnitExponent
      )
        throw new AppError('RATE_CARD_NOT_APPROVED');
    }
    const now = new Date();
    await tx
      .update(planVersions)
      .set({ status: 'retired', retiredAt: now })
      .where(and(eq(planVersions.planId, version.planId), eq(planVersions.status, 'approved')));
    await tx
      .update(planVersions)
      .set({ status: 'approved', approvedBy: value.operatorRef, approvedAt: now })
      .where(eq(planVersions.id, version.id));
    await audit(tx, value.operatorRef, 'catalog.plan.approved', `plan_version:${version.id}`);
  });
}

/** Terms reference and steps both required. Without an approved one, collection takes no action. */
export async function publishCollectionPolicy(
  db: OperatorDb,
  input: OperatorRef & {
    termsRef: string;
    steps: readonly { afterDays: number; action: string }[];
  },
): Promise<{ policyId: string; version: number }> {
  const value = inputOf(catalogInputSchemas.publishCollectionPolicy, input);
  return catalogWrite(db, async (tx) => {
    await lock(tx, 'collection-policy');
    const [latest] = await tx
      .select({ version: sql<number>`coalesce(max(${collectionPolicies.version}), 0)::int` })
      .from(collectionPolicies);
    const version = (latest?.version ?? 0) + 1;
    const [row] = await tx
      .insert(collectionPolicies)
      .values({
        version,
        termsRef: value.termsRef,
        steps: value.steps,
        draftedBy: value.operatorRef,
      })
      .returning({ id: collectionPolicies.id });
    if (!row) throw new AppError('INVALID_STATE');
    const now = new Date();
    await tx
      .update(collectionPolicies)
      .set({ status: 'retired', retiredAt: now })
      .where(eq(collectionPolicies.status, 'approved'));
    await tx
      .update(collectionPolicies)
      .set({ status: 'approved', approvedBy: value.operatorRef, approvedAt: now })
      .where(eq(collectionPolicies.id, row.id));
    await audit(
      tx,
      value.operatorRef,
      'catalog.collection_policy.published',
      `collection_policy:${row.id}`,
    );
    return { policyId: row.id, version };
  });
}

/** Records an adviser's guidance for a place. `adviserRef` is required, because it is the only basis. */
export async function publishTaxTreatment(
  db: OperatorDb,
  input: OperatorRef & {
    countryCode: string;
    regionCode: string;
    treatment: 'provider_computed' | 'not_collected';
    adviserRef: string;
  },
): Promise<{ treatmentId: string; version: number }> {
  const value = inputOf(catalogInputSchemas.publishTaxTreatment, input);
  return catalogWrite(db, async (tx) => {
    await lock(tx, `tax:${value.countryCode}:${value.regionCode}`);
    const place = and(
      eq(taxTreatments.countryCode, value.countryCode),
      eq(taxTreatments.regionCode, value.regionCode),
    );
    const [latest] = await tx
      .select({ version: sql<number>`coalesce(max(${taxTreatments.version}), 0)::int` })
      .from(taxTreatments)
      .where(place);
    const version = (latest?.version ?? 0) + 1;
    const [row] = await tx
      .insert(taxTreatments)
      .values({
        countryCode: value.countryCode,
        regionCode: value.regionCode,
        version,
        treatment: value.treatment,
        adviserRef: value.adviserRef,
        draftedBy: value.operatorRef,
      })
      .returning({ id: taxTreatments.id });
    if (!row) throw new AppError('INVALID_STATE');
    const now = new Date();
    await tx
      .update(taxTreatments)
      .set({ status: 'retired', retiredAt: now })
      .where(and(place, eq(taxTreatments.status, 'approved')));
    await tx
      .update(taxTreatments)
      .set({ status: 'approved', approvedBy: value.operatorRef, approvedAt: now })
      .where(eq(taxTreatments.id, row.id));
    await audit(
      tx,
      value.operatorRef,
      'catalog.tax_treatment.published',
      `tax_treatment:${row.id}`,
    );
    return { treatmentId: row.id, version };
  });
}

/** A provider's bill, entered by hand from their invoice. */
export async function enterProviderBill(
  db: OperatorDb,
  input: OperatorRef & {
    providerKind: string;
    periodStart: Date;
    periodEnd: Date;
    currency: string;
    amountMicros: bigint;
    sourceRef: string;
  },
): Promise<{ providerBillId: string }> {
  const value = inputOf(catalogInputSchemas.enterProviderBill, input);
  return catalogWrite(db, async (tx) => {
    const { operatorRef, ...bill } = value;
    const [row] = await tx
      .insert(providerBills)
      .values({ ...bill, enteredBy: operatorRef })
      .returning({ id: providerBills.id });
    if (!row) throw new AppError('INVALID_STATE');
    await audit(tx, operatorRef, 'catalog.provider_bill.entered', `provider_bill:${row.id}`);
    return { providerBillId: row.id };
  });
}

/**
 * The real reader, in raw SQL over M4's `platform.usage_ledger` columns as landed (`provider_kind`, `billable`,
 * `cost_micros`, `created_at`). Raw, so this file does not need M4's Drizzle table to compile. Migration 0501
 * grants the operator this table once it exists.
 */
export function createProviderCostReader(db: OperatorDb): ProviderCostPort {
  return {
    async sumProviderCost(input) {
      if (
        !reference.safeParse(input.providerKind).success ||
        !Number.isFinite(input.from.getTime()) ||
        !Number.isFinite(input.to.getTime()) ||
        input.to <= input.from
      )
        throw new UsageUnavailable();
      try {
        const result = await db.execute<{ cost: string }>(sql`
          select coalesce(sum(cost_micros), 0)::text as cost
            from platform.usage_ledger
           where provider_kind = ${input.providerKind} and billable = true
             and created_at >= ${input.from.toISOString()}::timestamptz
             and created_at < ${input.to.toISOString()}::timestamptz
        `);
        const cost = result.rows[0]?.cost;
        if (cost === undefined || !/^-?\d+$/.test(cost)) throw new UsageUnavailable();
        return BigInt(cost);
      } catch {
        throw new UsageUnavailable();
      }
    },
  };
}

/**
 * Sets a bill against the ledger through ProviderCostPort, and stores the difference. It reports, and
 * decides nothing: a person says reconciled or disputed (BILL-04). There is no tolerance in code.
 */
export async function reconcileProviderBill(
  db: OperatorDb,
  input: OperatorRef & {
    providerBillId: string;
    decision: 'reconciled' | 'disputed' | null;
  },
  ledger: ProviderCostPort,
): Promise<{ ledgerCostMicros: bigint; differenceMicros: bigint }> {
  const value = inputOf(catalogInputSchemas.reconcileProviderBill, input);
  const [bill] = await db
    .select()
    .from(providerBills)
    .where(eq(providerBills.id, value.providerBillId));
  if (!bill) throw new AppError('NOT_FOUND');
  // The provider port runs before taking a row lock. It may need another database connection.
  const ledgerCostMicros = await ledger.sumProviderCost({
    providerKind: bill.providerKind,
    from: bill.periodStart,
    to: bill.periodEnd,
  });
  const differenceMicros = bill.amountMicros - ledgerCostMicros;
  return catalogWrite(db, async (tx) => {
    const [current] = await tx
      .select()
      .from(providerBills)
      .where(eq(providerBills.id, bill.id))
      .for('update');
    if (!current) throw new AppError('NOT_FOUND');
    if (
      current.status !== bill.status ||
      current.ledgerCostMicros !== bill.ledgerCostMicros ||
      current.differenceMicros !== bill.differenceMicros ||
      current.reviewedBy !== bill.reviewedBy ||
      current.reviewedAt?.getTime() !== bill.reviewedAt?.getTime()
    ) {
      throw new AppError('VERSION_CONFLICT');
    }
    const changed =
      current.ledgerCostMicros !== null &&
      (current.ledgerCostMicros !== ledgerCostMicros ||
        current.differenceMicros !== differenceMicros);
    // Refreshing a comparison cannot keep a human's old decision attached to different figures.
    const review = value.decision
      ? { status: value.decision, reviewedBy: value.operatorRef, reviewedAt: new Date() }
      : changed
        ? { status: 'open', reviewedBy: null, reviewedAt: null }
        : {};
    await tx
      .update(providerBills)
      .set({ ledgerCostMicros, differenceMicros, ...review })
      .where(eq(providerBills.id, bill.id));
    await audit(
      tx,
      value.operatorRef,
      'catalog.provider_bill.compared',
      `provider_bill:${bill.id}`,
      value.decision ? value.decision.toUpperCase() : 'COMPARISON_ONLY',
    );
    return { ledgerCostMicros, differenceMicros };
  });
}
