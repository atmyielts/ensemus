// M8 tables: billing, retention, legal hold, offboarding, support and incidents (ADR-032). Roles, grants,
// RLS and every trigger are in reviewed SQL, migration 0501. Prices and rules are data here: no row ships
// with the product, and no default amount exists anywhere in this file.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './schema';
import { killSwitches } from './schema-ai';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const when = () => timestamp({ withTimezone: true });
const tenantId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id);
const uuidPk = () => uuid().primaryKey().defaultRandom();
const micros = () => bigint({ mode: 'bigint' });
const version = () => bigint({ mode: 'number' }).notNull().default(1);

export const billingSchema = pgSchema('billing');
export const lifecycleSchema = pgSchema('lifecycle');
export const supportSchema = pgSchema('support');
export const operationsSchema = pgSchema('operations');

// --- The price list. Global, entered by the operator, and immutable once approved.

/** One version of a price list. Nothing can be billed from a draft, which the database also refuses. */
export const billingRateCards = billingSchema.table(
  'rate_cards',
  {
    id: uuidPk(),
    code: text().notNull(),
    version: integer().notNull(),
    status: text().notNull().default('draft'),
    currency: text().notNull(),
    /** How many decimal places this currency's smallest unit has. Data, since it is not ours to assume. */
    minorUnitExponent: integer().notNull(),
    effectiveFrom: when(),
    draftedBy: text().notNull(),
    approvedBy: text(),
    approvedAt: when(),
    retiredAt: when(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('rate_cards_code_version').on(t.code, t.version),
    check('rate_cards_status', sql`${t.status} in ('draft','approved','retired')`),
    check('rate_cards_code_format', sql`${t.code} ~ '^[a-z][a-z0-9-]{1,63}$'`),
    check('rate_cards_version_check', sql`${t.version} > 0`),
    check('rate_cards_currency', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('rate_cards_exponent', sql`${t.minorUnitExponent} between 0 and 4`),
    check(
      'rate_cards_approved',
      sql`${t.status} = 'draft' OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.effectiveFrom} IS NOT NULL)`,
    ),
  ],
);

export const rateCardLines = billingSchema.table(
  'rate_card_lines',
  {
    rateCardId: uuid()
      .notNull()
      .references(() => billingRateCards.id),
    meter: text().notNull(),
    unit: text().notNull(),
    microcreditsPerUnit: bigint({ mode: 'bigint' }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'rate_card_lines_pk', columns: [t.rateCardId, t.meter] }),
    check('rate_card_lines_meter', sql`${t.meter} ~ '^[a-z][a-z0-9_.]{1,63}$'`),
    check('rate_card_lines_price', sql`${t.microcreditsPerUnit} >= 0`),
  ],
);

export const topUpOffers = billingSchema.table(
  'top_up_offers',
  {
    id: uuidPk(),
    rateCardId: uuid()
      .notNull()
      .references(() => billingRateCards.id),
    code: text().notNull(),
    microcredits: bigint({ mode: 'bigint' }).notNull(),
    priceMicros: micros().notNull(),
  },
  (t) => [
    unique('top_up_offers_code').on(t.rateCardId, t.code),
    check('top_up_offers_microcredits', sql`${t.microcredits} > 0`),
    check('top_up_offers_price', sql`${t.priceMicros} > 0`),
  ],
);

export const plans = billingSchema.table(
  'plans',
  {
    id: uuidPk(),
    code: text().notNull().unique('plans_code_unique'),
    commercialMode: text().notNull(),
    displayName: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('plans_mode', sql`${t.commercialMode} in ('cloud','byom')`),
    check('plans_code_format', sql`${t.code} ~ '^[a-z][a-z0-9-]{1,63}$'`),
  ],
);

/** A plan's terms at one version. A Cloud plan needs an approved card, and a BYOM plan may have none. */
export const planVersions = billingSchema.table(
  'plan_versions',
  {
    id: uuidPk(),
    planId: uuid()
      .notNull()
      .references(() => plans.id),
    version: integer().notNull(),
    status: text().notNull().default('draft'),
    currency: text().notNull(),
    billingInterval: text().notNull(),
    /** Days from issue until an invoice falls due. A commercial term, so it has no default. */
    paymentTermsDays: integer().notNull(),
    /** Null only for a legacy plan awaiting operator review. Approval and issuance require it. */
    minorUnitExponent: integer(),
    platformFeeMicros: micros().notNull(),
    includedMicrocredits: bigint({ mode: 'bigint' }),
    rateCardId: uuid().references(() => billingRateCards.id),
    overagePolicy: text(),
    features: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    maxActiveMembers: integer(),
    draftedBy: text().notNull(),
    approvedBy: text(),
    approvedAt: when(),
    retiredAt: when(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('plan_versions_number').on(t.planId, t.version),
    check('plan_versions_status', sql`${t.status} in ('draft','approved','retired')`),
    check('plan_versions_version_check', sql`${t.version} > 0`),
    check('plan_versions_currency', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('plan_versions_interval', sql`${t.billingInterval} in ('month','year')`),
    check('plan_versions_terms', sql`${t.paymentTermsDays} >= 0`),
    check(
      'plan_versions_precision',
      sql`${t.minorUnitExponent} IS NULL OR ${t.minorUnitExponent} between 0 and 4`,
    ),
    check('plan_versions_fee', sql`${t.platformFeeMicros} >= 0`),
    check(
      'plan_versions_included',
      sql`${t.includedMicrocredits} IS NULL OR ${t.includedMicrocredits} >= 0`,
    ),
    check(
      'plan_versions_overage',
      sql`${t.overagePolicy} IS NULL OR ${t.overagePolicy} in ('pause','explicit_top_up')`,
    ),
    check('plan_versions_members', sql`${t.maxActiveMembers} IS NULL OR ${t.maxActiveMembers} > 0`),
    check(
      'plan_versions_approved',
      sql`${t.status} = 'draft' OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)`,
    ),
  ],
);

/** The published rules for failed payments. Without an approved one, nothing automatic happens. */
export const collectionPolicies = billingSchema.table(
  'collection_policies',
  {
    id: uuidPk(),
    version: integer().notNull().unique('collection_policies_version_unique'),
    status: text().notNull().default('draft'),
    /** Where the published terms these rules come from can be read. */
    termsRef: text().notNull(),
    /** `CollectionStep[]` from @ensemus/saas/payment, checked when it is entered. */
    steps: jsonb().notNull().default([]),
    draftedBy: text().notNull(),
    approvedBy: text(),
    approvedAt: when(),
    retiredAt: when(),
    createdAt: createdAt(),
  },
  (t) => [
    check('collection_policies_status', sql`${t.status} in ('draft','approved','retired')`),
    check(
      'collection_policies_approved',
      sql`${t.status} = 'draft' OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)`,
    ),
  ],
);

/** What an adviser said about a place. With no approved row for a place, invoices there do not issue. */
export const taxTreatments = billingSchema.table(
  'tax_treatments',
  {
    id: uuidPk(),
    countryCode: text().notNull(),
    regionCode: text().notNull().default(''),
    version: integer().notNull(),
    status: text().notNull().default('draft'),
    treatment: text().notNull(),
    adviserRef: text().notNull(),
    draftedBy: text().notNull(),
    approvedBy: text(),
    approvedAt: when(),
    retiredAt: when(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('tax_treatments_key').on(t.countryCode, t.regionCode, t.version),
    check('tax_treatments_status', sql`${t.status} in ('draft','approved','retired')`),
    check('tax_treatments_treatment', sql`${t.treatment} in ('provider_computed','not_collected')`),
    check('tax_treatments_country', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check(
      'tax_treatments_approved',
      sql`${t.status} = 'draft' OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)`,
    ),
  ],
);

/** A model provider's bill, entered by the operator, set against what the usage ledger recorded. */
export const providerBills = billingSchema.table(
  'provider_bills',
  {
    id: uuidPk(),
    providerKind: text().notNull(),
    periodStart: when().notNull(),
    periodEnd: when().notNull(),
    currency: text().notNull(),
    amountMicros: micros().notNull(),
    sourceRef: text().notNull(),
    enteredBy: text().notNull(),
    status: text().notNull().default('open'),
    ledgerCostMicros: micros(),
    differenceMicros: micros(),
    reviewedBy: text(),
    reviewedAt: when(),
    createdAt: createdAt(),
  },
  (t) => [
    check('provider_bills_status', sql`${t.status} in ('open','reconciled','disputed')`),
    check('provider_bills_period', sql`${t.periodEnd} > ${t.periodStart}`),
    check('provider_bills_currency', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/** What an operator did to a global table. A tenant's own audit log holds what they did to a tenant. */
export const operatorActions = billingSchema.table(
  'operator_actions',
  {
    id: uuidPk(),
    action: text().notNull(),
    targetRef: text().notNull(),
    operatorRef: text().notNull(),
    reasonCode: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('operator_actions_action', sql`${t.action} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`),
  ],
);

// --- One tenant's billing. Nothing here has a foreign key to a membership: these records outlive it.

/**
 * Who pays, and how a processor knows them. The tenant is found from `customerRefHash`, by way of
 * withPaymentCustomerTx, and never from anything a processor's event says.
 */
export const billingAccounts = billingSchema.table(
  'billing_accounts',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    billingName: text().notNull(),
    billingEmail: text().notNull(),
    countryCode: text().notNull(),
    regionCode: text().notNull().default(''),
    postalCode: text(),
    taxId: text(),
    processor: text(),
    processorCustomerRef: text(),
    customerRefHash: text(),
    version: version(),
    createdByMembershipId: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'billing_accounts_pk', columns: [t.organizationId, t.id] }),
    unique('billing_accounts_one_per_tenant').on(t.organizationId),
    uniqueIndex('billing_accounts_customer_ref')
      .on(t.processor, t.customerRefHash)
      .where(sql`${t.customerRefHash} IS NOT NULL`),
    check('billing_accounts_country', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check(
      'billing_accounts_processor_pair',
      sql`(${t.processor} IS NULL) = (${t.customerRefHash} IS NULL)`,
    ),
  ],
);

export const subscriptions = billingSchema.table(
  'subscriptions',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    planVersionId: uuid()
      .notNull()
      .references(() => planVersions.id),
    status: text().notNull().default('active'),
    currentPeriodStart: when().notNull(),
    currentPeriodEnd: when().notNull(),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    canceledAt: when(),
    collectionPolicyId: uuid().references(() => collectionPolicies.id),
    createdByRef: text().notNull(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'subscriptions_pk', columns: [t.organizationId, t.id] }),
    uniqueIndex('subscriptions_one_live')
      .on(t.organizationId)
      .where(sql`${t.status} <> 'canceled'`),
    check('subscriptions_status', sql`${t.status} in ('active','past_due','canceled')`),
    check('subscriptions_period', sql`${t.currentPeriodEnd} > ${t.currentPeriodStart}`),
  ],
);

export const subscriptionChanges = billingSchema.table(
  'subscription_changes',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    subscriptionId: uuid().notNull(),
    kind: text().notNull(),
    fromPlanVersionId: uuid().references(() => planVersions.id),
    toPlanVersionId: uuid().references(() => planVersions.id),
    effectiveAt: when().notNull(),
    /** Counts over a new plan's limits, by limit. Excess is made read-only, and never removed. */
    excess: jsonb().notNull().default({}),
    actorRef: text().notNull(),
    reasonCode: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'subscription_changes_pk', columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'subscription_changes_subscription',
      columns: [t.organizationId, t.subscriptionId],
      foreignColumns: [subscriptions.organizationId, subscriptions.id],
    }),
    check(
      'subscription_changes_kind',
      sql`${t.kind} in ('created','plan_changed','cancel_requested','cancel_withdrawn','canceled')`,
    ),
  ],
);

/** Every change to a tenant's standing. The database refuses the change without this row beside it. */
export const standingChanges = billingSchema.table(
  'standing_changes',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    fromLifecycle: text().notNull(),
    toLifecycle: text().notNull(),
    reasonCode: text().notNull(),
    collectionPolicyId: uuid().references(() => collectionPolicies.id),
    actorType: text().notNull(),
    actorRef: text().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'standing_changes_pk', columns: [t.organizationId, t.id] }),
    check('standing_changes_actor', sql`${t.actorType} in ('operator','system','membership')`),
  ],
);

