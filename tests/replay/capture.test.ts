// Writes the replay corpus from a real Temporal server. Run this only when workflows deliberately
// change, then commit the new histories alongside the patched workflow code:
//   ENSEMUS_CAPTURE_REPLAY=1 pnpm exec vitest run --project replay
// It only adds files: a history recorded before a patch is what proves the patch keeps it working,
// so those are never written again. Each capture's paths are named for the patch they follow.
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

    // What each read of the approval finds, in order. The last one repeats.
    let reviewStates: string[] = ['approved'];
    let reviewMs = 60_000;
    const activities = {
      recordProbeStep: async () => undefined,
      prepareWork: async () => ({ status: 'running', needsReview: reviewNeeded }),
      produceChecklistArtifact: async () => ({ artifactId: randomUUID() }),
      requestReview: async () => ({
        approvalId: '00000000-0000-4000-8000-000000000001',
        expiresAtMs: Date.now() + reviewMs,
      }),
      reviewState: async () =>
        reviewStates.length > 1 ? reviewStates.shift() : (reviewStates[0] ?? 'approved'),
      expireReview: async () => 'expired',
      verifyAndComplete: async () => 'verifying',
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

      const run = async (name: string, needsReview: boolean, signals: number) => {
        reviewNeeded = needsReview;
        const handle = await client.workflow.start('workUnitWorkflow', {
          args: [input],
          taskQueue,
          workflowId: `replay-${name}-${randomUUID()}`,
        });
        for (let i = 0; i < signals; i++) {
          await new Promise((done) => setTimeout(done, 1_500));
          await handle.signal('approvalResolved');
        }
        await handle.result();
        await save(name, handle);
      };

      // The review-wait-loop patch: approved, denied, woken by something else, and timing out.
      reviewStates = ['pending', 'approved'];
      await run('work-unit-review-wait-approved', true, 1);
      reviewStates = ['pending', 'denied'];
      await run('work-unit-review-wait-denied', true, 1);
      reviewStates = ['pending', 'pending', 'approved'];
      await run('work-unit-review-wait-other-signal', true, 2);
      reviewStates = ['pending'];
      reviewMs = 2_000;
      await run('work-unit-review-wait-timeout', true, 0);
    });
    await connection.close();
    await clientConnection.close();
  }, 120_000);
});
