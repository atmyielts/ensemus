// FOUND-04, ADR-024 D2: dumps Temporal's real database and looks for planted secrets. The unprotected
// control shows the scan works: without it, a passing test could just mean a blind scan.
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { bundleWorkflowCode, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { createLogger } from '@ensemus/telemetry';
import { compose, repoRoot } from '../helpers/stack';

const here = dirname(fileURLToPath(import.meta.url));
const ADDRESS = '127.0.0.1:57233';

function dumpTemporal(): string {
  return ['temporal', 'temporal_visibility']
    .map((db) => compose('exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', db))
    .join('\n');
}

function contains(dump: string, text: string) {
  const bytes = Buffer.from(text);
  return (
    dump.includes(text) ||
    dump.toLowerCase().includes(bytes.toString('hex')) ||
    dump.includes(bytes.toString('base64').replace(/=+$/, ''))
  );
}

describe('Temporal persistence', () => {
  const key = randomBytes(32).toString('base64');
  const protectedCanary = `CANARYPROTECTED${randomUUID().replaceAll('-', '')}`;
  const controlCanary = `CANARYCONTROL${randomUUID().replaceAll('-', '')}`;
  let connection: NativeConnection;
  let clientConnection: Connection;

  const logLines: string[] = [];

  beforeAll(async () => {
    Runtime.install({
      logger: createTemporalLogger(createLogger('test', (line) => logLines.push(line))),
      telemetryOptions: { logging: { filter: 'WARN', forward: {} } },
    });
    connection = await NativeConnection.connect({ address: ADDRESS });
    clientConnection = await Connection.connect({ address: ADDRESS });
  });

  afterAll(async () => {
    await connection?.close();
    await clientConnection?.close();
  });

  async function runCanary(canary: string, withProtection: boolean) {
    const taskQueue = `canary-${randomUUID()}`;
    const converterPath = join(repoRoot, 'packages/workflows/src/failure-converter.ts');
    const { code } = await bundleWorkflowCode({
      workflowsPath: join(here, 'fixtures/canary-workflows.ts'),
      ...(withProtection ? { failureConverterPath: converterPath } : {}),
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} },
    });
    const codec = new AesGcmPayloadCodec(key);
    const worker = await Worker.create({
      connection,
      namespace: 'default',
      taskQueue,
      workflowBundle: { code },
      activities: {
        async failWith(text: string) {
          throw new Error(`activity failed with ${text}`);
        },
      },
      ...(withProtection
        ? { dataConverter: { payloadCodecs: [codec], failureConverterPath: converterPath } }
        : {}),
    });
    const client = new Client({
      connection: clientConnection,
      namespace: 'default',
      ...(withProtection
        ? {
            dataConverter: { payloadCodecs: [codec], failureConverterPath: converterPath },
          }
        : {}),
    });
    await worker.runUntil(async () => {
      const handle = await client.workflow.start('canaryWorkflow', {
        args: [canary],
        taskQueue,
        workflowId: `canary-${randomUUID()}`,
      });
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    });
  }

  it('keeps input and error text unreadable when protection is on', async () => {
    await runCanary(protectedCanary, true);
    const dump = dumpTemporal();
    expect(dump.length).toBeGreaterThan(10_000);
    expect(contains(dump, protectedCanary)).toBe(false);
  });

  it('keeps that text out of the worker logs, while still recording the failure', () => {
    const logs = logLines.join(String.fromCharCode(10));
    expect(logs).toContain('temporal.');
    expect(logs).toContain('errorCode');
    expect(logs).not.toContain(protectedCanary);
  });

  it('control: the same scan does find the text when protection is off', async () => {
    await runCanary(controlCanary, false);
    expect(contains(dumpTemporal(), controlCanary)).toBe(true);
  });
});