/** Private witnesses of real standing INSERTs and their separately owned M4 stop. No runtime table grants. */
export const standingStopReceipts = lifecycleSchema.table(
  'standing_stop_receipts',
  {
    organizationId: uuid().notNull(),
    standingChangeId: uuid().notNull(),
    birthTransaction: text().notNull(),
    appliedTransaction: text(),
    appliedAt: when(),
    requiresEffect: boolean().notNull().default(false),
    releaseRequested: boolean(),
    switchId: uuid().unique('standing_stop_switch_unique'),
    settledAt: when(),
  },
  (t) => [
    primaryKey({
      name: 'standing_stop_receipts_pk',
      columns: [t.organizationId, t.standingChangeId],
    }),
    foreignKey({
      name: 'standing_stop_org',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'standing_stop_switch',
      columns: [t.switchId],
      foreignColumns: [killSwitches.id],
    }),
    foreignKey({
      name: 'standing_stop_source',
      columns: [t.organizationId, t.standingChangeId],
      foreignColumns: [standingChanges.organizationId, standingChanges.id],
    }),
    check('standing_stop_applied', sql`(${t.appliedTransaction} is null)=(${t.appliedAt} is null)`),
    check(
      'standing_stop_settlement',
      sql`${t.settledAt} is null or ${t.appliedTransaction} is not null`,
    ),
  ],
);

