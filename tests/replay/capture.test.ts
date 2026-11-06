// Writes the replay corpus from a real Temporal server. Run this only when workflows deliberately
// change, then commit the new histories alongside the patched workflow code:
//   ENSEMUS_CAPTURE_REPLAY=1 pnpm exec vitest run --project replay
// It only adds files: a history recorded before a patch is what proves the patch keeps it working,
// so those are never written again. Each capture's paths are named for the patch they follow.
//
// A path that current code can no longer take, such as one from before a patch, is recorded from the
// workflow file of the commit that could. ENSEMUS_CAPTURE_WORKFLOWS names that file, which has to sit
// where it can find @temporalio/workflow, so inside packages/workflows/src:
//   git show 4c207fd:packages/workflows/src/workflows.ts > packages/workflows/src/workflows.old.ts
//   ENSEMUS_CAPTURE_REPLAY=1 ENSEMUS_CAPTURE_WORKFLOWS=packages/workflows/src/workflows.old.ts \
//     ENSEMUS_CAPTURE_ONLY=work-unit-review-timeout-pre-patch pnpm exec vitest run --project replay
// Then delete that file. Nothing but this capture ever reads it.
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';
import { describe, it } from 'vitest';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';

const ADDRESS = '127.0.0.1:57233';
const capture = process.env.ENSEMUS_CAPTURE_REPLAY === '1';
const only = process.env.ENSEMUS_CAPTURE_ONLY;
const workflows = process.env.ENSEMUS_CAPTURE_WORKFLOWS;

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
      workflowsPath: workflows ? join(repoRoot, workflows) : WORKFLOWS,
      failureConverterPath: FAILURE_CONVERTER,
    });

    // What each read of the approval finds, in order. The last one repeats.
    let reviewStates: string[] = ['approved'];
    // What each try at expiring it finds, in order. The last one repeats.
    let expireStates: string[] = ['expired'];
    let reviewMs = 60_000;
    let checklist = async () => ({ artifactId: randomUUID() });
    const activities = {
      recordProbeStep: async () => undefined,
      prepareWork: async () => ({ status: 'running', needsReview: reviewNeeded }),
      produceChecklistArtifact: async () => checklist(),
      requestReview: async () => ({
        approvalId: '00000000-0000-4000-8000-000000000001',
        expiresAtMs: Date.now() + reviewMs,
      }),
      reviewState: async () =>
        reviewStates.length > 1 ? reviewStates.shift() : (reviewStates[0] ?? 'approved'),
      expireReview: async () =>
        expireStates.length > 1 ? expireStates.shift() : (expireStates[0] ?? 'expired'),
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
        // A history that exists stays as recorded, and a pre-patch one needs the old code, so it is
        // only ever recorded by asking for it by name.
        const wanted = only
          ? name === only
          : !name.endsWith('pre-patch') && !existsSync(join(repoRoot, CORPUS_DIR, `${name}.json`));
        if (!wanted) return;
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
      // The database says it is not over yet, so the workflow waits and asks again.
      reviewStates = ['pending'];
      expireStates = ['pending', 'expired'];
      await run('work-unit-review-wait-settle-retry', true, 0);
      expireStates = ['expired'];
      // Current code never takes this one. It is recorded from before the patch, as above.
      reviewStates = ['pending'];
      await run('work-unit-review-timeout-pre-patch', true, 0);

      // A step that can never succeed ends in the failure path, and a stopped one does not.
      reviewMs = 60_000;
      reviewStates = ['approved'];
      checklist = async () => {
        throw ApplicationFailure.create({ type: 'AppError', nonRetryable: true });
      };
      await run('work-unit-activity-failed', false, 0);
      checklist = async () => {
        throw ApplicationFailure.create({ type: 'WORK_STOPPED', nonRetryable: true });
      };
      await run('work-unit-stopped', false, 0);
    });
    await connection.close();
    await clientConnection.close();
  }, 120_000);
});
