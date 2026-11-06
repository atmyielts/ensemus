import { describe, expect, it } from 'vitest';
import { simulateEgress } from './egress-simulation';
import type { EgressPolicyPort, EgressProposal } from './ports';

const proposal: EgressProposal = {
  destination: 'customer_byom_public_api',
  destinationHost: 'generated.example.invalid',
  billingOwner: 'customer',
  retentionBasis: 'contract_recorded',
  region: 'generated-region',
  contractRef: 'generated-contract',
  allowedClasses: ['internal'],
  purposes: ['embed'],
};
describe('egress simulation has no transmission path', () => {
  it('evaluates each distinct workload class and preserves denials', () => {
    let calls = 0;
    const policy: EgressPolicyPort = {
      evaluate: (request) => {
        calls++;
        return {
          allow: request.classification === 'internal',
          reasonCode: request.classification === 'internal' ? 'ALLOW' : 'EGRESS_DENIED',
          policyVersion: 'generated-v1',
        };
      },
    };
    const rows = simulateEgress(
      {
        organizationId: '00000000-0000-4000-8000-000000000a01',
        proposal,
        workloads: [
          {
            key: 'knowledge-embed',
            kind: 'knowledge',
            purpose: 'embed',
            classes: ['restricted', 'internal', 'internal'],
          },
        ],
      },
      policy,
    );
    expect(calls).toBe(2);
    expect(rows).toMatchObject([
      { classification: 'internal', wouldTransmit: true },
      { classification: 'restricted', wouldTransmit: false },
    ]);
  });
  it('denies malformed input and a policy failure without retaining thrown text', () => {
    const workload = {
      key: 'knowledge-answer',
      kind: 'knowledge' as const,
      purpose: 'answer' as const,
      classes: ['restricted'] as const,
    };
    const input = {
      organizationId: '00000000-0000-4000-8000-000000000a01',
      proposal,
      workloads: [workload],
    };
    expect(
      simulateEgress(input, {
        evaluate: () => {
          throw new Error('secret-provider-text');
        },
      }),
    ).toMatchObject([{ wouldTransmit: false, reasonCode: 'EGRESS_DENIED' }]);
    let calls = 0;
    const rows = simulateEgress(
      {
        ...input,
        proposal: { ...proposal, destinationHost: 'https://user:secret@example.invalid/path' },
      },
      {
        evaluate: () => {
          calls++;
          return { allow: true, reasonCode: 'ALLOW', policyVersion: 'v1' };
        },
      },
    );
    expect(calls).toBe(0);
    expect(rows).toMatchObject([{ wouldTransmit: false, reasonCode: 'INVALID_INPUT' }]);
    expect(JSON.stringify(rows)).not.toContain('secret');
  });
});
