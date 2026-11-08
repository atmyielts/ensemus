// Ingestion uses the same deterministic secret scan as model egress. A hit raises protection; it
// does not prove other content safe or replace the fresh policy check before any model call.
import type { IngestDeps } from '@ensemus/application/knowledge/ingest';
import { confirmDelegatedWorkPurgeInTx } from '@ensemus/application/knowledge/delegated-work-purge';
import type { DelegatedWorkPurge } from '@ensemus/application/knowledge/ports';
import { scanForSecrets } from '@ensemus/policy';
import { loadAgentCanaries } from './agent-settings';
import { createParseRunner } from './parse-thread';

export function createKnowledgeRuntimePorts(env: NodeJS.ProcessEnv = process.env): {
  ingest: IngestDeps;
  delegatedWorks: Pick<DelegatedWorkPurge, 'confirmInTx'>;
} {
  const canaries = loadAgentCanaries(env);
  return {
    delegatedWorks: { confirmInTx: confirmDelegatedWorkPurgeInTx },
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
