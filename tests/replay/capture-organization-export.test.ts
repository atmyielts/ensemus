// Records the organization export's paths into the replay corpus (ADR-030 D7). Needs a Temporal from
// compose.capture.yaml, and only runs when asked:
//   ENSEMUS_CAPTURE_REPLAY=1 pnpm exec vitest run --project replay capture-organization-export
// A recorded history is never rewritten. These have not been recorded yet: see organization-export-corpus.test.ts.
import { ApplicationFailure } from '@temporalio/common';
import { describe, it } from 'vitest';
import { PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import { capturing, withCaptureWorkers } from './capture-support';

const input = {
  organizationId: '00000000-0000-4000-8000-00000000000a',
  exportId: '00000000-0000-4000-8000-00000000000c',
};
const going = { state: 'continue', parts: 1, records: 1 };
const done = { state: 'finished', parts: 2, records: 2 };

type Step = Record<string, unknown>;

describe.skipIf(!capturing)('capture organization export histories', () => {
  it('records each path', async () => {
    // What each step answers, in order. The last one repeats. Set before each run, since a run has one worker.
    let batches: (Step | Error)[] = [done];
    let finishes: (Step | Error)[] = [done];
    let begins: (Step | Error)[] = [going];
    const next = (steps: (Step | Error)[]) => {
      const step = steps.length > 1 ? steps.shift() : steps[0];
      if (step instanceof Error) throw step;
      return step;
    };

    await withCaptureWorkers(
      {
        queues: [PLATFORM_TASK_QUEUE],
        activities: {
          beginOrganizationExport: async () => next(begins),
          exportOrganizationBatch: async () => next(batches),
          finishOrganizationExport: async () => next(finishes),
          failOrganizationExport: async () => undefined,
        },
      },
      async (run) => {
        const record = (name: string) =>
          run.record(name, { workflowType: 'organizationExportWorkflow', args: [input] });

        begins = [going];
        batches = [going, going, done];
        finishes = [done];
        await record('organization-export-ready');

        // A large tenant's tombstones take more than one call to finish.
        batches = [done];
        finishes = [going, done];
        await record('organization-export-finish-continues');

        // A row already finished: asking again writes nothing.
        begins = [done];
        batches = [done];
        finishes = [done];
        await record('organization-export-already-finished');

        // A step that refused something, and has already recorded why.
        begins = [going];
        batches = [going, { state: 'failed', code: 'RECORD_REFUSED' }];
        finishes = [done];
        await record('organization-export-step-failed');

        // An Activity that can never succeed by retrying.
        batches = [
          ApplicationFailure.create({ type: 'AppError', message: 'Refused', nonRetryable: true }),
        ];
        await record('organization-export-activity-failed');

        // A store that stayed down until retries ran out. Failing it non-retryably here keeps this quick, and
        // the workflow only reads the type.
        batches = [
          ApplicationFailure.create({
            type: 'STORE_UNAVAILABLE',
            message: 'The object store did not answer',
            nonRetryable: true,
          }),
        ];
        await record('organization-export-store-unavailable');
      },
    );
  }, 120_000);
});
