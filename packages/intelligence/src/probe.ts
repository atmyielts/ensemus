// Owned by the model-profiles slice (MODEL-01). See docs/06-delivery/m4-slices.md and ADR-028 FD-23. A
// synthetic conformance prompt through the real adapter, guard and lender. This stub fails every probe.
import type { RoutableProfile } from '@ensemus/application/ai-ports';
import type { CredentialLender, EndpointGuard, ModelAdapter, ProfileProber } from './types';

export function createProfileProber(_deps: {
  load: (input: { organizationId: string; profileId: string }) => Promise<RoutableProfile | null>;
  adapter: ModelAdapter;
  guard: EndpointGuard;
  credentials: CredentialLender;
  privateEndpoints: readonly string[];
}): ProfileProber {
  return {
    async probe() {
      return 'failed';
    },
  };
}
