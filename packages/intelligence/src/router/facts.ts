// What the router and the gateway both need to say about a profile, one way.
import type { RoutableProfile } from '@ensemus/application/ai-ports';
import type { EgressProfileFacts } from '@ensemus/policy';

/** The host a decision is about. Null for an address that does not parse, which then cannot be allowed. */
export function hostOf(endpointUrl: string): string | null {
  try {
    return new URL(endpointUrl).hostname || null;
  } catch {
    return null;
  }
}

/** The two schemes a guarded fetch can speak. Anything else cannot be sent to. */
export function protocolOf(endpointUrl: string): 'https:' | 'http:' | null {
  try {
    const { protocol } = new URL(endpointUrl);
    return protocol === 'https:' || protocol === 'http:' ? protocol : null;
  } catch {
    return null;
  }
}

/** Only the facts egress depends on. There is no key here, and nothing a model said. */
export function egressFacts(profile: RoutableProfile): EgressProfileFacts {
  return {
    id: profile.id,
    version: profile.version,
    active: profile.status === 'active',
    destination: profile.destination,
    destinationHost: hostOf(profile.endpointUrl) ?? '',
    billingOwner: profile.billingOwner,
    region: profile.region,
    allowedClasses: profile.allowedClasses,
    allowedPurposes: profile.allowedPurposes,
    retentionBasis: profile.retentionBasis,
    contractRef: profile.contractRef,
  };
}