export const billingPeriods = billingSchema.table(
  'billing_periods',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    subscriptionId: uuid().notNull(),
    planVersionId: uuid()
      .notNull()
      .references(() => planVersions.id),
    rateCardId: uuid().references(() => billingRateCards.id),
    startsAt: when().notNull(),
    endsAt: when().notNull(),
    status: text().notNull().default('open'),
    closedAt: when(),
  },
  (t) => [
    primaryKey({ name: 'billing_periods_pk', columns: [t.organizationId, t.id] }),
    unique('billing_periods_start').on(t.organizationId, t.subscriptionId, t.startsAt),
    foreignKey({
      name: 'billing_periods_subscription',
      columns: [t.organizationId, t.subscriptionId],
      foreignColumns: [subscriptions.organizationId, subscriptions.id],
    }),
    check('billing_periods_status', sql`${t.status} in ('open','closed')`),
    check('billing_periods_range', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

/** Moved only by the trigger on `credit_ledger`, so a balance is always what its ledger adds up to. */
export const creditAccounts = billingSchema.table('credit_accounts', {
  organizationId: uuid()
    .primaryKey()
    .references(() => organizations.id),
  balanceMicrocredits: bigint({ mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  /** How far M4's ledger has been read, in the port's own terms. Losing it only repeats safe work. */
  usageCursor: text(),
  version: version(),
  updatedAt: updatedAt(),
});

/** One person's decision to pay one exact price. `quoteHash` is what they saw. Nothing starts one alone. */
export const topUps = billingSchema.table(
  'top_ups',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    offerId: uuid()
      .notNull()
      .references(() => topUpOffers.id),
    microcredits: bigint({ mode: 'bigint' }).notNull(),
    priceMicros: micros().notNull(),
    currency: text().notNull(),
    quoteHash: text().notNull(),
    requestKey: text().notNull(),
    status: text().notNull().default('requested'),
    requestedByMembershipId: uuid().notNull(),
    invoiceId: uuid(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'top_ups_pk', columns: [t.organizationId, t.id] }),
    unique('top_ups_request').on(t.organizationId, t.requestKey),
    check(
      'top_ups_status',
      sql`${t.status} in ('requested','invoiced','paid','credited','failed','cancelled')`,
    ),
  ],
);

export const creditLedger = billingSchema.table(
  'credit_ledger',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    idempotencyKey: text().notNull(),
    kind: text().notNull(),
    amountMicrocredits: bigint({ mode: 'bigint' }).notNull(),
    billingPeriodId: uuid(),
    rateCardId: uuid().references(() => billingRateCards.id),
    usageRef: text(),
    topUpId: uuid(),
    correctsId: uuid(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'credit_ledger_pk', columns: [t.organizationId, t.id] }),
    unique('credit_ledger_key').on(t.organizationId, t.idempotencyKey),
    foreignKey({
      name: 'credit_ledger_period',
      columns: [t.organizationId, t.billingPeriodId],
      foreignColumns: [billingPeriods.organizationId, billingPeriods.id],
    }),
    foreignKey({
      name: 'credit_ledger_top_up',
      columns: [t.organizationId, t.topUpId],
      foreignColumns: [topUps.organizationId, topUps.id],
    }),
    foreignKey({
      name: 'credit_ledger_corrects',
      columns: [t.organizationId, t.correctsId],
      foreignColumns: [t.organizationId, t.id],
    }),
    check(
      'credit_ledger_kind',
      sql`${t.kind} in ('allocation','top_up','consumption','expiry','correction')`,
    ),
    check(
      'credit_ledger_sign',
      sql`(${t.kind} in ('allocation','top_up') AND ${t.amountMicrocredits} > 0) OR (${t.kind} in ('consumption','expiry') AND ${t.amountMicrocredits} <= 0) OR (${t.kind} = 'correction' AND ${t.correctsId} IS NOT NULL)`,
    ),
  ],
);

