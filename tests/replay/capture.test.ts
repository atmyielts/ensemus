// Writes the replay corpus from a real Temporal server. Run this only when workflows deliberately
// change, then commit the new histories alongside the patched workflow code:
//   ENSEMUS_CAPTURE_REPLAY=1 pnpm exec vitest run --project replay
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';
import { describe, it } from 'vitest';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';

const ADDRESS = '127.0.0.1:57233';
const capture = process.env.ENSEMUS_CAPTURE_REPLAY === '1';

describe.skipIf(!capture)('capture replay corpus', () => {
  it('records each path through the workflows', async () => {
    const connection = await NativeConnection.connect({ address: ADDRESS });
    const clientConnection = await Connection.connect({ address: ADDRESS });
    const taskQueue = `replay-${randomUUID()}`;
    const dataConverter = {
      payloadCodecs: [new AesGcmPayloadCodec(REPLAY_KEY)],
      failureConverterPath: FAILURE_CONVERTER,
    };
    const { code } = await bundleWorkflowCode({
      workflowsPath: WORKFLOWS,
      failureConverterPath: FAILURE_CONVERTER,
    });

    let reviewOutcome: 'approved' | 'denied' = 'approved';
    const activities = {
      recordProbeStep: async () => undefined,
      prepareWork: async () => ({ status: 'running', needsReview: reviewNeeded }),
      produceChecklistArtifact: async () => ({ artifactId: randomUUID() }),
      requestReview: async () => ({
        approvalId: '00000000-0000-4000-8000-000000000001',
        expiresAtMs: Date.now() + 60_000,
      }),
      reviewState: async () => reviewOutcome,
      expireReview: async () => undefined,
      verifyAndComplete: async () => 'completed',
      markFailed: async () => undefined,
      sendReminders: async () => 0,
    };
    let reviewNeeded = false;

    const worker = await Worker.create({
      connection,
      namespace: 'default',
      taskQueue,
      workflowBundle: { code },
      activities,
      dataConverter,
    });
    const client = new Client({
      connection: clientConnection,
      namespace: 'default',
      dataConverter,
    });
    const input = {
      organizationId: '00000000-0000-4000-8000-00000000000a',
      workUnitId: '00000000-0000-4000-8000-00000000000b',
    };

    await worker.runUntil(async () => {
      const save = async (
        name: string,
        handle: { fetchHistory(): Promise<Parameters<typeof historyToJSON>[0]> },
      ) => {
        const history = await handle.fetchHistory();
        writeFileSync(join(repoRoot, CORPUS_DIR, `${name}.json`), historyToJSON(history));
      };

      const run = async (name: string, needsReview: boolean, signal: boolean) => {
        reviewNeeded = needsReview;
        const handle = await client.workflow.start('workUnitWorkflow', {
          args: [input],
          taskQueue,
          workflowId: `replay-${name}-${randomUUID()}`,
        });
        if (signal) {
          await new Promise((done) => setTimeout(done, 1_500));
          await handle.signal('approvalResolved');
        }
        await handle.result();
        await save(name, handle);
      };

      await run('work-unit-no-review', false, false);
      reviewOutcome = 'approved';
      await run('work-unit-review-approved', true, true);
      reviewOutcome = 'denied';
      await run('work-unit-review-denied', true, true);

      const probe = await client.workflow.start('platformProbeWorkflow', {
        args: [{ probeId: '00000000-0000-4000-8000-00000000000c' }],
        taskQueue,
        workflowId: `replay-probe-${randomUUID()}`,
      });
      await new Promise((done) => setTimeout(done, 1_000));
      await probe.signal('releaseProbe');
      await probe.result();
      await save('platform-probe', probe);

      const reminders = await client.workflow.start('tenantRemindersWorkflow', {
        args: [{ organizationId: input.organizationId }],
        taskQueue,
        workflowId: `replay-reminders-${randomUUID()}`,
      });
      await reminders.result();
      await save('tenant-reminders', reminders);
    });
    await connection.close();
    await clientConnection.close();
  }, 120_000);
});
