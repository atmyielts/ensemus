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
 * What M4's `getEntitlementsView` and its `/entitlements` route read for a Cloud or BYOM tenant, for any member.
 * It holds no key and nothing a tenant could not see, and nothing here can override a policy decision.
 */
export function getEntitlements(
  _database: AppDatabase,
  _context: TenantContext,
  _options: { billingEnabled: boolean },
): Promise<EntitlementsView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** M4's `EntitlementResult` from `@ensemus/application/ai-ports`, as written there (ADR-028 FD-8). */
export type EntitlementPortResult =
  | { ok: true; billable: boolean; commercialMode: 'cloud' | 'byom' | 'sovereign' }
  | { ok: false; code: 'ENTITLEMENT_DENIED' };

/**
 * M4's `Entitlements` port for Cloud and BYOM, in that port's shape so it needs no import from M4, the same
 * as M6's `createSovereignEntitlements`. `@ensemus/commercial`'s `createEntitlements` calls this at the final
 * merge. `check` answers M4's features: `model.call` is a capacity check, where BYOM is `billable: false`,
 * and anything else is a feature on the plan. `decide` is the richer answer, for an admin's diagnostics.
 */
export function createEntitlementChecker(_database: AppDatabase, _billingEnabled: boolean) {
  return {
    check(_context: TenantContext, _feature: string): Promise<EntitlementPortResult> {
      throw new Error('NOT_IMPLEMENTED');
    },
    decide(_context: TenantContext, _request: EntitlementRequest): Promise<EntitlementDecision> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