export const invoices = billingSchema.table(
  'invoices',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    invoiceNumber: bigint({ mode: 'number' }),
    kind: text().notNull(),
    status: text().notNull().default('draft'),
    currency: text().notNull(),
    subtotalMicros: micros()
      .notNull()
      .default(sql`0`),
    taxMicros: micros()
      .notNull()
      .default(sql`0`),
    totalMicros: micros()
      .notNull()
      .default(sql`0`),
    subscriptionId: uuid(),
    billingPeriodId: uuid(),
    topUpId: uuid(),
    planVersionId: uuid().references(() => planVersions.id),
    rateCardId: uuid().references(() => billingRateCards.id),
    taxTreatmentId: uuid().references(() => taxTreatments.id),
    taxRef: text(),
    /** The name and address as they were at issue, so a later change does not rewrite an old invoice. */
    billTo: jsonb(),
    issuedAt: when(),
    dueAt: when(),
    paidAt: when(),
    voidedAt: when(),
    voidReasonCode: text(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'invoices_pk', columns: [t.organizationId, t.id] }),
    unique('invoices_number').on(t.organizationId, t.invoiceNumber),
    uniqueIndex('invoices_one_per_period')
      .on(t.organizationId, t.billingPeriodId)
      .where(sql`${t.billingPeriodId} IS NOT NULL AND ${t.status} <> 'void'`),
    uniqueIndex('invoices_one_per_top_up')
      .on(t.organizationId, t.topUpId)
      .where(sql`${t.topUpId} IS NOT NULL AND ${t.status} <> 'void'`),
    foreignKey({
      name: 'invoices_subscription',
      columns: [t.organizationId, t.subscriptionId],
      foreignColumns: [subscriptions.organizationId, subscriptions.id],
    }),
    foreignKey({
      name: 'invoices_period',
      columns: [t.organizationId, t.billingPeriodId],
      foreignColumns: [billingPeriods.organizationId, billingPeriods.id],
    }),
    foreignKey({
      name: 'invoices_top_up',
      columns: [t.organizationId, t.topUpId],
      foreignColumns: [topUps.organizationId, topUps.id],
    }),
    check('invoices_kind', sql`${t.kind} in ('subscription','top_up')`),
    check('invoices_status', sql`${t.status} in ('draft','open','paid','void','uncollectible')`),
    check('invoices_total', sql`${t.totalMicros} = ${t.subtotalMicros} + ${t.taxMicros}`),
    check(
      'invoices_source',
      sql`(${t.kind} = 'subscription' AND ${t.billingPeriodId} IS NOT NULL AND ${t.topUpId} IS NULL) OR (${t.kind} = 'top_up' AND ${t.topUpId} IS NOT NULL AND ${t.billingPeriodId} IS NULL)`,
    ),
  ],
);

export const invoiceLines = billingSchema.table(
  'invoice_lines',
  {
    organizationId: uuid().notNull(),
    invoiceId: uuid().notNull(),
    lineNo: integer().notNull(),
    kind: text().notNull(),
    meter: text(),
    quantity: bigint({ mode: 'bigint' }),
    unit: text(),
    unitPriceMicros: micros(),
    amountMicros: micros().notNull(),
    usageRef: text(),
  },
  (t) => [
    primaryKey({ name: 'invoice_lines_pk', columns: [t.organizationId, t.invoiceId, t.lineNo] }),
    foreignKey({
      name: 'invoice_lines_invoice',
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoices.organizationId, invoices.id],
    }),
    check(
      'invoice_lines_kind',
      sql`${t.kind} in ('platform_fee','usage','top_up','tax','rounding')`,
    ),
  ],
);

/** One intent to charge one invoice, as ADR-027 D1 has for an email. Its status tells the truth. */
export const payments = billingSchema.table(
  'payments',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    invoiceId: uuid().notNull(),
    amountMicros: micros().notNull(),
    currency: text().notNull(),
    idempotencyKey: text().notNull(),
    status: text().notNull().default('ready'),
    statusReason: text(),
    processor: text().notNull(),
    processorPaymentRef: text(),
    requestedByRef: text().notNull(),
    version: version(),
    settledAt: when(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'payments_pk', columns: [t.organizationId, t.id] }),
    unique('payments_key').on(t.organizationId, t.idempotencyKey),
    uniqueIndex('payments_one_live_per_invoice')
      .on(t.organizationId, t.invoiceId)
      .where(sql`${t.status} in ('ready','sending','reconciling','unknown','succeeded')`),
    uniqueIndex('payments_processor_ref')
      .on(t.organizationId, t.processor, t.processorPaymentRef)
      .where(sql`${t.processorPaymentRef} IS NOT NULL`),
    foreignKey({
      name: 'payments_invoice',
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoices.organizationId, invoices.id],
    }),
    check(
      'payments_status',
      sql`${t.status} in ('ready','sending','reconciling','succeeded','failed','unknown','cancelled')`,
    ),
    check('payments_amount', sql`${t.amountMicros} > 0`),
  ],
);

