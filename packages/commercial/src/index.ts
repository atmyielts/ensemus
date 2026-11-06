// Owned by the usage slice (MODEL-04, COMM-02). The entitlement seam (ADR-028 FD-8). M6's signed offline
// license and M8's billing implement the same `Entitlements` port behind this. No price, plan or limit
// lives in code: the only rule here is what each commercial mode already means, and that a Cloud tenant
// has no included allowance until something issues one. This stub denies everything.
import type { Entitlements } from '@ensemus/application/ai-ports';
import type { EntitlementsView } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';

export const FEATURE_AGENT_RUN = 'agent.run';
export const FEATURE_MODEL_CALL = 'model.call';

export function createEntitlements(_database: AppDatabase): Entitlements {
  return {
    async check() {
      return { ok: false, code: 'ENTITLEMENT_DENIED' };
    },
  };
}

export function getEntitlementsView(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<EntitlementsView> {
  throw new Error('NOT_IMPLEMENTED');
}
