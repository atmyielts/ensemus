// Ports for cross-organization work (ADR-035). What these services need from other milestones, named here
// so nothing in this milestone depends on their code. The final merge supplies each one.
import type { Tx, TenantContext } from '@ensemus/database';

/** The feature name a plan has to list, once plans are wired in. Which plans do is an owner decision. */
export const FEATURE_CROSS_ORG = 'federation.cross_org';

/**
 * Whether this organization's plan includes cross-organization work. At the final merge, wherever billing is
 * on, this is M8's checker: `createEntitlementChecker(database, billingEnabled).check(context, { kind:
 * 'feature', feature: FEATURE_CROSS_ORG })`, which has the same shape as M4's `Entitlements.check`. Where a
 * deployment has no plans, such as Sovereign, the composition root passes `noPlanGate`: the operator's switch
 * and each tenant's own switch are then the only gates, and both stay off until someone turns them on.
 */
export interface CrossOrgEntitlement {
  allows(context: TenantContext): Promise<boolean>;
}

/** For a deployment with no billing. Not a test double: it names the absence of a plan to check. */
export const noPlanGate: CrossOrgEntitlement = { allows: async () => true };

/**
 * Tells this milestone a source record is gone, so what was sent from it is withdrawn in the same
 * transaction (`LIFE-*`). The work and artifact services call `withdrawItemsForSourceInTx` at the final
 * merge. Offboarding a tenant (M8) adds `federationWindDown` to `OffboardingPorts.windDowns`, which has this
 * shape without the third argument. Both are exported by these services.
 */
export type FederationLifecycleHook = (
  tx: Tx,
  context: TenantContext,
  source: { sourceType: 'work_unit' | 'artifact'; sourceId: string },
) => Promise<void>;
