import { randomUUID } from 'node:crypto';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  memberships,
  invoices,
  invoiceLines,
  billingPeriods,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { startSubscription, saveBillingAccount } from '@ensemus/application/saas/subscriptions';
import {
  draftDuePeriodInvoices,
  getInvoice,
  issueInvoice,
  listInvoices,
  loadTaxQuestion,
  voidInvoice,
} from '@ensemus/application/saas/invoices';
import { UsageUnavailable, type UsageLedgerPort } from '@ensemus/application/saas/ports';
import { eq, sql } from 'drizzle-orm';
import { roundToMinorUnit } from '@ensemus/saas/money';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asRole,
  seedBillingAccount,
  seedPlan,
  seedRateCard,
  seedTaxTreatment,
  testAmount,
  TEST_OPERATOR,
} from '../helpers/saas';
import { urls } from '../helpers/stack';

const empty: UsageLedgerPort = {
  listSince: async () => ({ entries: [], nextCursor: null }),
  sumForPeriod: async () => [],
};
const agents = {
  haltTenantAgents: async () => undefined,
  releaseTenantAgents: async () => undefined,
};
describe('invoices use pinned terms and immutable exact monetary totals', () => {
  const database = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });
  let other: TenantContext;
  async function tenant(mode: 'cloud' | 'byom' = 'byom') {
    const id = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values ($1,$2,$3)', [
      id,
      'Same invoice name',
      `${id}@example.invalid`,
    ]);
    const row = await createOrganization(database.db, {
      userId: id,
      name: 'Same invoice name',
      commercialMode: mode,
    });
    return resolveTenantContext(database.db, id, row.organizationId);
  }
  async function due(mode: 'cloud' | 'byom' = 'byom', countryCode = 'XX') {
    const owner = await tenant(mode);
    const context = createServiceContext(owner.organizationId);
    await seedBillingAccount(database.db, owner, { countryCode });
    const startsAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const card = mode === 'cloud' ? await seedRateCard({ approve: false }) : null;
    if (card)
      await asRole('ensemus_operator', async (client) => {
        await client.query(
          "update billing.rate_cards set status='approved',approved_by=$2,approved_at=now(),effective_from=$3 where id=$1",
          [card.rateCardId, TEST_OPERATOR, new Date(startsAt.getTime() - 1)],
        );
      });
    const plan = await seedPlan(card ? { mode: 'cloud', rateCard: card } : { mode: 'byom' });
    await startSubscription(database.db, context, { planVersionId: plan.planVersionId, startsAt });
    return { owner, context, card, plan };
  }
  beforeAll(async () => {
    await auth.connect();
    other = await tenant();
    await seedTaxTreatment();
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  it('members see no invoice list or detail, and cross-tenant detail is missing', async () => {
    const who = await due();
    await withTenantTx(database.db, who.owner, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: who.owner.organizationId, userId: other.userId, role: 'member' }),
    );
    const member = await resolveTenantContext(database.db, other.userId, who.owner.organizationId);
    await expect(listInvoices(database.db, member, {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getInvoice(database.db, member, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await draftDuePeriodInvoices(database.db, who.context, { usage: empty, agents }, new Date());
    const [invoice] = (await listInvoices(database.db, who.owner, {})).items;
    await expect(getInvoice(database.db, other, invoice!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('QA-027: BYOM bills its platform fee once; repeat sweep and issue change nothing', async () => {
    const who = await due();
    expect(
      await draftDuePeriodInvoices(database.db, who.context, { usage: empty, agents }, new Date()),
    ).toMatchObject({ closedPeriods: 1, draftedInvoices: 1, refusedCode: null });
    expect(
      await draftDuePeriodInvoices(database.db, who.context, { usage: empty, agents }, new Date()),
    ).toMatchObject({ closedPeriods: 0, draftedInvoices: 0 });
    const [invoice] = (await listInvoices(database.db, who.owner, {})).items;
    expect(
      await issueInvoice(database.db, who.context, {
        invoiceId: invoice!.id,
        tax: { taxMicros: 0n, providerRef: null },
      }),
    ).toBe('issued');
    expect(
      await issueInvoice(database.db, who.context, {
        invoiceId: invoice!.id,
        tax: { taxMicros: 0n, providerRef: null },
      }),
    ).toBe('already_issued');
    const detail = await getInvoice(database.db, who.owner, invoice!.id);
    expect(detail.totalMicros).toBe(roundToMinorUnit(who.plan.platformFeeMicros, 2));
    expect(detail.lines.some((l) => l.kind === 'usage')).toBe(false);
    expect(detail.source.planVersionId).toBe(who.plan.planVersionId);
    expect(detail.invoiceNumber).toBe(1);
    await expect(
      withTenantTx(database.db, who.owner, (tx) =>
        tx
          .update(invoices)
          .set({ totalMicros: detail.totalMicros + 1n, subtotalMicros: detail.subtotalMicros + 1n })
          .where(eq(invoices.id, detail.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(database.db, who.owner, (tx) =>
        tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, detail.id)),
      ),
    ).rejects.toThrow();
    await voidInvoice(database.db, who.owner, {
      invoiceId: detail.id,
      reasonCode: 'TEST_VOID',
      expectedVersion: detail.version,
    });
    expect((await getInvoice(database.db, who.owner, detail.id)).status).toBe('void');
  });
  it('Cloud usage is a card-backed statement, never a second charge for prepaid credits', async () => {
    const who = await due('cloud');
    const usage = {
      ...empty,
      sumForPeriod: async () => [{ meter: who.card!.meter, unit: 'unit', quantity: 17n }],
    };
    await draftDuePeriodInvoices(database.db, who.context, { usage, agents }, new Date());
    const [row] = (await listInvoices(database.db, who.owner, {})).items;
    const detail = await getInvoice(database.db, who.owner, row!.id);
    expect(detail.totalMicros).toBe(roundToMinorUnit(who.plan.platformFeeMicros, 2));
    expect(detail.lines.find((l) => l.kind === 'usage')).toMatchObject({
      meter: who.card!.meter,
      quantity: 17n,
      amountMicros: 0n,
      unitPriceMicros: null,
    });
  });
  it('unavailable ledger and missing adviser decision leave the period open with one refusal audit', async () => {
    const who = await due();
    const unavailable = {
      ...empty,
      sumForPeriod: async () => {
        throw new UsageUnavailable();
      },
    };
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (
          await draftDuePeriodInvoices(
            database.db,
            who.context,
            { usage: unavailable, agents },
            new Date(),
          )
        ).refusedCode,
      ).toBe('USAGE_UNAVAILABLE');
    expect((await listInvoices(database.db, who.owner, {})).items).toHaveLength(0);
    const evidence = await withTenantTx(database.db, who.context, (tx) =>
      tx.execute(
        sql`select (select count(*)::int from billing.billing_periods where status='open') as open,(select count(*)::int from governance.audit_events where action='billing.invoice_refused') as refusals`,
      ),
    );
    expect(evidence.rows[0]).toEqual({ open: 1, refusals: 1 });
    const missing = await due('byom', 'XZ');
    expect(
      (
        await draftDuePeriodInvoices(
          database.db,
          missing.context,
          { usage: empty, agents },
          new Date(),
        )
      ).refusedCode,
    ).toBe('TAX_TREATMENT_MISSING');
    expect((await listInvoices(database.db, missing.owner, {})).items).toHaveLength(0);
  });
  it('a changed billing address invalidates computed tax before invoice issuance', async () => {
    await seedTaxTreatment({ countryCode: 'XY', treatment: 'provider_computed' });
    const who = await due('byom', 'XY');
    await draftDuePeriodInvoices(database.db, who.context, { usage: empty, agents }, new Date());
    const [row] = (await listInvoices(database.db, who.owner, {})).items;
    const question = (await loadTaxQuestion(database.db, who.context, row!.id))!;
    await saveBillingAccount(database.db, who.owner, {
      billingName: 'New test payer',
      billingEmail: 'new@example.invalid',
      countryCode: 'XY',
      regionCode: '',
      postalCode: null,
      taxId: null,
      expectedVersion: 1,
    });
    await expect(
      issueInvoice(database.db, who.context, {
        invoiceId: row!.id,
        tax: {
          taxMicros: testAmount(),
          providerRef: 'test-provider-ref',
          questionHash: question.questionHash,
        },
      }),
    ).rejects.toMatchObject({ code: 'TAX_PROVIDER_UNAVAILABLE' });
    expect((await getInvoice(database.db, who.owner, row!.id)).status).toBe('draft');
    const fresh = (await loadTaxQuestion(database.db, who.context, row!.id))!;
    expect(fresh.questionHash).not.toBe(question.questionHash);
    expect(fresh.input.idempotencyKey).not.toBe(question.input.idempotencyKey);
    expect(
      await issueInvoice(database.db, who.context, {
        invoiceId: row!.id,
        tax: {
          taxMicros: testAmount(),
          providerRef: 'test-provider-ref',
          questionHash: fresh.questionHash,
        },
      }),
    ).toBe('issued');
  });
  it('tampered line totals cannot open even through a direct application-role update', async () => {
    const who = await due();
    await draftDuePeriodInvoices(database.db, who.context, { usage: empty, agents }, new Date());
    const [row] = await withTenantTx(database.db, who.context, (tx) => tx.select().from(invoices));
    await withTenantTx(database.db, who.context, async (tx) => {
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, row!.id));
      await tx.insert(invoiceLines).values({
        organizationId: who.owner.organizationId,
        invoiceId: row!.id,
        lineNo: 1,
        kind: 'platform_fee',
        amountMicros: row!.subtotalMicros + 1n,
      });
    });
    await expect(
      issueInvoice(database.db, who.context, {
        invoiceId: row!.id,
        tax: { taxMicros: 0n, providerRef: null },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      withTenantTx(database.db, who.context, (tx) =>
        tx
          .update(invoices)
          .set({
            status: 'open',
            invoiceNumber: 1,
            issuedAt: new Date(),
            dueAt: new Date(),
            billTo: { test: true },
          })
          .where(eq(invoices.id, row!.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(database.db, who.context, (tx) =>
        tx.insert(invoices).values({ ...row!, id: randomUUID() }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await withTenantTx(database.db, who.context, (tx) =>
          tx.select().from(billingPeriods).where(eq(billingPeriods.id, row!.billingPeriodId!)),
        )
      )[0]!.status,
    ).toBe('closed');
  });
});