/** A claim, committed before the processor is contacted. Another is refused while this could have charged. */
export const paymentAttempts = billingSchema.table(
  'payment_attempts',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    paymentId: uuid().notNull(),
    attemptNo: integer().notNull(),
    idempotencyKey: text().notNull(),
    runId: text().notNull(),
    recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    outcome: text(),
    outcomeCode: text(),
    processorPaymentRef: text(),
    finishedAt: when(),
  },
  (t) => [
    primaryKey({ name: 'payment_attempts_pk', columns: [t.organizationId, t.id] }),
    unique('payment_attempts_number').on(t.organizationId, t.paymentId, t.attemptNo),
    foreignKey({
      name: 'payment_attempts_payment',
      columns: [t.organizationId, t.paymentId],
      foreignColumns: [payments.organizationId, payments.id],
    }),
    check(
      'payment_attempts_outcome',
      sql`${t.outcome} in ('succeeded','declined','not_sent','indeterminate')`,
    ),
    check('payment_attempts_no_range', sql`${t.attemptNo} between 1 and 5`),
  ],
);

/** A processor's event as applied to this tenant. The unique key makes applying it twice do nothing. */
export const paymentEvents = billingSchema.table(
  'payment_events',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    processor: text().notNull(),
    providerEventId: text().notNull(),
    kind: text().notNull(),
    paymentId: uuid(),
    invoiceId: uuid(),
    amountMicros: micros(),
    currency: text(),
    providerOccurredAt: when().notNull(),
    appliedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'payment_events_pk', columns: [t.organizationId, t.id] }),
    unique('payment_events_provider').on(t.organizationId, t.processor, t.providerEventId),
    foreignKey({
      name: 'payment_events_payment',
      columns: [t.organizationId, t.paymentId],
      foreignColumns: [payments.organizationId, payments.id],
    }),
    check(
      'payment_events_kind',
      sql`${t.kind} in ('payment_succeeded','payment_failed','payment_refunded','payment_disputed','customer_updated')`,
    ),
  ],
);

/**
 * A verified event as the operator's own organization received it, waiting to be routed. A processor has
 * one webhook address for the whole deployment, so this is held there first (ADR-032 D4).
 */
export const paymentWebhookEvents = billingSchema.table(
  'payment_webhook_events',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    processor: text().notNull(),
    providerEventId: text().notNull(),
    kind: text().notNull(),
    customerRefHash: text().notNull(),
    processorPaymentRef: text(),
    paymentId: uuid(),
    amountMicros: micros(),
    currency: text(),
    providerOccurredAt: when().notNull(),
    state: text().notNull().default('received'),
    targetOrganizationId: uuid(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: when(),
  },
  (t) => [
    primaryKey({ name: 'payment_webhook_events_pk', columns: [t.organizationId, t.id] }),
    unique('payment_webhook_events_provider').on(t.organizationId, t.processor, t.providerEventId),
    check(
      'payment_webhook_events_kind',
      sql`${t.kind} in ('payment_succeeded','payment_failed','payment_refunded','payment_disputed','customer_updated')`,
    ),
    check(
      'payment_webhook_events_state',
      sql`${t.state} in ('received','applied','unmatched','ignored')`,
    ),
  ],
);

export const collectionCases = billingSchema.table(
  'collection_cases',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    invoiceId: uuid().notNull(),
    collectionPolicyId: uuid()
      .notNull()
      .references(() => collectionPolicies.id),
    status: text().notNull().default('open'),
    stepNo: integer().notNull().default(0),
    nextStepAt: when(),
    openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: when(),
    version: version(),
  },
  (t) => [
    primaryKey({ name: 'collection_cases_pk', columns: [t.organizationId, t.id] }),
    unique('collection_cases_invoice').on(t.organizationId, t.invoiceId),
    foreignKey({
      name: 'collection_cases_invoice_fk',
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoices.organizationId, invoices.id],
    }),
    check('collection_cases_status', sql`${t.status} in ('open','resolved','written_off')`),
  ],
);

// --- lifecycle: numbers come from sign-off, never from code. A category with no rule is never swept.

export const retentionRules = lifecycleSchema.table(
  'retention_rules',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    dataCategory: text().notNull(),
    classification: text().notNull().default('*'),
    /** Null keeps it until someone asks. There is no default number, on purpose (LIFE-02). */
    retainDays: integer(),
    /** Where the sign-off for this number is. Required, because a number without one is invented. */
    basisRef: text().notNull(),
    setByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    supersededAt: when(),
  },
  (t) => [
    primaryKey({ name: 'retention_rules_pk', columns: [t.organizationId, t.id] }),
    uniqueIndex('retention_rules_one_current')
      .on(t.organizationId, t.dataCategory, t.classification)
      .where(sql`${t.supersededAt} IS NULL`),
    check('retention_rules_days', sql`${t.retainDays} IS NULL OR ${t.retainDays} > 0`),
    check(
      'retention_rules_classification',
      sql`${t.classification} in ('*','public','internal','confidential','restricted')`,
    ),
    check('retention_rules_category', sql`${t.dataCategory} ~ '^[a-z][a-z0-9_]{1,63}$'`),
  ],
);

