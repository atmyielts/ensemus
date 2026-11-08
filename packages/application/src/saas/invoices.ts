// Owned by the invoicing slice (BILL-02, BILL-03). See docs/06-delivery/m8-slices.md and ADR-032 D2.
import { createHash } from 'node:crypto';
import {
  appendAudit,
  auditEvents,
  billingAccounts,
  billingPeriods,
  invoiceLines,
  invoices,
  memberships,
  organizations,
  payments,
  taxTreatments,
  topUpOffers,
  topUps,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { can } from '@ensemus/domain/policy';
import {
  buildPeriodInvoice,
  buildTopUpInvoice,
  invoiceAddsUp,
  withTax,
  type DraftInvoice,
  type DraftLine,
} from '@ensemus/saas/invoice';
import { priceUsage } from '@ensemus/saas/catalog';
import { treatmentFor } from '@ensemus/saas/tax';
import {
  AGGREGATE_INVOICE,
  INVOICE_ISSUED,
  INVOICE_PAID,
  INVOICE_VOIDED,
  NOTIFY_INVOICE_ISSUED,
  invoiceTargetRef,
} from '@ensemus/saas/events';
import { and, asc, desc, eq, getTableColumns, inArray, lte, sql } from 'drizzle-orm';
import { UsageUnavailable, type AgentHaltPort, type UsageLedgerPort } from './ports';
import { loadPlanTerms, requirePublishedRateCard } from './catalog';
import { advanceSubscriptionInTx } from './subscriptions';
import { afterInvoicePaidInTx } from './payments';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { emit } from '../events';
import { notify } from '../work';

const requireView = (context: TenantContext, manage = false) => {
  if (
    context.actorType !== 'user' ||
    !can(context.role, manage ? 'billing.manage' : 'billing.view')
  )
    throw new AppError('NOT_FOUND');
};
const requireService = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
};
const idOf = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
async function orgLock(tx: Tx, context: TenantContext) {
  const [org] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
  return org;
}
async function billingAccount(tx: Tx, context: TenantContext) {
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.organizationId, context.organizationId));
  if (!account) throw new AppError('PREREQUISITES_INCOMPLETE');
  return account;
}
async function treatment(tx: Tx, account: typeof billingAccounts.$inferSelect) {
  const approved = await tx
    .select()
    .from(taxTreatments)
    .where(
      and(eq(taxTreatments.status, 'approved'), eq(taxTreatments.countryCode, account.countryCode)),
    );
  const chosen = treatmentFor(approved, account);
  if (!chosen) throw new AppError('TAX_TREATMENT_MISSING');
  return chosen;
}
function summaryOf(row: typeof invoices.$inferSelect): InvoiceSummary {
  if (row.kind !== 'subscription' && row.kind !== 'top_up') throw new AppError('INVALID_STATE');
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    kind: row.kind,
    status: row.status,
    currency: row.currency,
    totalMicros: row.totalMicros,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    paidAt: row.paidAt,
  };
}
async function readLines(tx: Tx, invoiceId: string) {
  return tx
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.lineNo));
}
function draftOf(
  row: typeof invoices.$inferSelect,
  lines: readonly (typeof invoiceLines.$inferSelect)[],
): DraftInvoice {
  return {
    currency: row.currency,
    lines: lines.map((l) => ({
      kind: l.kind as DraftLine['kind'],
      meter: l.meter,
      quantity: l.quantity,
      unit: l.unit,
      unitPriceMicros: l.unitPriceMicros,
      amountMicros: l.amountMicros,
      usageRef: l.usageRef,
    })),
    subtotalMicros: row.subtotalMicros,
    taxMicros: row.taxMicros,
    totalMicros: row.totalMicros,
  };
}
async function writeLines(tx: Tx, context: TenantContext, invoiceId: string, draft: DraftInvoice) {
  if (!invoiceAddsUp(draft)) throw new AppError('INVALID_INPUT');
  await tx.insert(invoiceLines).values(
    draft.lines.map((l, index) => ({
      ...l,
      organizationId: context.organizationId,
      invoiceId,
      lineNo: index + 1,
    })),
  );
}
async function precision(tx: Tx, row: typeof invoices.$inferSelect): Promise<number> {
  if (row.kind === 'subscription' && row.planVersionId) {
    const plan = await loadPlanTerms(tx, row.planVersionId);
    if (plan?.minorUnitExponent !== null && plan?.minorUnitExponent !== undefined)
      return plan.minorUnitExponent;
  }
  if (row.kind === 'top_up' && row.rateCardId)
    return (await requirePublishedRateCard(tx, row.rateCardId)).minorUnitExponent;
  throw new AppError('PLAN_NOT_AVAILABLE');
}
async function taxQuestionInTx(
  tx: Tx,
  context: TenantContext,
  row: typeof invoices.$inferSelect,
): Promise<TaxQuestion> {
  const account = await billingAccount(tx, context);
  const chosen = await treatment(tx, account);
  const lines = await readLines(tx, row.id);
  const exponent = await precision(tx, row);
  const questionHash = createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.version,
        account.version,
        account.billingName,
        account.billingEmail,
        account.countryCode,
        account.regionCode,
        account.postalCode,
        account.taxId,
        chosen.id,
        row.currency,
        exponent,
        lines.map((l) => [
          l.lineNo,
          l.kind,
          l.meter,
          l.quantity?.toString() ?? null,
          l.unit,
          l.unitPriceMicros?.toString() ?? null,
          l.amountMicros.toString(),
          l.usageRef,
        ]),
      ]),
    )
    .digest('hex');
  if (chosen.treatment !== 'provider_computed' && chosen.treatment !== 'not_collected')
    throw new AppError('TAX_TREATMENT_MISSING');
  return {
    invoiceId: row.id,
    treatmentId: chosen.id,
    treatment: chosen.treatment,
    questionHash,
    input: {
      idempotencyKey: `invoice:${row.id}:${questionHash}`,
      currency: row.currency,
      countryCode: account.countryCode,
      regionCode: account.regionCode,
      postalCode: account.postalCode,
      taxId: account.taxId,
      lines: lines
        .filter((l) => l.kind !== 'tax' && l.kind !== 'rounding')
        .map((l) => ({ kind: l.kind, amountMicros: l.amountMicros })),
    },
  };
}

