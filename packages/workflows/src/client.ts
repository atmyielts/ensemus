// For the dispatcher, smoke tests and operators. The web tier may not import this (lint rule).
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { AesGcmPayloadCodec } from './codec';
import { PLATFORM_TASK_QUEUE, TEMPORAL_CHANNEL_ARGS } from './constants';
import { probeInputSchema, type ProbeInput, type ProbeResult } from './schemas';
import type { platformProbeWorkflow } from './workflows';

export async function connectClient(options: {
  address: string;
  namespace: string;
  codecKey: string;
}) {
  const connection = await Connection.connect({
    address: options.address,
    channelArgs: TEMPORAL_CHANNEL_ARGS,
  });
  const client = new Client({
    connection,
    namespace: options.namespace,
    dataConverter: {
      // Temporal loads the failure converter by path and ignores an object passed directly.
      failureConverterPath: fileURLToPath(new URL('./failure-converter.ts', import.meta.url)),
      payloadCodecs: [new AesGcmPayloadCodec(options.codecKey)],
    },
  });
  return { client, close: () => connection.close() };
}

/** Starts a probe. Input is validated here, so free text cannot reach Temporal (ADR-024 D2). */
export function startProbe(client: Client, input: ProbeInput) {
  const args: [ProbeInput] = [probeInputSchema.parse(input)];
  return client.workflow.start<typeof platformProbeWorkflow>('platformProbeWorkflow', {
    args,
    taskQueue: PLATFORM_TASK_QUEUE,
    workflowId: `probe-${input.probeId}`,
  });
}

export type { ProbeResult };
