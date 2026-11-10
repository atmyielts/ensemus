// What the workflow does with each answer, on a real Temporal server and with the real workflow code.
// Activities are stand-ins here so that answers a real run only rarely gets, such as a decision landing
// in the same moment the timer fires, happen every time. Replay proves a history still fits the code.
// It cannot prove the code does the right thing, because a stand-in's answer is simply recorded.
import { randomUUID } from 'node:crypto';
import { AppError } from '@ensemus/application';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { createLogger } from '@ensemus/telemetry';
import { ApplicationFailure } from '@temporalio/common';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAILURE_CONVERTER, REPLAY_KEY, WORKFLOWS } from '../replay/corpus';

const ADDRESS = '127.0.0.1:57233';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000001';

type Script = {
  needsReview: boolean;
  reviewMs: number;
  /** What each read of the approval finds, in order. The last one repeats. */
  reviewStates: string[];
  /** What each try at expiring it finds, in order. The last one repeats. */
  expireStates: string[];
  checklist: () => Promise<{ artifactId: string }>;
};

describe('the work unit workflow', () => {
  let connection: NativeConnection;
  let clientConnection: Connection;
  let client: Client;
  let worker: Worker;
  let running: Promise<void>;
  const taskQueue = `behaviour-${randomUUID()}`;
  const dataConverter = {
    payloadCodecs: [new AesGcmPayloadCodec(REPLAY_KEY)],
    failureConverterPath: FAILURE_CONVERTER,
  };

  let script: Script;
  let calls: string[];
  const next = (states: string[]) => (states.length > 1 ? states.shift() : states[0]);

  beforeAll(async () => {
    Runtime.install({
      logger: createTemporalLogger(createLogger('test', () => undefined)),
      telemetryOptions: { logging: { filter: 'WARN', forward: {} } },
    });
    connection = await NativeConnection.connect({ address: ADDRESS });
    clientConnection = await Connection.connect({ address: ADDRESS });
    client = new Client({ connection: clientConnection, namespace: 'default', dataConverter });
    const { code } = await bundleWorkflowCode({
      workflowsPath: WORKFLOWS,
      failureConverterPath: FAILURE_CONVERTER,
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} },
    });
    worker = await Worker.create({
      connection,
      namespace: 'default',
      taskQueue,
      workflowBundle: { code },
      dataConverter,
      activities: {
        prepareWork: async () => {
          calls.push('prepareWork');
          return { status: 'running', needsReview: script.needsReview };
        },
        produceChecklistArtifact: async () => {
          calls.push('produceChecklistArtifact');
          return script.checklist();
        },
        requestReview: async () => {
          calls.push('requestReview');
          return { approvalId: APPROVAL_ID, expiresAtMs: Date.now() + script.reviewMs };
        },
        reviewState: async () => {
          calls.push('reviewState');
          return next(script.reviewStates);
        },
        expireReview: async () => {
          calls.push('expireReview');
          return next(script.expireStates);
        },
        verifyAndComplete: async () => {
          calls.push('verifyAndComplete');
          return 'verifying';
        },
        markFailed: async () => {
          calls.push('markFailed');
        },
      },
    });
    running = worker.run();
  });

  afterAll(async () => {
    worker?.shutdown();
    await running;
    await connection?.close();
    await clientConnection?.close();
  });

  beforeEach(() => {
    calls = [];
    script = {
      needsReview: true,
      reviewMs: 1,
      reviewStates: ['pending'],
      expireStates: ['expired'],
      checklist: async () => ({ artifactId: randomUUID() }),
    };
  });

  const run = () =>
    client.workflow.execute('workUnitWorkflow', {
      args: [{ organizationId: randomUUID(), workUnitId: randomUUID() }],
      taskQueue,
      workflowId: `behaviour-${randomUUID()}`,
    }) as Promise<{ outcome: string }>;

  describe('when the time for a review runs out', () => {
    it('reports expired, and goes no further, when the expiry really happened', async () => {
      const { outcome } = await run();
      expect(outcome).toBe('expired');
      expect(calls).toContain('expireReview');
      expect(calls).not.toContain('verifyAndComplete');
    });

    it.each([
      ['approval', 'approved', 'verifying'],
      ['denial', 'denied', 'denied'],
      ['closure', 'cancelled', 'cancelled'],
    ])('takes the %s that beat the timer as the answer', async (_, state, expected) => {
      script.expireStates = [state];
      const { outcome } = await run();
      expect(outcome).toBe(expected);
      expect(calls.includes('verifyAndComplete')).toBe(state === 'approved');
    });

    it('reports nothing, and asks again, while the database says it is not over yet', async () => {
      // Its clock is ahead of the database's, or the transaction lost a race.
      script.expireStates = ['pending', 'pending', 'expired'];
      const started = Date.now();
      const { outcome } = await run();
      expect(outcome).toBe('expired');
      expect(calls.filter((call) => call === 'expireReview')).toHaveLength(3);
      // It waits between asking, instead of hammering the database.
      expect(Date.now() - started).toBeGreaterThanOrEqual(2 * 5_000);
    }, 60_000);
  });

  describe('when an Activity cannot succeed', () => {
    it('reports a refusal at once, with no retries, and ends as failed', async () => {
      let attempts = 0;
      script.checklist = async () => {
        attempts += 1;
        throw new AppError('INVALID_INPUT');
      };
      const { outcome } = await run();
      expect(outcome).toBe('failed');
      expect(attempts).toBe(1);
      expect(calls).toContain('markFailed');
      expect(calls).not.toContain('verifyAndComplete');
    });

    it('ends quietly when the work was stopped, without reporting a failure', async () => {
      script.checklist = async () => {
        throw ApplicationFailure.create({
          type: 'WORK_STOPPED',
          message: 'Work stopped',
          nonRetryable: true,
        });
      };
      const { outcome } = await run();
      expect(outcome).toBe('cancelled');
      expect(calls).not.toContain('markFailed');
    });

    it('keeps retrying anything else, because it may only be an outage', async () => {
      let attempts = 0;
      script.needsReview = false;
      script.checklist = async () => {
        attempts += 1;
        if (attempts < 4) throw new Error('connection refused');
        return { artifactId: randomUUID() };
      };
      const { outcome } = await run();
      expect(outcome).toBe('verifying');
      expect(attempts).toBe(4);
      expect(calls).not.toContain('markFailed');
    }, 30_000);
  });
});