export type InvoiceSummary = {
  id: string;
  invoiceNumber: number | null;
  kind: 'subscription' | 'top_up';
  status: string;
  currency: string;
  totalMicros: bigint;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
};

export type InvoiceDetail = InvoiceSummary & {
  source: {
    billingPeriodId: string | null;
    planVersionId: string | null;
    rateCardId: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
  };
  subtotalMicros: bigint;
  taxMicros: bigint;
  minorUnitExponent: number | null;
  lines: readonly {
    lineNo: number;
    kind: string;
    meter: string | null;
    quantity: bigint | null;
    unit: string | null;
    unitPriceMicros: bigint | null;
    amountMicros: bigint;
  }[];
  version: number;
};

/** `billing.view`. A member without it gets the usual not found. */
export async function listInvoices(
  database: AppDatabase,
  context: TenantContext,
  input: { after?: string; limit?: number },
): Promise<{ items: readonly InvoiceSummary[]; nextCursor: string | null }> {
  requireView(context);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('INVALID_INPUT');
  let cursor: { at: string; id: string } | null = null;
  if (input.after)
    try {
      const parsed: unknown = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8'));
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== 'string' ||
        typeof parsed[1] !== 'string' ||
        !Number.isFinite(new Date(parsed[0]).getTime())
      )
        throw new Error('INVALID_CURSOR');
      cursor = { at: parsed[0], id: idOf(parsed[1]) };
    } catch {
      throw new AppError('INVALID_INPUT');
    }
  return withAccountTx(database, context, async (tx) => {
    const rows = await tx
      .select({
        ...getTableColumns(invoices),
        cursorAt: sql<string>`to_char(${invoices.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, context.organizationId),
          cursor
            ? sql`(${invoices.createdAt},${invoices.id}) < (${cursor.at}::timestamptz,${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    // Keep PostgreSQL microseconds: many periods can be drafted in the same transaction timestamp.
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.cursorAt, last.id])).toString('base64url')
        : null;
    return { items: page.map(summaryOf), nextCursor };
  });
}

