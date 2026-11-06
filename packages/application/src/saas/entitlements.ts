// Owned by the subscriptions slice (COMM-01). What M4's gateway and every other milestone call to ask
// whether something is licensed. See docs/06-delivery/m8-slices.md and ADR-032 D5.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { EntitlementDecision, EntitlementRequest } from '@ensemus/saas/entitlements';

export type EntitlementsView = {
  mode: 'cloud' | 'byom' | 'sovereign';
  features: readonly string[];
  capacity: {
    balanceMicrocredits: string | null;
    includedMicrocredits: string | null;
    maxActiveMembers: number | null;
  };
};

/** Reads current facts and answers from `evaluateEntitlement`, in the caller's transaction. */
export function checkEntitlementInTx(
  _tx: Tx,
  _context: TenantContext,
  _request: EntitlementRequest,
  _options: { billingEnabled: boolean },
): Promise<EntitlementDecision> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * For the `/entitlements` route, for any member. It holds no key and nothing a tenant could not see, and
 * nothing here can override a policy decision.
 */
export function getEntitlements(
  _database: AppDatabase,
  _context: TenantContext,
  _options: { billingEnabled: boolean },
): Promise<EntitlementsView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The port M4's `Entitlements.check(ctx, feature)` is wired to at the final merge. A plain object, so it can
 * be handed over without M4 importing anything else from here.
 */
export function createEntitlementChecker(_database: AppDatabase, _billingEnabled: boolean) {
  return {
    check(_context: TenantContext, _request: EntitlementRequest): Promise<EntitlementDecision> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
