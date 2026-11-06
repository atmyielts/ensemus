// Owned by the process slice (AGENT-13). See docs/06-delivery/m7-slices.md and ADR-031 D7.
import { advanceProcessRun } from '@ensemus/application/process-runs';
import type { ProductPorts } from '@ensemus/application/product-ports';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { ProcessRunInput, ProcessRunStep } from './product-schemas';

export function createProcessRunActivities(deps: {
  database: AppDatabase;
  ports: Pick<ProductPorts, 'agentRuns'>;
}) {
  return {
    async advanceRun(input: ProcessRunInput & { temporalRunId: string }): Promise<ProcessRunStep> {
      return advanceProcessRun(
        deps.database,
        createServiceContext(input.organizationId),
        deps.ports,
        { runId: input.processRunId, temporalRunId: input.temporalRunId },
      );
    },
  };
}
export type ProcessRunActivities = ReturnType<typeof createProcessRunActivities>;
