// Owned by the egress slice (AGENT-11). See docs/06-delivery/m5-slices.md. Works out what a proposed
// provider would receive, from data alone. It has no way to transmit anything: this module imports no
// network, no model port and no credential, and lint holds that.
import type { Classification } from '@ensemus/domain/policy';
import type { EgressPolicyPort, EgressProposal, EgressWorkload, ModelPurpose } from './ports';

export type SimulationRow = {
  workloadKey: string;
  kind: EgressWorkload['kind'];
  purpose: ModelPurpose;
  classification: Classification;
  wouldTransmit: boolean;
  reasonCode: string;
  policyVersion: string;
};

/**
 * One row per workload per class it handles. Unknown input denies, and a policy that throws reads as
 * `wouldTransmit: false` with a code, because a simulator that overstates safety is worse than none.
 */
export function simulateEgress(
  _input: {
    organizationId: string;
    proposal: EgressProposal;
    workloads: readonly EgressWorkload[];
  },
  _policy: EgressPolicyPort,
): readonly SimulationRow[] {
  throw new Error('NOT_IMPLEMENTED');
}