export async function getInvoice(
  database: AppDatabase,
  context: TenantContext,
  invoiceId: string,
): Promise<InvoiceDetail> {
  requireView(context);
  const parsedId = idSchema.safeParse(invoiceId);
  if (!parsedId.success) throw new AppError('NOT_FOUND');
  const id = parsedId.data;
  return withAccountTx(database, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, id)));
    if (!row) throw new AppError('NOT_FOUND');
    const lines = await readLines(tx, id);
    const [period] = row.billingPeriodId
      ? await tx.select().from(billingPeriods).where(eq(billingPeriods.id, row.billingPeriodId))
      : [];
    let minorUnitExponent: number | null = null;
    try {
      minorUnitExponent = await precision(tx, row);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
    return {
      ...summaryOf(row),
      source: {
        billingPeriodId: row.billingPeriodId,
        planVersionId: row.planVersionId,
        rateCardId: row.rateCardId,
        startsAt: period?.startsAt ?? null,
        endsAt: period?.endsAt ?? null,
      },
      subtotalMicros: row.subtotalMicros,
      taxMicros: row.taxMicros,
      minorUnitExponent,
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        kind: l.kind,
        meter: l.meter,
        quantity: l.quantity,
        unit: l.unit,
        unitPriceMicros: l.unitPriceMicros,
        amountMicros: l.amountMicros,
      })),
      version: row.version,
    };
  });
}

export type DueWork = {
  closedPeriods: number;
  draftedInvoices: number;
  refusedCode: string | null;
};

/**
 * Service only, from the billing cycle. For each period past its end: sums usage through the port, prices
 * the overage from the period's own card, and writes a draft. No approved card, a missing ledger, or a
 * missing tax treatment leaves the draft unwritten with `refusedCode`, audited once, and billing stops there
 * rather than sending anything wrong. A period that cannot be billed stays open and is tried again.
 */
export async function draftDuePeriodInvoices(
  database: AppDatabase,
  context: TenantContext,
  ports: { usage: UsageLedgerPort; agents?: AgentHaltPort },
  now: Date,
): Promise<DueWork> {
  requireService(context);
  if (!Number.isFinite(now.getTime())) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await orgLock(tx, context);
    let closedPeriods = 0;
    let draftedInvoices = 0;
    let refusedCode: string | null = null;
    while (closedPeriods < 100) {
      const [period] = await tx
        .select()
        .from(billingPeriods)
        .where(
          and(
            eq(billingPeriods.organizationId, context.organizationId),
            eq(billingPeriods.status, 'open'),
            lte(billingPeriods.endsAt, now),
          ),
        )
        .orderBy(asc(billingPeriods.startsAt), asc(billingPeriods.id))
        .limit(1)
        .for('update');
      if (!period) break;
      try {
        await tx.transaction(async (scoped) => {
          const plan = await loadPlanTerms(scoped, period.planVersionId);
          if (!plan || plan.minorUnitExponent === null) throw new AppError('PLAN_NOT_AVAILABLE');
          const account = await billingAccount(scoped, context);
          const chosen = await treatment(scoped, account);
          const usage = await ports.usage.sumForPeriod(scoped, context, {
            from: period.startsAt,
            to: period.endsAt,
          });
          let priced: Parameters<typeof buildPeriodInvoice>[1] = [];
          if (plan.commercialMode === 'cloud') {
            if (!period.rateCardId || period.rateCardId !== plan.rateCardId)
              throw new AppError('RATE_CARD_NOT_APPROVED');
            const card = await requirePublishedRateCard(scoped, period.rateCardId);
            if (
              card.currency !== plan.currency ||
              card.minorUnitExponent !== plan.minorUnitExponent
            )
              throw new AppError('RATE_CARD_NOT_APPROVED');
            const result = priceUsage(card, usage, period.startsAt);
            if (!result.ok) throw new AppError('RATE_CARD_NOT_APPROVED');
            priced = result.meters;
          } else if (usage.length) throw new AppError('INVALID_INPUT');
          const draft = buildPeriodInvoice(plan, priced, plan.minorUnitExponent);
          const [created] = await scoped
            .insert(invoices)
            .values({
              organizationId: context.organizationId,
              kind: 'subscription',
              currency: draft.currency,
              subtotalMicros: draft.subtotalMicros,
              taxMicros: draft.taxMicros,
              totalMicros: draft.totalMicros,
              subscriptionId: period.subscriptionId,
              billingPeriodId: period.id,
              planVersionId: period.planVersionId,
              rateCardId: period.rateCardId,
              taxTreatmentId: chosen.id,
            })
            .returning({ id: invoices.id });
          await writeLines(scoped, context, created!.id, {
            ...draft,
            lines: draft.lines.map((l) =>
              l.kind === 'usage' ? { ...l, usageRef: `billing_period:${period.id}` } : l,
            ),
          });
          await scoped
            .update(billingPeriods)
            .set({ status: 'closed', closedAt: now })
            .where(eq(billingPeriods.id, period.id));
          await advanceSubscriptionInTx(
            scoped,
            context,
            { subscriptionId: period.subscriptionId, now },
            ports.agents,
          );
        });
        closedPeriods += 1;
        draftedInvoices += 1;
      } catch (error) {
        if (error instanceof UsageUnavailable) refusedCode = 'USAGE_UNAVAILABLE';
        else if (error instanceof AppError) refusedCode = error.code;
        else throw error;
        const targetRef = `billing_period:${period.id}`;
        const [already] = await tx
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.organizationId, context.organizationId),
              eq(auditEvents.action, 'billing.invoice_refused'),
              eq(auditEvents.targetRef, targetRef),
              eq(auditEvents.safeReason, refusedCode),
            ),
          )
          .limit(1);
        if (!already)
          await appendAudit(tx, {
            organizationId: context.organizationId,
            actorType: 'service',
            action: 'billing.invoice_refused',
            targetRef,
            decision: 'deny',
            safeReason: refusedCode,
          });
        break;
      }
    }
    return { closedPeriods, draftedInvoices, refusedCode };
  });
}

