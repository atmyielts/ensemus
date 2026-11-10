// Knowledge fixtures that go through the same native compositions production uses: the raw-object
// port the web and worker runtimes install, the agent worker's transcript and delegated-Work purge
// activity, and a person whose session proved a second factor. Test-only memory transports; nothing
// here is a provider qualification, and nothing bypasses a guard real callers face.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { createOrganization, openAppDatabase } from '@ensemus/database';
import type { ObjectStore } from '@ensemus/application';
import { withRawKnowledgeObjects } from '@ensemus/application/knowledge/raw-objects';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import {
  confirmDelegatedWorkPurgeInTx,
  createDelegatedWorkPurge,
} from '@ensemus/application/knowledge/delegated-work-purge';
import { createDelegatedRecordPurge } from '@ensemus/application/knowledge/delegated-record-purge';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createKnowledgeTranscriptActivities } from '@ensemus/workflows/knowledge-purge-activities';
import { runSourcePurge } from '@ensemus/application/knowledge/purge';
import { createObjectDeletionLifecycle } from '@ensemus/application/saas/object-deletion';
import { createServiceContext } from '@ensemus/database/service';
import { createKnowledgePurgePorts } from '../../workers/workflow/src/knowledge-ports';
import { makePerson, nativePersonContext, proveSecondFactor } from './product';

export type MemoryTransport = ObjectStore &
  Required<Pick<ObjectStore, 'putSingleAttempt' | 'deleteForPurge' | 'isPhysicallyAbsent'>>;

/**
 * A plain-object memory transport exposing the single-attempt PUT and capability-backed purge the
 * native runtime store provides. Plain own properties, so a test can spread it and override one
 * operation. It is never handed to product code directly: wrap it with `nativeKnowledgeStore`.
 */
export function memoryTransport(objects = new Map<string, Buffer>()): MemoryTransport {
  return {
    put: async (key, body) => {
      objects.set(key, Buffer.from(body));
    },
    putSingleAttempt: async (key, body) => {
      objects.set(key, Buffer.from(body));
      return { transport: 'written' };
    },
    get: async (key) => {
      const body = objects.get(key);
      if (!body) throw new Error('MISSING');
      return Buffer.from(body);
    },
    delete: async (key) => {
      objects.delete(key);
    },
    exists: async (key) => objects.has(key),
    deleteForPurge: async (key) => {
      objects.delete(key);
      return { transport: 'deleted', capabilityVerified: true };
    },
    isPhysicallyAbsent: async (key) => !objects.has(key),
  };
}

/**
 * Installs the native raw Knowledge port on a transport exactly as apps/web and workers/workflow
 * wrap theirs. Raw Knowledge bytes can then only be written or deleted through `rawKnowledge`,
 * under SQL admission; a direct put/delete of a knowledge key through the store is refused.
 */
export function nativeKnowledgeStore<T extends ObjectStore>(database: AppDatabase, transport: T) {
  return withRawKnowledgeObjects({ database, store: transport });
}

/**
 * The agent worker's purge activity for one closed source: run transcripts, then delegated Work and
 * records, with the agent role, exactly as workers/workflow/src/agent-composition.ts composes it.
 */
export async function purgeAgentMaterialsForSource(
  agent: AppDatabase,
  input: { organizationId: string; sourceId: string },
) {
  const accounting = createKnowledgeCallStore(agent, { halt: createHaltCheck() });
  const activities = createKnowledgeTranscriptActivities({
    database: agent,
    transcripts: createRunTranscriptPurge(),
    delegatedWorks: createDelegatedWorkPurge({ database: agent, accounting }),
    delegatedRecords: createDelegatedRecordPurge({
      database: agent,
      accounting,
      transcripts: createRunTranscriptPurge(),
    }),
  });
  return activities.purgeRunTranscripts(input);
}

/**
 * The whole knowledge purge workflow for one closed source, in its production order: the agent
 * worker's transcript/delegated-Work activity, then the knowledge worker's purge with the runtime's
 * artifact/archive lifecycle bindings and the native raw object port of `store`.
 */
export async function runNativeKnowledgePurge(deps: {
  app: AppDatabase;
  agent: AppDatabase;
  store: ObjectStore;
  organizationId: string;
  sourceId: string;
}) {
  await purgeAgentMaterialsForSource(deps.agent, deps);
  const lifecycle = createObjectDeletionLifecycle({ database: deps.app, store: deps.store });
  return runSourcePurge(
    deps.app,
    deps.store,
    createServiceContext(deps.organizationId),
    { sourceId: deps.sourceId },
    {
      ...createKnowledgePurgePorts({
        database: deps.app,
        store: deps.store,
        derivedLifecycle: lifecycle.derived,
        archiveLifecycle: lifecycle.archive,
      }),
      delegatedWorks: { confirmInTx: confirmDelegatedWorkPurgeInTx },
    },
  );
}

/**
 * An organization owner with a real native session handoff and a fresh second-factor proof, which is
 * what interactive privileges such as agent publication require of an actual person.
 */
export async function nativeMfaOwner(
  database: ReturnType<typeof openAppDatabase>['db'],
  label = 'knowledge-owner',
  commercialMode: 'byom' | 'sovereign' = 'byom',
): Promise<TenantContext> {
  const person = await makePerson(label);
  const { organizationId } = await createOrganization(database, {
    userId: person.userId,
    name: 'Same Name Ltd',
    commercialMode,
  });
  await proveSecondFactor(person);
  return nativePersonContext(database, person, organizationId);
}
