import { createMinimalContextCompiler } from '@ensemus/agent-runtime/context';
import { createToolGateway } from '@ensemus/agent-runtime/tools';
import { createContextSource } from '@ensemus/application/ai-context-source';
import {
  checkRunInputDispatch,
  createRunTranscriptPurge,
} from '@ensemus/application/ai-input-ledger';
import { createEgressLog, loadTenantPolicyBundle } from '@ensemus/application/ai-egress-log';
import {
  admitMainModelDispatchInTx,
  receiveMainInputSnapshotInTx,
} from '@ensemus/application/ai-model-admission';
import { externalActionPort } from '@ensemus/application/ai-external-action-port';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { loadProfileForProbe } from '@ensemus/application/ai-model-probe-store';
import { createProfileStore } from '@ensemus/application/ai-model-profiles';
import { createTurnStore, purgeEndedRunTranscript } from '@ensemus/application/ai-runs';
import { createApprovalBinder } from '@ensemus/application/ai-tool-approvals';
import { createToolStepStore } from '@ensemus/application/ai-tool-steps';
import { createUsageLedger } from '@ensemus/application/ai-usage';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { bindKnowledgeModelReceipts } from '@ensemus/application/ai-knowledge-result-consumer';
import { purgeModelJobsForSource } from '@ensemus/application/ai-knowledge-job-content';
import type {
  KnowledgeModelPrincipal,
  KnowledgeCloudSpend,
} from '@ensemus/application/ai-knowledge-ports';
import type { CompileDeps } from '@ensemus/application/knowledge/compiler';
import { createDelegatedWorkPurge } from '@ensemus/application/knowledge/delegated-work-purge';
import { createDelegatedRecordPurge } from '@ensemus/application/knowledge/delegated-record-purge';
import { createEntitlements } from '@ensemus/commercial';
import { loadModelEgressSettings, loadSaasConfig } from '@ensemus/config';
import { withTenantTx, type AgentContext, type AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  createCredentialLender,
  createEndpointGuard,
  createInferenceGateway,
  createModelAdapter,
  createModelRouter,
  createProfileProber,
  createEmbeddingAdapter,
  createKnowledgeModelGateway,
} from '@ensemus/intelligence';
import type { SecretBroker } from '@ensemus/secrets/broker';
import type { S3ObjectStore } from '@ensemus/storage';
import type { Logger } from '@ensemus/telemetry';
import { createAgentActivities } from '@ensemus/workflows/agent-activities';
import { createModelProbeActivities } from '@ensemus/workflows/model-probe-activities';
import { createKnowledgeTranscriptActivities } from '@ensemus/workflows/knowledge-purge-activities';
import { createKnowledgeModelJobActivities } from '@ensemus/workflows/knowledge-model-job-activities';
import { loadAgentCanaries, loadAgentContextLimits } from './agent-settings';
import { createHaltWatcher, HALT_POLL_MS, switchReaderFor } from './kill-switch';
import { createKnowledgeContextCompiler } from './knowledge-context';
import {
  createAgentContextAuthorizer,
  type AuthorizeAgentContext,
} from './agent-context-authorizer';

/** All product ports are bound here; test adapters are never imported by the worker entry point. */
export function createAgentServices(deps: {
  database: AppDatabase;
  secrets: SecretBroker;
  objects: S3ObjectStore;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  knowledgeCloudSpend?: KnowledgeCloudSpend;
  authorizeKnowledgeAgentContext?: AuthorizeAgentContext;
}) {
  const { database, objects, log } = deps;
  const env = deps.env ?? process.env;
  const settings = loadModelEgressSettings(env);
  const entitlements = createEntitlements(database, {
    billingEnabled: loadSaasConfig(env).billingEnabled,
  });
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
  const router = createModelRouter({ profiles, egress, bundle });
  const gateway = createInferenceGateway({
    entitlements,
    ledger,
    withTx: (context, use) => withTenantTx(database, context, use),
    router,
    admitInTx: admitMainModelDispatchInTx,
    receiveInputSnapshotInTx: receiveMainInputSnapshotInTx,
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
  const knowledgeCalls = createKnowledgeCallStore(database, {
    halt,
    ...(deps.knowledgeCloudSpend ? { cloudSpend: deps.knowledgeCloudSpend } : {}),
  });
  const knowledgeGateway = createKnowledgeModelGateway({
    store: knowledgeCalls,
    entitlements,
    credentials,
    guard,
    adapter,
    embeddings: createEmbeddingAdapter(),
    privateEndpoints: settings.privateEndpoints,
    canaries: async () => canaries,
    bundle: (principal) => loadTenantPolicyBundle(database, principal.context),
  });
  const forKnowledgePrincipal = (principal: KnowledgeModelPrincipal): CompileDeps =>
    bindKnowledgeModelReceipts(principal, knowledgeGateway(principal));
  const transcriptActivities = createKnowledgeTranscriptActivities({
    database,
    transcripts: createRunTranscriptPurge(),
    delegatedWorks: createDelegatedWorkPurge({ database, accounting: knowledgeCalls }),
    delegatedRecords: createDelegatedRecordPurge({
      database,
      accounting: knowledgeCalls,
      transcripts: createRunTranscriptPurge(),
    }),
  });
  const source = createContextSource({
    database,
    readObject: (key, maxBytes) => objects.get(key, maxBytes),
  });
  const contextLimits = loadAgentContextLimits(env);
  const context = createKnowledgeContextCompiler({
    database,
    base: createMinimalContextCompiler({ source, limits: contextLimits }),
    limits: contextLimits,
    forPrincipal: forKnowledgePrincipal,
    authorizeAgentContext: createAgentContextAuthorizer({
      database,
      router,
      ...(deps.authorizeKnowledgeAgentContext ? { also: deps.authorizeKnowledgeAgentContext } : {}),
    }),
  });
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
    /** Root's actual main compiler/purpose policy binds this with the current real step and signal. */
    knowledge: { forPrincipal: forKnowledgePrincipal, calls: knowledgeCalls },
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
        modelAccounting: {
          reconcileRun: (organizationId, runId) =>
            knowledgeCalls.reconcileRun(createServiceContext(organizationId), runId),
        },
        transcripts: {
          purgeEnded: (organizationId, runId) =>
            purgeEndedRunTranscript(database, createServiceContext(organizationId), {
              agentRunId: runId,
            }),
        },
        halt,
        haltWatcher: watcher,
      }),
      ...createModelProbeActivities({ database, probe }),
      ...createKnowledgeModelJobActivities({
        database,
        calls: knowledgeCalls,
        forPrincipal: forKnowledgePrincipal,
      }),
      ...transcriptActivities,
      purgeRunTranscripts: async (
        input: Parameters<typeof transcriptActivities.purgeRunTranscripts>[0],
      ) => {
        const jobs = await purgeModelJobsForSource(
          database,
          createServiceContext(input.organizationId),
          knowledgeCalls,
          input,
        );
        const runs = await transcriptActivities.purgeRunTranscripts(input);
        return { removed: runs.removed + jobs.removed };
      },
    },
  };
}
