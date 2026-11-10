// Records externalActionWorkflow's paths from a real Temporal server, with stub Activities and synthetic IDs.
// Skips unless ENSEMUS_CAPTURE_REPLAY=1, and needs compose.capture.yaml's Temporal (docs/06-delivery/m3-slices.md).
// A recorded history is never rewritten, so a later workflow change has to keep replaying these.
//
// `external-action-connector-never-came` needs the send to time out waiting for a worker, which takes an
// hour as written. It is recorded from a copy of the workflow with that one number changed. A timeout is not
// part of what replay compares, and the point is the real SCHEDULE_TO_START failure from a real server.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { CONNECTOR_TASK_QUEUE, PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import type {
  ExternalActionOutcome,
  InterruptedStep,
  ReconcileStepResult,
  SendStep,
} from '@ensemus/workflows/schemas';
import { repoRoot } from '../helpers/stack';
import { capturing, withCaptureWorkers } from './capture-support';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY } from './corpus';

const INPUT = {
  organizationId: '00000000-0000-4000-8000-0000000000aa',
  externalActionId: '00000000-0000-4000-8000-0000000000bb',
};

const lost = () => ApplicationFailure.create({ type: 'Lost', message: 'Lost', nonRetryable: true });

type Answer<T> = T | 'throw';

/** What each Activity answers, in order. The last one repeats, and a throw fails that call for good. */
type Script = {
  sends: Answer<SendStep>[];
  inspects?: InterruptedStep[];
  reconciles?: Answer<ReconcileStepResult>[];
  outcome?: ExternalActionOutcome;
};

const PATHS: readonly (Script & { name: string; ends: ExternalActionOutcome })[] = [
  { name: 'external-action-sent', sends: [{ step: 'sent' }], ends: 'sent' },
  { name: 'external-action-refused', sends: [{ step: 'failed' }], ends: 'failed' },
  { name: 'external-action-stopped-by-recheck', sends: [{ step: 'cancelled' }], ends: 'cancelled' },
  {
    name: 'external-action-retry-then-sent',
    sends: [{ step: 'retry', afterMs: 1000 }, { step: 'sent' }],
    ends: 'sent',
  },
  {
    name: 'external-action-timeout-after-send',
    sends: [{ step: 'reconcile' }],
    reconciles: ['unknown'],
    ends: 'unknown',
  },
  {
    name: 'external-action-worker-died',
    sends: ['throw'],
    inspects: ['attempt_open'],
    reconciles: ['unknown'],
    ends: 'unknown',
  },
  {
    name: 'external-action-worker-died-before-record',
    sends: ['throw', { step: 'sent' }],
    inspects: ['nothing_sent'],
    ends: 'sent',
  },
  {
    name: 'external-action-answer-lost',
    sends: ['throw'],
    inspects: ['settled'],
    outcome: 'sent',
    ends: 'sent',
  },
  {
    name: 'external-action-reconcile-found',
    sends: [{ step: 'reconcile' }],
    reconciles: ['sent'],
    ends: 'sent',
  },
  {
    name: 'external-action-reconcile-then-retry',
    sends: [{ step: 'reconcile' }, { step: 'sent' }],
    reconciles: ['retry'],
    ends: 'sent',
  },
  {
    name: 'external-action-reconcile-never-ran',
    sends: [{ step: 'reconcile' }],
    reconciles: ['throw'],
    ends: 'unknown',
  },
  {
    name: 'external-action-sends-lost-exhausted',
    sends: ['throw'],
    inspects: ['nothing_sent'],
    outcome: 'failed',
    ends: 'failed',
  },
];

function activitiesFor(script: Script) {
  const take = <T>(list: T[] | undefined, fallback: T): T =>
    list && list.length > 1 ? (list.shift() as T) : (list?.[0] ?? fallback);
  const orThrow = <T>(answer: Answer<T>): T => {
    if (answer === 'throw') throw lost();
    return answer;
  };
  return {
    sendExternalAction: async () => orThrow(take(script.sends, { step: 'sent' })),
    reconcileExternalAction: async () => orThrow(take(script.reconciles, 'unknown')),
    inspectInterruptedAction: async () => take(script.inspects, 'settled'),
    settledActionOutcome: async () => script.outcome ?? 'failed',
    failUnsentAction: async () => undefined,
    concludeWithoutAnswer: async () => 'unknown' as const,
  };
}

const address = () => `127.0.0.1:${process.env.ENSEMUS_TEST_TEMPORAL_PORT ?? '57233'}`;

describe.skipIf(!capturing)('capture externalActionWorkflow', () => {
  it.each(PATHS)(
    'records $name, which ends $ends',
    async (path) => {
      await withCaptureWorkers(
        { activities: activitiesFor(path), queues: [PLATFORM_TASK_QUEUE, CONNECTOR_TASK_QUEUE] },
        async (run) => {
          await run.record(path.name, {
            workflowType: 'externalActionWorkflow',
            args: [INPUT],
          });
        },
      );
    },
    // The durable timers are real here, and the path that loses every send waits about eight minutes.
    600_000,
  );

  it('records a send no worker ever picked up, from a real timeout', async () => {
    const name = 'external-action-connector-never-came';
    const file = join(repoRoot, CORPUS_DIR, `${name}.json`);
    if (existsSync(file)) return;

    // Beside the original, where its relative imports work. Nothing but this capture ever reads it.
    const source = join(repoRoot, 'packages/workflows/src/external-action-workflow.ts');
    const copy = join(repoRoot, 'packages/workflows/src/external-action-workflow.capture.ts');
    const text = readFileSync(source, 'utf8');
    expect(text).toContain("scheduleToStartTimeout: '1 hour'");
    writeFileSync(
      copy,
      text.replace("scheduleToStartTimeout: '1 hour'", "scheduleToStartTimeout: '3 seconds'"),
    );
    try {
      const { code } = await bundleWorkflowCode({
        workflowsPath: copy,
        failureConverterPath: FAILURE_CONVERTER,
      });
      const dataConverter = {
        payloadCodecs: [new AesGcmPayloadCodec(REPLAY_KEY)],
        failureConverterPath: FAILURE_CONVERTER,
      };
      const connection = await NativeConnection.connect({ address: address() });
      const clientConnection = await Connection.connect({ address: address() });
      const failed: unknown[] = [];
      // Only the platform queue: nobody is polling the connector queue, which is the whole of this path.
      const worker = await Worker.create({
        connection,
        namespace: 'default',
        taskQueue: PLATFORM_TASK_QUEUE,
        workflowBundle: { code },
        activities: {
          inspectInterruptedAction: async () => 'nothing_sent' as const,
          failUnsentAction: async (input: { code: string }) => {
            failed.push(input.code);
          },
          settledActionOutcome: async () => 'failed' as const,
          concludeWithoutAnswer: async () => 'unknown' as const,
        },
        dataConverter,
      });
      const running = worker.run();
      const client = new Client({
        connection: clientConnection,
        namespace: 'default',
        dataConverter,
      });
      try {
        const handle = await client.workflow.start('externalActionWorkflow', {
          args: [INPUT],
          taskQueue: PLATFORM_TASK_QUEUE,
          workflowId: `replay-${name}-${randomUUID()}`,
        });
        await expect(handle.result()).resolves.toMatchObject({ outcome: 'failed' });
        expect(failed).toEqual(['CONNECTOR_UNAVAILABLE']);
        writeFileSync(file, historyToJSON(await handle.fetchHistory()));
      } finally {
        worker.shutdown();
        await running;
        await clientConnection.close();
        await connection.close();
      }
    } finally {
      rmSync(copy, { force: true });
    }
  }, 120_000);
});