/** A pinned rule's sweep position. A transaction lock protects each bounded page and its deletions. */
export const retentionCursors = lifecycleSchema.table(
  'retention_cursors',
  {
    organizationId: tenantId(),
    dataCategory: text().notNull(),
    classification: text().notNull(),
    ruleId: uuid().notNull(),
    cutoffAt: timestamp({ withTimezone: true }).notNull(),
    after: text(),
    completed: boolean().notNull().default(false),
    version: version(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: 'retention_cursors_pk',
      columns: [t.organizationId, t.dataCategory, t.classification],
    }),
    foreignKey({
      name: 'retention_cursors_rule',
      columns: [t.organizationId, t.ruleId],
      foreignColumns: [retentionRules.organizationId, retentionRules.id],
    }),
    check(
      'retention_cursors_classification',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
  ],
);

export const retentionRuns = lifecycleSchema.table(
  'retention_runs',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    dataCategory: text().notNull(),
    examined: integer().notNull().default(0),
    removed: integer().notNull().default(0),
    held: integer().notNull().default(0),
    outcomeCode: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: when(),
  },
  (t) => [primaryKey({ name: 'retention_runs_pk', columns: [t.organizationId, t.id] })],
);

export const legalHolds = lifecycleSchema.table(
  'legal_holds',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    /** A reference to the matter, such as a file number. Not a description of it. */
    matterRef: text().notNull(),
    status: text().notNull().default('active'),
    placedByMembershipId: uuid().notNull(),
    placedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    releasedByMembershipId: uuid(),
    releasedAt: when(),
    releaseReasonCode: text(),
    version: version(),
  },
  (t) => [
    primaryKey({ name: 'legal_holds_pk', columns: [t.organizationId, t.id] }),
    check('legal_holds_status', sql`${t.status} in ('active','released')`),
    check(
      'legal_holds_released',
      sql`${t.status} = 'active' OR (${t.releasedByMembershipId} IS NOT NULL AND ${t.releasedAt} IS NOT NULL AND ${t.releaseReasonCode} IS NOT NULL)`,
    ),
  ],
);

export const legalHoldScopes = lifecycleSchema.table(
  'legal_hold_scopes',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    holdId: uuid().notNull(),
    scopeType: text().notNull(),
    scopeId: uuid(),
  },
  (t) => [
    primaryKey({ name: 'legal_hold_scopes_pk', columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'legal_hold_scopes_hold',
      columns: [t.organizationId, t.holdId],
      foreignColumns: [legalHolds.organizationId, legalHolds.id],
    }),
    index('legal_hold_scopes_target').on(t.organizationId, t.scopeType, t.scopeId),
    check(
      'legal_hold_scopes_type',
      sql`${t.scopeType} in ('organization','client','project','work_unit','artifact')`,
    ),
    check('legal_hold_scopes_id', sql`(${t.scopeType} = 'organization') = (${t.scopeId} IS NULL)`),
  ],
);

export const offboardings = lifecycleSchema.table(
  'offboardings',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    state: text().notNull().default('requested'),
    requestedByMembershipId: uuid().notNull(),
    exportOfferedAt: when(),
    exportRef: text(),
    /** From the customer's contract. Until it is set and has passed, the database refuses erasure. */
    transitionEndsAt: when(),
    transitionSetByRef: text(),
    connectionsRevokedAt: when(),
    workEndedAt: when(),
    actionsSettledAt: when(),
    erasureStartedAt: when(),
    erasureStartedByRef: text(),
    erasureFinishedAt: when(),
    erasureVerifiedByRef: text(),
    /** `ErasureReport` from @ensemus/saas/lifecycle: counts and codes, with no content. */
    report: jsonb(),
    reportedAt: when(),
    cancelledAt: when(),
    cancelReasonCode: text(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'offboardings_pk', columns: [t.organizationId, t.id] }),
    uniqueIndex('offboardings_one_live')
      .on(t.organizationId)
      .where(sql`${t.state} NOT IN ('reported','cancelled')`),
    check(
      'offboardings_state',
      sql`${t.state} in ('requested','export_offered','in_transition','winding_down','ready_for_erasure','erasing','verified','reported','cancelled')`,
    ),
    check(
      'offboardings_reported',
      sql`${t.state} <> 'reported' OR (${t.report} IS NOT NULL AND ${t.reportedAt} IS NOT NULL)`,
    ),
  ],
);

export const erasureLog = lifecycleSchema.table(
  'erasure_log',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    offboardingId: uuid().notNull(),
    tableRef: text().notNull(),
    rowsRemoved: bigint({ mode: 'number' }).notNull().default(0),
    rowsLeft: bigint({ mode: 'number' }).notNull().default(0),
    outcome: text().notNull(),
    reasonCode: text(),
    recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'erasure_log_pk', columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'erasure_log_offboarding',
      columns: [t.organizationId, t.offboardingId],
      foreignColumns: [offboardings.organizationId, offboardings.id],
    }),
    check('erasure_log_outcome', sql`${t.outcome} in ('erased','retained_by_rule','left_over')`),
  ],
);

// --- support: what customers choose to send the desk. Nothing here is a path to their work.

/** The published hours. Only approved ones are shown, and until then the page says none are published. */
export const coverageSchedules = supportSchema.table(
  'coverage_schedules',
  {
    id: uuidPk(),
    version: integer().notNull().unique('coverage_schedules_version_unique'),
    status: text().notNull().default('draft'),
    timezone: text().notNull(),
    schedule: jsonb().notNull(),
    /** Who is actually rostered, because published hours have to match real staffing (OPS-22). */
    staffedByRef: text().notNull(),
    draftedBy: text().notNull(),
    approvedBy: text(),
    approvedAt: when(),
    retiredAt: when(),
    createdAt: createdAt(),
  },
  (t) => [
    check('coverage_schedules_status', sql`${t.status} in ('draft','approved','retired')`),
    check(
      'coverage_schedules_approved',
      sql`${t.status} = 'draft' OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)`,
    ),
  ],
);

