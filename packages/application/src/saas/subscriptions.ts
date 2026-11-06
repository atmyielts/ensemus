// Owned by the subscriptions slice (COMM-01, OPS-21). See docs/06-delivery/m8-slices.md and ADR-032 D5.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';

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
export function getBillingOverview(
  _database: AppDatabase,
  _context: TenantContext,
  _options: { billingEnabled: boolean },
): Promise<BillingOverview> {
  throw new Error('NOT_IMPLEMENTED');
}

/** `billing.manage`. Creating needs no version, and updating needs the one the person saw. */
export function saveBillingAccount(
  _database: AppDatabase,
  _context: TenantContext,
  _input: BillingAccountInput & { expectedVersion: number | null },
): Promise<{ version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * `billing.manage`, or the service context when provisioning. Refuses a draft plan, a plan for another
 * mode, and Sovereign outright. Opens the first period, allocates its credits, and emits SUBSCRIPTION_STARTED.
 */
export function startSubscription(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { planVersionId: string; startsAt?: Date },
): Promise<{ subscriptionId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * `billing.manage`. Applies `planChangeEffect`, records the excess, and removes nothing. Anything over the
 * new plan's limits goes read-only for the person to remedy (OPS-21).
 */
export function changePlan(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { toPlanVersionId: string; expectedVersion: number },
): Promise<{ effective: 'now' | 'period_end'; excess: Readonly<Record<string, number>> }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** `billing.manage`. Service stays until the period ends, and the data stays after that. */
export function requestCancellation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export function withdrawCancellation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Service only, from the billing cycle. Moves a period on, or ends one marked to cancel. Repeats are safe. */
export function advanceSubscriptionInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: { subscriptionId: string; now: Date },
): Promise<'advanced' | 'canceled' | 'not_due'> {
  throw new Error('NOT_IMPLEMENTED');
}
