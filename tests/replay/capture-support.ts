// Shared by the M3 capture files, so that each records its own workflow without touching capture.test.ts.
// Each file skips unless ENSEMUS_CAPTURE_REPLAY=1, and needs a Temporal from compose.capture.yaml.
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { repoRoot } from '../helpers/stack';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from './corpus';

export const capturing = process.env.ENSEMUS_CAPTURE_REPLAY === '1';

const address = () => `127.0.0.1:${process.env.ENSEMUS_TEST_TEMPORAL_PORT ?? '57233'}`;

export type CaptureRun = {
  /** Records one workflow run under this name, unless that history already exists. */
  record(
    name: string,
    start: { workflowType: string; args: unknown[]; signals?: readonly string[] },
  ): Promise<void>;
  /** A second queue's Activities run here too, so a workflow routing to it needs no extra worker. */
  taskQueue: string;
};

/**
 * Runs `body` with workers on the platform and connector queue names that the workflow under capture
 * uses, with stub Activities and the corpus's own key. A recorded history is never rewritten.
 */
export async function withCaptureWorkers(
  options: { activities: object; queues: readonly string[] },
  body: (run: CaptureRun) => Promise<void>,
): Promise<void> {
  const connection = await NativeConnection.connect({ address: address() });
  const clientConnection = await Connection.connect({ address: address() });
  const dataConverter = {
    payloadCodecs: [new AesGcmPayloadCodec(REPLAY_KEY)],
    failureConverterPath: FAILURE_CONVERTER,
  };
  const { code } = await bundleWorkflowCode({
    workflowsPath: WORKFLOWS,
    failureConverterPath: FAILURE_CONVERTER,
  });
  const [taskQueue = `replay-${randomUUID()}`] = options.queues;
  const workers = await Promise.all(
    options.queues.map((queue) =>
      Worker.create({
        connection,
        namespace: 'default',
        taskQueue: queue,
        workflowBundle: { code },
        activities: options.activities,
        dataConverter,
      }),
    ),
  );
  const client = new Client({ connection: clientConnection, namespace: 'default', dataConverter });

  const running = workers.map((worker) => worker.run());
  try {
    await body({
      taskQueue,
      async record(name, start) {
        const file = join(repoRoot, CORPUS_DIR, `${name}.json`);
        if (existsSync(file)) return;
        const handle = await client.workflow.start(start.workflowType, {
          args: start.args,
          taskQueue,
          workflowId: `replay-${name}-${randomUUID()}`,
        });
        for (const signal of start.signals ?? []) {
          await new Promise((done) => setTimeout(done, 1_500));
          await handle.signal(signal);
        }
        await handle.result().catch(() => undefined);
        writeFileSync(file, historyToJSON(await handle.fetchHistory()));
      },
    });
  } finally {
    for (const worker of workers) worker.shutdown();
    await Promise.all(running);
    await clientConnection.close();
    await connection.close();
  }
}
