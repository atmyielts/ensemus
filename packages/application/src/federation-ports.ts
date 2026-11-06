// Ports for cross-organization work (ADR-035). What these services need from other milestones, named here
// so nothing in this milestone depends on their code. The final merge supplies each one.
import type { Tx, TenantContext } from '@ensemus/database';

/**
 * Whether this organization's plan includes cross-organization work (M8, `COMM-*`, entitlement
 * `feature_set`). Which plans do is an owner decision, so nothing here assumes one. Where a deployment has no
 * plans, such as Sovereign, the composition root passes `noPlanGate`: the operator's switch and each tenant's
 * own switch are then the only gates, and both stay off until someone turns them on.
 */
export interface CrossOrgEntitlement {
  allows(organizationId: string): Promise<boolean>;
}

/** For a deployment with no billing. Not a test double: it names the absence of a plan to check. */
export const noPlanGate: CrossOrgEntitlement = { allows: async () => true };

/**
 * Tells this milestone a source record is gone, so what was sent from it is withdrawn in the same
 * transaction (`LIFE-*`). The work and artifact services call `withdrawItemsForSourceInTx` at the final
 * merge. Offboarding a tenant (M8) calls `endAllGrantsInTx`. Both are exported by these services, and this
 * type is what a sibling's hook has to look like.
 */
export type FederationLifecycleHook = (
  tx: Tx,
  context: TenantContext,
  source: { sourceType: 'work_unit' | 'artifact'; sourceId: string },
) => Promise<void>;
