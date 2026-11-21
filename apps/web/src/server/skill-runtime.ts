import 'server-only';
import { deploymentFeatureGate } from '@ensemus/application';
import { loadSandboxCeilings, loadSkillFeatures } from '@ensemus/config';

// The web tier's view of M11B's settings (ADR-034). It can read what a deployment turned on, and the limits a
// run would get. It has no runner address, no runner token and no review keys, because it needs none of them:
// it stores bytes and writes rows, and a worker does everything else.

let gate: ReturnType<typeof deploymentFeatureGate> | undefined;
let ceilings: ReturnType<typeof loadSandboxCeilings> | undefined;

/** Off until an operator turns it on. M8's entitlement check joins this at the final merge (ADR-034 D8). */
export function getSkillFeatureGate() {
  gate ??= deploymentFeatureGate(loadSkillFeatures());
  return gate;
}

export function getSandboxCeilings() {
  ceilings ??= loadSandboxCeilings();
  return ceilings;
}