export const tickets = supportSchema.table(
  'tickets',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    subject: text().notNull(),
    category: text().notNull(),
    status: text().notNull().default('open'),
    openedByMembershipId: uuid().notNull(),
    firstResponseAt: when(),
    resolvedAt: when(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'tickets_pk', columns: [t.organizationId, t.id] }),
    index('tickets_queue').on(t.status, t.updatedAt),
    check(
      'tickets_status',
      sql`${t.status} in ('open','waiting_on_customer','waiting_on_support','resolved','closed')`,
    ),
    check(
      'tickets_category',
      sql`${t.category} in ('account','billing','incident','security','other')`,
    ),
    check('tickets_subject_length', sql`char_length(${t.subject}) between 1 and 200`),
  ],
);

export const ticketMessages = supportSchema.table(
  'ticket_messages',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    ticketId: uuid().notNull(),
    authorKind: text().notNull(),
    authorRef: text().notNull(),
    body: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'ticket_messages_pk', columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'ticket_messages_ticket',
      columns: [t.organizationId, t.ticketId],
      foreignColumns: [tickets.organizationId, tickets.id],
    }),
    check('ticket_messages_author', sql`${t.authorKind} in ('customer','support')`),
    check('ticket_messages_length', sql`char_length(${t.body}) between 1 and 20000`),
  ],
);

/**
 * Who asked to see something, who agreed, and until when. M8 gives no way to use one: this is the design,
 * and no role can read customer content by holding one (ADR-032 D8). `ticketId` has no foreign key, since
 * this record outlives a ticket.
 */
export const breakGlassRequests = supportSchema.table(
  'break_glass_requests',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    ticketId: uuid().notNull(),
    requestedBy: text().notNull(),
    reasonCode: text().notNull(),
    scopeType: text().notNull(),
    scopeId: uuid().notNull(),
    requestedMinutes: integer().notNull(),
    state: text().notNull().default('requested'),
    operatorAuthorizer: text(),
    operatorAuthorizedAt: when(),
    customerAuthorizerMembershipId: uuid(),
    customerAuthorizedAt: when(),
    authorizedFrom: when(),
    expiresAt: when(),
    closedAt: when(),
    closedBy: text(),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'break_glass_requests_pk', columns: [t.organizationId, t.id] }),
    check(
      'break_glass_requests_state',
      sql`${t.state} in ('requested','authorized','denied','revoked','expired')`,
    ),
    check(
      'break_glass_requests_scope',
      sql`${t.scopeType} in ('work_unit','artifact','client','project')`,
    ),
    check('break_glass_requests_minutes', sql`${t.requestedMinutes} > 0`),
    check(
      'break_glass_requests_two_people',
      sql`${t.operatorAuthorizer} IS NULL OR ${t.operatorAuthorizer} <> ${t.requestedBy}`,
    ),
    check(
      'break_glass_requests_authorized',
      sql`${t.state} <> 'authorized' OR (${t.operatorAuthorizer} IS NOT NULL AND ${t.customerAuthorizerMembershipId} IS NOT NULL AND ${t.authorizedFrom} IS NOT NULL AND ${t.expiresAt} IS NOT NULL)`,
    ),
  ],
);

export const breakGlassLog = supportSchema.table(
  'break_glass_log',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    requestId: uuid().notNull(),
    action: text().notNull(),
    actorRef: text().notNull(),
    targetRef: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'break_glass_log_pk', columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'break_glass_log_request',
      columns: [t.organizationId, t.requestId],
      foreignColumns: [breakGlassRequests.organizationId, breakGlassRequests.id],
    }),
    check(
      'break_glass_log_action',
      sql`${t.action} in ('requested','operator_authorized','customer_authorized','denied','revoked','expired','content_read')`,
    ),
  ],
);

// --- operations: about the service, not a tenant. The public sees only what was published.

export const incidents = operationsSchema.table(
  'incidents',
  {
    id: uuidPk(),
    severity: text().notNull(),
    state: text().notNull().default('investigating'),
    /** Whose outage it is. A provider's outage is never reported as ours, or the other way (OPS-23). */
    origin: text().notNull(),
    providerKind: text(),
    publicTitle: text().notNull(),
    published: boolean().notNull().default(false),
    isDrill: boolean().notNull().default(false),
    commanderRef: text().notNull(),
    securityLeadRef: text(),
    infrastructureLeadRef: text(),
    communicationsRef: text(),
    legalRef: text(),
    postmortemRef: text(),
    startedAt: when().notNull(),
    resolvedAt: when(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('incidents_severity', sql`${t.severity} in ('critical','high','medium')`),
    check(
      'incidents_state',
      sql`${t.state} in ('investigating','identified','monitoring','resolved')`,
    ),
    check(
      'incidents_origin',
      sql`${t.origin} in ('ensemus','model_provider','connector_provider','unknown')`,
    ),
    check('incidents_title_length', sql`char_length(${t.publicTitle}) between 1 and 200`),
    check('incidents_drill_private', sql`NOT (${t.isDrill} AND ${t.published})`),
  ],
);

export const incidentUpdates = operationsSchema.table(
  'incident_updates',
  {
    id: uuidPk(),
    incidentId: uuid()
      .notNull()
      .references(() => incidents.id),
    state: text().notNull(),
    publicMessage: text().notNull(),
    authorRef: text().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'incident_updates_state',
      sql`${t.state} in ('investigating','identified','monitoring','resolved')`,
    ),
    check('incident_updates_length', sql`char_length(${t.publicMessage}) between 1 and 2000`),
  ],
);

