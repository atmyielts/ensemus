// Owned by the policy-router slice (MODEL-03, COMM-02). See docs/06-delivery/m4-slices.md and ADR-028 FD-8,
// FD-9, FD-13. This stub finds no candidate, so nothing is ever selected by accident.
import type { EgressLog, ProfileStore } from '@ensemus/application/ai-ports';
import type { ModelRouter } from '../types';

export function createModelRouter(_deps: {
  profiles: ProfileStore;
  egress: EgressLog;
  now?: () => Date;
}): ModelRouter {
  return {
    async select() {
      return { kind: 'denied', reasonCode: 'NO_CANDIDATE', policyVersion: 'unbuilt' };
    },
  };
}