/** Service only. Every draft waiting for tax, for the Activity that asks the port. IDs only. */
export async function listDraftsNeedingTax(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly string[]> {
  requireService(context);
  return withAccountTx(database, context, async (tx) =>
    (
      await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(eq(invoices.organizationId, context.organizationId), eq(invoices.status, 'draft')),
        )
        .orderBy(asc(invoices.createdAt), asc(invoices.id))
        .limit(100)
    ).map((row) => row.id),
  );
}

export type TaxQuestion = {
  questionHash: string;
  invoiceId: string;
  treatmentId: string;
  treatment: 'provider_computed' | 'not_collected';
  input: import('@ensemus/saas/tax').TaxInput;
};

/** Service only. Null if the invoice is no longer a draft, or TAX_TREATMENT_MISSING if nothing is approved. */
export async function loadTaxQuestion(
  database: AppDatabase,
  context: TenantContext,
  invoiceId: string,
): Promise<TaxQuestion | null> {
  requireService(context);
  const id = idOf(invoiceId);
  return withAccountTx(database, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, id)));
    if (!row) throw new AppError('NOT_FOUND');
    return row.status === 'draft' ? taxQuestionInTx(tx, context, row) : null;
  });
}

/**
 * Service only. Writes the tax, the bill-to snapshot, the next number and the due date, and opens the invoice
 * in one transaction, and emits INVOICE_ISSUED. A repeat finds it open and changes nothing. The due date
 * comes from the plan's `paymentTermsDays`, and a top-up falls due when issued.
 */