export const drills = operationsSchema.table(
  'drills',
  {
    id: uuidPk(),
    kind: text().notNull(),
    scenarioRef: text().notNull(),
    /** Who held which role. Names on the day, because a drill with nobody named proves nothing. */
    roles: jsonb().notNull().default({}),
    evidenceRef: text(),
    outcome: text(),
    startedAt: when().notNull(),
    finishedAt: when(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'drills_kind',
      sql`${t.kind} in ('incident','restore','vulnerability_disclosure','failover')`,
    ),
    check('drills_outcome', sql`${t.outcome} IS NULL OR ${t.outcome} in ('passed','failed')`),
  ],
);

/** A reference to a report, and where it stands. The details stay wherever they were sent. */
export const vulnerabilityReports = operationsSchema.table(
  'vulnerability_reports',
  {
    id: uuidPk(),
    channelRef: text().notNull(),
    detailsRef: text().notNull(),
    severity: text(),
    state: text().notNull().default('received'),
    isExercise: boolean().notNull().default(false),
    fixedInRef: text(),
    receivedAt: when().notNull(),
    acknowledgedAt: when(),
    disclosedAt: when(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'vulnerability_reports_severity',
      sql`${t.severity} IS NULL OR ${t.severity} in ('critical','high','medium','low')`,
    ),
    check(
      'vulnerability_reports_state',
      sql`${t.state} in ('received','triaged','fixing','fixed','disclosed','rejected')`,
    ),
  ],
);

/** Private durable physical-deletion receipts. IDs/keys/hashes only; SQL owns all writes and serving. */
export const objectDeletionClaims = lifecycleSchema.table(
  'object_deletion_claims',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    kind: text().notNull(),
    artifactId: uuid().notNull(),
    importId: uuid(),
    writerToken: uuid().notNull(),
    generation: bigint({ mode: 'number' }).notNull(),
    objectKey: text().notNull(),
    sha256: text().notNull(),
    state: text().notNull(),
    admittedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    terminalAt: timestamp({ withTimezone: true }),
    absentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'object_deletion_claims_organization_id_fkey',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    primaryKey({ name: 'object_deletion_claims_pkey', columns: [t.organizationId, t.id] }),
    uniqueIndex('object_deletion_unresolved_key')
      .on(t.organizationId, t.objectKey)
      .where(sql`${t.state}<>'proven'`),
    check('object_deletion_claims_kind_check', sql`${t.kind} in ('derived','ordinary','archive')`),
    check('object_deletion_claims_generation_check', sql`${t.generation}>0`),
    check('object_deletion_claims_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'object_deletion_claims_state_check',
      sql`${t.state} in ('admitted','unknown','deleted','proven')`,
    ),
    check(
      'object_deletion_key',
      sql`(${t.kind}='archive' and ${t.importId} is not null and ${t.objectKey}=${t.organizationId}::text||'/archive-quarantine/'||${t.importId}::text||'/'||${t.artifactId}::text||'/'||${t.writerToken}::text) or (${t.kind} in ('derived','ordinary') and ${t.importId} is null and ${t.objectKey}=${t.organizationId}::text||'/artifacts/'||${t.artifactId}::text)`,
    ),
    check(
      'object_deletion_receipt',
      sql`(${t.state} not in ('deleted','proven') or ${t.terminalAt} is not null) and (${t.state}<>'proven' or (${t.absentAt} is not null and ${t.absentAt}>=${t.terminalAt}))`,
    ),
  ],
);

/** Durable native admission; opaque historic session/person IDs survive logout and tenant row erasure. */
export const offboardingAdmissions = lifecycleSchema.table(
  'offboarding_admissions',
  {
    organizationId: uuid().notNull(),
    offboardingId: uuid().notNull(),
    requestedByMembershipId: uuid().notNull(),
    userId: uuid().notNull(),
    sessionId: uuid().notNull(),
    admittedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({
      name: 'offboarding_admissions_pkey',
      columns: [t.organizationId, t.offboardingId],
    }),
    foreignKey({
      name: 'offboarding_admissions_organization_id_fkey',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'offboarding_admission_intent',
      columns: [t.organizationId, t.offboardingId],
      foreignColumns: [offboardings.organizationId, offboardings.id],
    }),
  ],
);

export const offboardingAgentStops = lifecycleSchema.table(
  'offboarding_agent_stops',
  {
    organizationId: uuid().notNull(),
    offboardingId: uuid().notNull(),
    switchId: uuid().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'offboarding_agent_stops_pkey',
      columns: [t.organizationId, t.offboardingId],
    }),
    foreignKey({
      name: 'offboarding_agent_stops_organization_id_fkey',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'offboarding_agent_stops_switch_id_fkey',
      columns: [t.switchId],
      foreignColumns: [killSwitches.id],
    }),
    foreignKey({
      name: 'offboarding_agent_stop_intent',
      columns: [t.organizationId, t.offboardingId],
      foreignColumns: [offboardings.organizationId, offboardings.id],
    }),
  ],
);

export const objectRestoreDebts = lifecycleSchema.table(
  'object_restore_debts',
  {
    organizationId: uuid().notNull(),
    objectKey: text().notNull(),
    kind: text().notNull(),
    artifactId: uuid().notNull(),
    importId: uuid(),
    writerToken: uuid().notNull(),
    recordedAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ name: 'object_restore_debts_pkey', columns: [t.organizationId, t.objectKey] }),
    foreignKey({
      name: 'object_restore_debts_organization_id_fkey',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    check('object_restore_debts_kind_check', sql`${t.kind} in ('derived','archive')`),
  ],
);
