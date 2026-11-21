// A plain activity interceptor, because no trace context crosses Temporal (ADR-024, ADR-037 D3). It runs
// beside the Activity and not in a workflow, so nothing it does reaches a history or the replay corpus.
// Tiers are joined by the IDs on their spans, not by a shared trace.
import { withSpan } from '@ensemus/telemetry/tracing';
import type { ActivityInterceptorsFactory } from '@temporalio/worker';

/** A span around each Activity, with IDs and the attempt, and never its arguments or result. */
export function activityTracing(): ActivityInterceptorsFactory {
  return (ctx) => ({
    inbound: {
      execute: (input, next) => {
        const { activityType, workflowExecution, taskQueue, attempt } = ctx.info;
        return withSpan(
          'activity.execute',
          { activityType, workflowId: workflowExecution?.workflowId, taskQueue, attempt },
          () => next(input),
        );
      },
    },
  });
}