export async function issueInvoice(
  database: AppDatabase,
  context: TenantContext,
  input: {
    invoiceId: string;
    tax: { taxMicros: bigint; providerRef: string | null; questionHash?: string };
  },
): Promise<'issued' | 'already_issued'> {
  requireService(context);
  const id = idOf(input.invoiceId);
  if (
    typeof input.tax.taxMicros !== 'bigint' ||
    input.tax.taxMicros < 0n ||
    input.tax.taxMicros > 9223372036854775807n ||
    (input.tax.providerRef !== null &&
      (typeof input.tax.providerRef !== 'string' ||
        !input.tax.providerRef ||
        input.tax.providerRef.length > 200 ||
        /[\r\n\0]/.test(input.tax.providerRef)))
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await orgLock(tx, context);
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, id)))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.status !== 'draft') return 'already_issued';
    const question = await taxQuestionInTx(tx, context, row);
    if (question.treatment === 'not_collected') {
      if (input.tax.taxMicros !== 0n || input.tax.providerRef !== null)
        throw new AppError('INVALID_INPUT');
    } else if (!input.tax.providerRef || input.tax.questionHash !== question.questionHash)
      throw new AppError('TAX_PROVIDER_UNAVAILABLE');
    const account = await billingAccount(tx, context);
    const lines = await readLines(tx, id);
    const draft = draftOf(row, lines);
    if (
      !invoiceAddsUp(draft) ||
      draft.taxMicros !== 0n ||
      draft.lines.some((l) => l.kind === 'tax')
    )
      throw new AppError('INVALID_INPUT');
    const exponent = await precision(tx, row);
    if (row.kind === 'top_up') {
      const [order] = row.topUpId
        ? await tx.select().from(topUps).where(eq(topUps.id, row.topUpId))
        : [];
      if (
        !order ||
        order.currency !== row.currency ||
        buildTopUpInvoice({ priceMicros: order.priceMicros, currency: order.currency }, exponent)
          .subtotalMicros !== draft.subtotalMicros
      )
        throw new AppError('INVALID_INPUT');
      const expected = buildTopUpInvoice(
        { priceMicros: order.priceMicros, currency: order.currency },
        exponent,
      );
      if (
        draft.lines.length !== expected.lines.length ||
        draft.lines.some(
          (l, i) =>
            l.kind !== expected.lines[i]!.kind ||
            l.amountMicros !== expected.lines[i]!.amountMicros,
        )
      )
        throw new AppError('INVALID_INPUT');
    } else {
      const plan = row.planVersionId ? await loadPlanTerms(tx, row.planVersionId) : null;
      const fees = draft.lines.filter((l) => l.kind === 'platform_fee');
      if (
        !plan ||
        plan.currency !== row.currency ||
        fees.length !== 1 ||
        fees[0]!.amountMicros !== plan.platformFeeMicros ||
        draft.lines.some(
          (l) =>
            !['platform_fee', 'usage', 'rounding'].includes(l.kind) ||
            (l.kind === 'usage' &&
              (plan.commercialMode === 'byom' ||
                l.amountMicros !== 0n ||
                l.unitPriceMicros !== null)),
        )
      )
        throw new AppError('INVALID_INPUT');
      if (buildPeriodInvoice(plan, [], exponent).subtotalMicros !== draft.subtotalMicros)
        throw new AppError('INVALID_INPUT');
    }
    const final = withTax(
      draft,
      { taxMicros: input.tax.taxMicros, currency: row.currency },
      exponent,
    );
    if (final.totalMicros > 9223372036854775807n) throw new AppError('INVALID_INPUT');
    const [highest] = await tx
      .select({ n: sql<number>`coalesce(max(${invoices.invoiceNumber}),0)::bigint` })
      .from(invoices)
      .where(eq(invoices.organizationId, context.organizationId));
    const invoiceNumber = Number(highest?.n ?? 0) + 1;
    if (!Number.isSafeInteger(invoiceNumber)) throw new AppError('INVALID_STATE');
    const issuedAt = new Date();
    let dueAt = issuedAt;
    if (row.kind === 'subscription') {
      const plan = row.planVersionId ? await loadPlanTerms(tx, row.planVersionId) : null;
      if (!plan) throw new AppError('PLAN_NOT_AVAILABLE');
      dueAt = new Date(issuedAt);
      dueAt.setUTCDate(dueAt.getUTCDate() + plan.paymentTermsDays);
    }
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    await writeLines(tx, context, id, final);
    await tx
      .update(invoices)
      .set({
        status: 'open',
        invoiceNumber,
        subtotalMicros: final.subtotalMicros,
        taxMicros: final.taxMicros,
        totalMicros: final.totalMicros,
        taxTreatmentId: question.treatmentId,
        taxRef: input.tax.providerRef,
        billTo: {
          billing_name: account.billingName,
          billing_email: account.billingEmail,
          country_code: account.countryCode,
          region_code: account.regionCode,
          postal_code: account.postalCode,
          tax_id: account.taxId,
        },
        issuedAt,
        dueAt,
        version: row.version + 1,
        updatedAt: issuedAt,
      })
      .where(eq(invoices.id, id));
    await emit(tx, context, {
      eventType: INVOICE_ISSUED,
      aggregateType: AGGREGATE_INVOICE,
      aggregateId: id,
      aggregateVersion: row.version + 1,
      classification: 'internal',
      payload: { invoice_id: id },
    });
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
    await notify(
      tx,
      context,
      owners.map((o) => o.id),
      NOTIFY_INVOICE_ISSUED,
      invoiceTargetRef(id),
    );
    if (final.totalMicros === 0n) {
      // Explicit approved zero/rounded-zero terms need no processor and cannot create a >0 intent.
      await tx
        .update(invoices)
        .set({ status: 'paid', paidAt: issuedAt, version: row.version + 2 })
        .where(eq(invoices.id, id));
      await emit(tx, context, {
        eventType: INVOICE_PAID,
        aggregateType: AGGREGATE_INVOICE,
        aggregateId: id,
        aggregateVersion: row.version + 2,
        classification: 'internal',
        payload: { invoice_id: id },
      });
      await afterInvoicePaidInTx(tx, context, { invoiceId: id });
    }
    return 'issued';
  });
}

