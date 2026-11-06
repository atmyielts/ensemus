// Owned by the catalog slice (BILL-04). See docs/06-delivery/m8-slices.md and ADR-032 D2.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { PlanTerms, RateCardFacts } from '@ensemus/saas/catalog';
import type { TopUpQuote } from '@ensemus/saas/credits';

/** Approved plan versions this tenant's mode could start on. Empty until the owner approves one. */
export function listAvailablePlans(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly (PlanTerms & { planCode: string; displayName: string })[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/** One plan version's terms. Null for a draft or an unknown ID: to a tenant, a draft does not exist. */
export function loadPlanTerms(_tx: Tx, _planVersionId: string): Promise<PlanTerms | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The card and its lines, or throws RATE_CARD_NOT_APPROVED. A retired card loads, because it still prices
 * the time it was in force. Everything that prices anything goes through here.
 */
export function requirePublishedRateCard(_tx: Tx, _rateCardId: string): Promise<RateCardFacts> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Offers on the plan's current card, each already quoted. Empty if its plan does not allow top-ups. */
export function listTopUpOffers(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly TopUpQuote[]> {
  throw new Error('NOT_IMPLEMENTED');
}
