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
  input: {
    organizationId: string;
    proposal: EgressProposal;
    workloads: readonly EgressWorkload[];
  },
  policy: EgressPolicyPort,
): readonly SimulationRow[] {
  const classes = ['public', 'internal', 'confidential', 'restricted'];
  const proposal = input.proposal;
  const validProposal =
    /^[0-9a-f-]{36}$/i.test(input.organizationId) &&
    [
      'ensemus_cloud_managed_model',
      'customer_byom_public_api',
      'customer_private_inference',
    ].includes(proposal.destination) &&
    /^[-a-z0-9.]{1,253}$/i.test(proposal.destinationHost) &&
    ['customer', 'ensemus'].includes(proposal.billingOwner) &&
    ['unreviewed', 'contract_recorded', 'self_hosted'].includes(proposal.retentionBasis) &&
    Array.isArray(proposal.allowedClasses) &&
    proposal.allowedClasses.every((value) => classes.includes(value)) &&
    Array.isArray(proposal.purposes) &&
    proposal.purposes.every((value) => ['embed', 'rerank', 'answer'].includes(value));
  const rows: SimulationRow[] = [];
  for (const workload of [...input.workloads].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  )) {
    for (const value of [...new Set(workload.classes)].sort(
      (a, b) => classes.indexOf(a) - classes.indexOf(b),
    )) {
      const classification = classes.includes(value) ? value : 'restricted';
      const valid =
        validProposal &&
        classes.includes(value) &&
        ['knowledge', 'agent'].includes(workload.kind) &&
        ['embed', 'rerank', 'answer'].includes(workload.purpose);
      let wouldTransmit = false,
        reasonCode = 'INVALID_INPUT',
        policyVersion = 'unavailable';
      if (valid) {
        try {
          const verdict = policy.evaluate({
            organizationId: input.organizationId,
            proposal,
            classification,
            purpose: workload.purpose,
          });
          if (
            typeof verdict.allow === 'boolean' &&
            /^[a-z0-9_.:-]{1,128}$/i.test(verdict.reasonCode) &&
            /^[a-z0-9_.:-]{1,128}$/i.test(verdict.policyVersion)
          ) {
            wouldTransmit = verdict.allow;
            reasonCode = verdict.reasonCode;
            policyVersion = verdict.policyVersion;
          } else reasonCode = 'EGRESS_DENIED';
        } catch {
          reasonCode = 'EGRESS_DENIED';
        }
      }
      rows.push({
        workloadKey: workload.key,
        kind: workload.kind,
        purpose: workload.purpose,
        classification,
        wouldTransmit,
        reasonCode,
        policyVersion,
      });
    }
  }
  return rows;
}
