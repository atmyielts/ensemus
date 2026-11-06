import { describe, expect, it } from 'vitest';
import { decideAction } from './action';
import { strongest } from './classification';
import { decideEgress } from './egress';
import { checkEndpoint } from './endpoint';
import { scanForSecrets } from './secret-scan';

describe('classes', () => {
  it('take the strongest when mixed', () => {
    expect(strongest('public', 'confidential')).toBe('confidential');
  });
});

// Until its slice lands, each decision refuses. These stay true of a stub, so a half-built path is safe.
describe('what is not built yet', () => {
  it('denies egress', () => {
    const decision = decideEgress({
      dataClass: 'public',
      purpose: 'reason',
      requiredRegion: null,
      bundle: null,
      now: new Date(0),
      profile: {
        id: 'p',
        version: 1,
        active: true,
        destination: 'customer_private_inference',
        destinationHost: 'model.example.invalid',
        billingOwner: 'customer',
        region: null,
        allowedClasses: ['public'],
        allowedPurposes: ['reason'],
        retentionBasis: 'self_hosted',
        contractRef: null,
      },
    });
    expect(decision.decision).toBe('deny');
  });

  it('denies an action', () => {
    const decision = decideAction({
      toolId: 'work.read',
      toolClass: 'read_only',
      allow: ['work.read'],
      deny: [],
      delegated: ['work.read'],
      dataClass: 'public',
      destructive: false,
      requiresApproval: false,
    });
    expect(decision.decision).toBe('deny');
  });

  it('refuses an endpoint', () => {
    const check = checkEndpoint('openai_compatible', 'https://model.example.invalid/v1', {
      privateEndpoints: [],
    });
    expect(check.ok).toBe(false);
  });

  it('reports a hit on every part, so nothing leaves', () => {
    expect(scanForSecrets([{ id: 'a', text: 'nothing here' }]).hits).toHaveLength(1);
  });
});
