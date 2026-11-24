import 'server-only';
import { entitledSkillFeatureGate } from '@ensemus/application';
import { createEntitlementChecker } from '@ensemus/application/saas/entitlements';
import { getRuntime } from './runtime';
import { loadSandboxCeilings, loadSkillFeatures, loadSaasConfig } from '@ensemus/config';

// The web tier's view of M11B's settings (ADR-034). It can read what a deployment turned on, and the limits a
// run would get. It has no runner address, no runner token and no review keys, because it needs none of them:
// it stores bytes and writes rows, and a worker does everything else.

let gate: ReturnType<typeof entitledSkillFeatureGate> | undefined;
let ceilings: ReturnType<typeof loadSandboxCeilings> | undefined;

/** Operator admission and the current commercial entitlement must both permit a new package. */
export function getSkillFeatureGate() {
  if (!gate) {
    const { app } = getRuntime();
    gate = entitledSkillFeatureGate(
      loadSkillFeatures(),
      createEntitlementChecker(app, loadSaasConfig().billingEnabled),
    );
  }
  return gate;
}

export function getSandboxCeilings() {
  ceilings ??= loadSandboxCeilings();
  return ceilings;
}
