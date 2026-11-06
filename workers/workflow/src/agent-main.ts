// The one process that can reach a model, open a model key, or read a prompt (ADR-028 FD-2). It polls only
// the agent queue, runs no workflows, and uses the agent database role. Until the wiring slice lands, its
// Activities refuse, so a deployed stack stays honest: runs fail closed and nothing is simulated.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import { openAgentDatabase } from '@ensemus/database/agent';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { createAgentActivities, type AgentActivityDeps } from '@ensemus/workflows/agent-activities';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { AGENT_TASK_QUEUE } from '@ensemus/workflows/constants';
import { createModelProbeActivities } from '@ensemus/workflows/model-probe-activities';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';

const log = createLogger('agent-worker');
const here = path.dirname(fileURLToPath(import.meta.url));

const refuse = () => {
  throw new Error('NOT_IMPLEMENTED');
};

/** Refuses everything. The wiring slice replaces this with the real gateway, tools and compiler. */
function refusingDeps(database: AgentActivityDeps['database']): AgentActivityDeps {
  return {
    database,
    gateway: { turn: refuse },
    tools: { handle: refuse },
    context: { compile: refuse },
  };
}

async function main() {
  // Must run first. The SDK's default logger would print activity error messages.
  Runtime.install({
    logger: createTemporalLogger(log),
    telemetryOptions: { logging: { filter: 'WARN', forward: {} } },
  });
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  });
  const agent = openAgentDatabase(readSecret('DATABASE_URL_AGENT'));
  const deps = refusingDeps(agent.db);
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: AGENT_TASK_QUEUE,
    activities: {
      ...createAgentActivities(deps),
      ...createModelProbeActivities({ database: agent.db, probe: { probe: refuse } }),
    },
    dataConverter: {
      payloadCodecs: [new AesGcmPayloadCodec(readSecret('TEMPORAL_CODEC_KEY'))],
      failureConverterPath: path.join(here, 'failure-converter.cjs'),
    },
  });

  // The container health check reads this file. Crashes stop updates, so they are never hidden.
  const beat = () => writeFileSync('/tmp/worker-alive', String(Date.now()));
  beat();
  const timer = setInterval(beat, 5_000);
  timer.unref();

  log.info('agent_worker.started', { taskQueue: AGENT_TASK_QUEUE });
  await worker.run();
  log.info('agent_worker.stopped');
  await agent.close();
  await connection.close();
}

main().catch((error: unknown) => {
  log.error('agent_worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
