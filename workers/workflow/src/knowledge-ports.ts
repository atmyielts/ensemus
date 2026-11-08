// Ingestion uses the same deterministic secret scan as model egress. A hit raises protection; it
// does not prove other content safe or replace the fresh policy check before any model call.
import type { IngestDeps } from '@ensemus/application/knowledge/ingest';
import { createKnowledgeArtifactPurge } from '@ensemus/application/knowledge/purge-composition';
import {
  createDerivedArtifactPurge,
  type DerivedArtifactLifecycle,
  type StructuredRecordPurge,
} from '@ensemus/application/knowledge/artifact-provenance';
import {
  createImportedArchivePurge,
  AppError,
  type ArchiveQuarantineLifecycle,
  type ObjectStore,
} from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { assertNoUnresolvedObjectDeletes } from '@ensemus/application/saas/object-deletion';
import { scanForSecrets } from '@ensemus/policy';
import { loadAgentCanaries } from './agent-settings';
import { createParseRunner } from './parse-thread';

export function createKnowledgeRuntimePorts(env: NodeJS.ProcessEnv = process.env): {
  ingest: IngestDeps;
} {
  const canaries = loadAgentCanaries(env);
  return {
    ingest: {
      parse: createParseRunner(),
      contentScan: {
        scan: (text) => {
          const { hits } = scanForSecrets([{ id: 'document', text }], canaries);
          return {
            raiseTo: hits.length > 0 ? 'restricted' : null,
            codes: [...new Set(hits.map(({ code }) => code))],
          };
        },
      },
    },
  };
}

/** Actual metadata/store implementations, with no successful lifecycle default. Root's M8 join
 * must supply the real hold/delete/writer authority; absent bindings remain unconfirmed. */
export function createKnowledgePurgePorts(deps: {
  database: AppDatabase;
  store: ObjectStore;
  derivedLifecycle?: DerivedArtifactLifecycle;
  archiveLifecycle?: ArchiveQuarantineLifecycle;
}): { derivedArtifacts: StructuredRecordPurge } {
  const combined = createKnowledgeArtifactPurge({
    derived: createDerivedArtifactPurge({
      database: deps.database,
      store: deps.store,
      ...(deps.derivedLifecycle ? { lifecycle: deps.derivedLifecycle } : {}),
    }),
    archive: createImportedArchivePurge({
      database: deps.database,
      store: deps.store,
      ...(deps.archiveLifecycle ? { lifecycle: deps.archiveLifecycle } : {}),
    }),
  });
  const requireLifecycleBindings = () => {
    // M5's completed-job fast path reads only remaining. An absent lifecycle must still refuse
    // that revalidation; inventing a remaining count would conceal the actual missing authority.
    if (!deps.derivedLifecycle || !deps.archiveLifecycle) throw new AppError('INVALID_STATE');
  };
  return {
    derivedArtifacts: {
      ...combined,
      async confirmInTx(tx, context, input) {
        requireLifecycleBindings();
        await assertNoUnresolvedObjectDeletes(tx, context);
        return combined.confirmInTx(tx, context, input);
      },
      async confirmRecordInTx(tx, context, input) {
        requireLifecycleBindings();
        await assertNoUnresolvedObjectDeletes(tx, context);
        return combined.confirmRecordInTx(tx, context, input);
      },
    },
  };
}
