import { createMinimalContextCompiler } from '@ensemus/agent-runtime/context';
import { createToolGateway } from '@ensemus/agent-runtime/tools';
import { createContextSource } from '@ensemus/application/ai-context-source';
import {
  checkRunInputDispatch,
  createRunTranscriptPurge,
} from '@ensemus/application/ai-input-ledger';
import { createEgressLog, loadTenantPolicyBundle } from '@ensemus/application/ai-egress-log';
import { externalActionPort } from '@ensemus/application/ai-external-action-port';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { loadProfileForProbe } from '@ensemus/application/ai-model-probe-store';
import { createProfileStore } from '@ensemus/application/ai-model-profiles';
import { createTurnStore } from '@ensemus/application/ai-runs';
import { createApprovalBinder } from '@ensemus/application/ai-tool-approvals';
import { createToolStepStore } from '@ensemus/application/ai-tool-steps';
import { createUsageLedger } from '@ensemus/application/ai-usage';
import { createEntitlements } from '@ensemus/commercial';
import { loadModelEgressSettings } from '@ensemus/config';
import { withTenantTx, type AgentContext, type AppDatabase } from '@ensemus/database';
import {
  createCredentialLender,
  createEndpointGuard,
  createInferenceGateway,
  createModelAdapter,
  createModelRouter,
  createProfileProber,
} from '@ensemus/intelligence';
import type { SecretBroker } from '@ensemus/secrets/broker';
import type { S3ObjectStore } from '@ensemus/storage';
import type { Logger } from '@ensemus/telemetry';
import { createAgentActivities } from '@ensemus/workflows/agent-activities';
import { createModelProbeActivities } from '@ensemus/workflows/model-probe-activities';
import { createKnowledgeTranscriptActivities } from '@ensemus/workflows/knowledge-purge-activities';
import { loadAgentCanaries, loadAgentContextLimits } from './agent-settings';
import { createHaltWatcher, HALT_POLL_MS, switchReaderFor } from './kill-switch';

/** All product ports are bound here; test adapters are never imported by the worker entry point. */
export function createAgentServices(deps: {
  database: AppDatabase;
  secrets: SecretBroker;
  objects: S3ObjectStore;
  log: Logger;
  env?: NodeJS.ProcessEnv;
}) {
  const { database, objects, log } = deps;
  const env = deps.env ?? process.env;
  const settings = loadModelEgressSettings(env);
  const canaries = loadAgentCanaries(env);
  const halt = createHaltCheck();
  const ledger = createUsageLedger(database);
  const egress = createEgressLog(database);
  const bundle = (context: AgentContext) => loadTenantPolicyBundle(database, context);
  const profiles = createProfileStore(database);
  const adapter = createModelAdapter();
  const guard = createEndpointGuard();
  const credentials = createCredentialLender({
    secrets: deps.secrets,
    reviewInterlock: settings.credentialsReviewed,
  });
  const gateway = createInferenceGateway({
    entitlements: createEntitlements(database),
    ledger,
    withTx: (context, use) => withTenantTx(database, context, use),
    router: createModelRouter({ profiles, egress, bundle }),
    egress,
    guard,
    credentials,
    adapter,
    turns: createTurnStore(database),
    halt,
    privateEndpoints: settings.privateEndpoints,
    canaries: async () => canaries,
    bundle,
  });
  const source = createContextSource({
    database,
    readObject: (key, maxBytes) => objects.get(key, maxBytes),
  });
  const context = createMinimalContextCompiler({ source, limits: loadAgentContextLimits(env) });
  const tools = createToolGateway({
    source,
    externalActions: externalActionPort,
    approvals: createApprovalBinder({ externalActions: externalActionPort, halt }),
    halt,
    store: createToolStepStore({ database, objects }),
  });
  const watcher = createHaltWatcher({ pollMs: HALT_POLL_MS, read: switchReaderFor(database), log });
  const probe = createProfileProber({
    load: (input) => loadProfileForProbe(database, input),
    adapter,
    guard,
    credentials,
    privateEndpoints: settings.privateEndpoints,
    onFailed: (reasonCode) => log.warn('model_probe.failed', { reasonCode }),
  });
  return {
    watcher,
    activities: {
      ...createAgentActivities({
        database,
        gateway: {
          turn: async (context, step, compiled, signal) => {
            await checkRunInputDispatch(database, context);
            return gateway.turn(context, step, compiled, signal);
          },
        },
        tools,
        context,
        usage: ledger,
        halt,
        haltWatcher: watcher,
      }),
      ...createModelProbeActivities({ database, probe }),
      ...createKnowledgeTranscriptActivities({ database, transcripts: createRunTranscriptPurge() }),
    },
  };
}
