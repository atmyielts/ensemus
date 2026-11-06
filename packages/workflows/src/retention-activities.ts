// Owned by the retention slice (LIFE-02). See docs/06-delivery/m8-slices.md.
import type { RetentionActivityDeps } from './saas-deps';
import type { RetentionInput, RetentionResult } from './saas-schemas';

export function createRetentionActivities(_deps: RetentionActivityDeps) {
  return {
    /** One bounded page per category. Counts come back, and never a name or an ID. */
    async sweepRetentionPage(_input: RetentionInput): Promise<RetentionResult> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type RetentionActivities = ReturnType<typeof createRetentionActivities>;
