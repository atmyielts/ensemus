// Owned by the transport slice (MODEL-02). See docs/06-delivery/m4-slices.md and ADR-028 FD-11. Calls a
// provider package's `doGenerate` once, through the call's guarded fetch. `ai` core is not used: lint
// bans it, because it retries by default and can resolve a bare model string to a hosted gateway.
import type { ModelAdapter } from '../types';

/** A fresh provider instance per call. This stub answers that nothing can be reached. */
export function createModelAdapter(): ModelAdapter {
  return {
    async generate() {
      return { kind: 'failure', failure: 'connect_failed', mayHaveBilled: false, usage: null };
    },
  };
}