/** Called by top-ups, in its transaction. One line, for what the person agreed to. */
export async function createTopUpInvoiceInTx(
  tx: Tx,
  context: TenantContext,
  input: { topUpId: string; rateCardId: string; draft: DraftInvoice },
): Promise<{ invoiceId: string }> {
  requireView(context, true);
  const topUpId = idOf(input.topUpId);
  const cardId = idOf(input.rateCardId);
  const [order] = await tx
    .select()
    .from(topUps)
    .where(and(eq(topUps.organizationId, context.organizationId), eq(topUps.id, topUpId)))
    .for('update');
  if (!order || order.requestedByMembershipId !== context.membershipId)
    throw new AppError('NOT_FOUND');
  const [offer] = await tx.select().from(topUpOffers).where(eq(topUpOffers.id, order.offerId));
  if (!offer || offer.rateCardId !== cardId) throw new AppError('NOT_FOUND');
  const card = await requirePublishedRateCard(tx, cardId);
  const expected = buildTopUpInvoice(
    { priceMicros: order.priceMicros, currency: order.currency },
    card.minorUnitExponent,
  );
  if (
    card.currency !== order.currency ||
    !invoiceAddsUp(input.draft) ||
    input.draft.currency !== expected.currency ||
    input.draft.subtotalMicros !== expected.subtotalMicros ||
    input.draft.taxMicros !== 0n ||
    input.draft.lines.length !== expected.lines.length ||
    input.draft.lines.some(
      (l, i) =>
        l.kind !== expected.lines[i]!.kind || l.amountMicros !== expected.lines[i]!.amountMicros,
    )
  )
    throw new AppError('QUOTE_CHANGED');
  const [existing] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.topUpId, topUpId));
  if (existing) return { invoiceId: existing.id };
  const chosen = await treatment(tx, await billingAccount(tx, context));
  const [row] = await tx
    .insert(invoices)
    .values({
      organizationId: context.organizationId,
      kind: 'top_up',
      currency: expected.currency,
      subtotalMicros: expected.subtotalMicros,
      taxMicros: 0n,
      totalMicros: expected.totalMicros,
      topUpId,
      rateCardId: cardId,
      taxTreatmentId: chosen.id,
    })
    .returning({ id: invoices.id });
  await writeLines(tx, context, row!.id, expected);
  return { invoiceId: row!.id };
}

/** `billing.manage`, with a code. Only an unpaid invoice with no live payment. It is kept, marked void. */
export async function voidInvoice(
  database: AppDatabase,
  context: TenantContext,
  input: { invoiceId: string; reasonCode: string; expectedVersion: number },
): Promise<void> {
  requireView(context, true);
  const id = idOf(input.invoiceId);
  if (
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.reasonCode) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await orgLock(tx, context);
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, id)))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (row.status === 'void') return;
    if (!['draft', 'open', 'uncollectible'].includes(row.status))
      throw new AppError('INVOICE_NOT_PAYABLE');
    const [live] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.invoiceId, id),
          inArray(payments.status, ['ready', 'sending', 'reconciling', 'unknown', 'succeeded']),
        ),
      )
      .limit(1);
    if (live) throw new AppError('INVOICE_NOT_PAYABLE');
    await tx
      .update(invoices)
      .set({
        status: 'void',
        voidedAt: new Date(),
        voidReasonCode: input.reasonCode,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, id));
    await emit(tx, context, {
      eventType: INVOICE_VOIDED,
      aggregateType: AGGREGATE_INVOICE,
      aggregateId: id,
      aggregateVersion: row.version + 1,
      classification: 'internal',
      payload: { invoice_id: id, reason_code: input.reasonCode },
    });
  });
}
