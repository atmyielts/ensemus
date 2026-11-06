// Writes the replay histories of the activation probe (ADR-028 FD-23). Needs a Temporal from
// compose.capture.yaml, and skips otherwise:
//   ENSEMUS_CAPTURE_REPLAY=1 pnpm exec vitest run --project replay tests/replay/capture-model-probe.test.ts
// It only adds files. Commit what it writes, and tests/replay/replay.test.ts replays them from then on.
import { ApplicationFailure } from '@temporalio/common';
import { describe, it } from 'vitest';
import { AGENT_TASK_QUEUE } from '@ensemus/workflows/constants';
import { randomUUID } from 'node:crypto';
import { capturing, withCaptureWorkers } from './capture-support';

/** Synthetic IDs, and nothing else, as with every payload in the corpus. */
const input = {
  organizationId: '6f1c2c6e-1111-4111-8111-111111111111',
  modelProfileId: '6f1c2c6e-2222-4222-8222-222222222222',
};

describe.skipIf(!capturing)('capture the model probe', () => {
  it('records each path through the workflow', async () => {
    let answer: () => Promise<'passed' | 'failed' | 'skipped'> = async () => 'passed';
    await withCaptureWorkers(
      {
        activities: { runModelProbe: () => answer() },
        // The first takes the workflow. The second is the name the workflow sends its Activity to.
        queues: [`replay-${randomUUID()}`, AGENT_TASK_QUEUE],
      },
      async (run) => {
        const record = (name: string) =>
          run.record(name, { workflowType: 'modelProbeWorkflow', args: [input] });
        answer = async () => 'passed';
        await record('model-probe-passed');
        answer = async () => 'failed';
        await record('model-probe-failed');
        answer = async () => 'skipped';
        await record('model-probe-skipped');
        answer = async () => {
          throw ApplicationFailure.retryable('Database gone', 'TEST_FAILURE');
        };
        await record('model-probe-activity-failed');
      },
    );
  }, 120_000);
});
