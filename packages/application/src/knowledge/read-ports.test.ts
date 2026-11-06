import { describe, expect, it } from 'vitest';
import { createEgressSimulationPolicy } from './read-ports';
import type { EgressProposal } from '@ensemus/knowledge/ports';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const proposal: EgressProposal = {
  destination: 'customer_byom_public_api',
  destinationHost: 'model.example.invalid',
  billingOwner: 'customer',
  retentionBasis: 'contract_recorded',
  region: 'test-region',
  contractRef: 'synthetic-contract',
  allowedClasses: ['internal', 'restricted'],
  purposes: ['reason', 'embed'],
};
describe('actual hypothetical egress policy binding', () => {
  it('allows a qualified proposal under the shared matrix and retains its actual version', () => {
    const result = createEgressSimulationPolicy({ organizationId, bundle: null }).evaluate({
      organizationId,
      proposal,
      classification: 'internal',
      purpose: 'reason',
    });
    expect(result).toMatchObject({ allow: true, reasonCode: 'ALLOWED' });
    expect(result.policyVersion).toMatch(/^egress-/);
  });
  it('denies restricted external sharing even when the proposal lists that class', () => {
    expect(
      createEgressSimulationPolicy({ organizationId, bundle: null }).evaluate({
        organizationId,
        proposal,
        classification: 'restricted',
        purpose: 'embed',
      }),
    ).toMatchObject({ allow: false, reasonCode: 'CLASS_DENIED' });
  });
  it('applies actual tenant tightening and reports its version', () => {
    const policy = createEgressSimulationPolicy({
      organizationId,
      bundle: { version: '7', denyClasses: { customer_byom_public_api: ['internal'] } },
    });
    expect(
      policy.evaluate({ organizationId, proposal, classification: 'internal', purpose: 'reason' }),
    ).toMatchObject({
      allow: false,
      reasonCode: 'CLASS_DENIED',
      policyVersion: expect.stringContaining('+bundle-7'),
    });
  });
  it('refuses a foreign organization instead of applying another tenant policy', () => {
    expect(
      createEgressSimulationPolicy({ organizationId, bundle: null }).evaluate({
        organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        proposal,
        classification: 'internal',
        purpose: 'reason',
      }),
    ).toMatchObject({ allow: false, reasonCode: 'UNKNOWN_INPUT' });
  });
});
