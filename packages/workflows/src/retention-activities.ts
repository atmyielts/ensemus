// Owned by the retention slice (LIFE-02). See docs/06-delivery/m8-slices.md.
import type { RetentionActivityDeps } from './saas-deps';
import type { RetentionInput, RetentionResult } from './saas-schemas';
import { retentionInputSchema } from './saas-schemas';
import { createServiceContext } from '@ensemus/database/service';
import { sweepRetention } from '@ensemus/application/saas/retention';
import { createLogger } from '@ensemus/telemetry';

const log = createLogger('retention-activities');

export function createRetentionActivities(deps: RetentionActivityDeps) {
  return {
    /** One bounded page per category. Counts come back, and never a name or an ID. */
    async sweepRetentionPage(input: RetentionInput): Promise<RetentionResult> {
      const value = retentionInputSchema.parse(input);
      const rows = await sweepRetention(
        deps.database,
        createServiceContext(value.organizationId),
        deps.sources,
        { limit: 100, now: new Date() },
      );
      for (const row of rows)
        if (
          row.outcomeCode &&
          [
            'RETENTION_SOURCE_FAILED',
            'RETENTION_SOURCE_NOT_WIRED',
            'RETENTION_SOURCE_NOT_PAGED',
          ].includes(row.outcomeCode)
        )
          log.warn('retention.incomplete', {
            organizationId: value.organizationId,
            reasonCode: row.outcomeCode,
            count: row.examined,
          });
      return {
        categories: rows.length,
        removed: rows.reduce((total, row) => total + row.removed, 0),
        held: rows.reduce((total, row) => total + row.held, 0),
        more: rows.some((row) => row.more),
      };
    },
  };
}
export type RetentionActivities = ReturnType<typeof createRetentionActivities>;
