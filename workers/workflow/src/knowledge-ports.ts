// Owned by the ingest slice. See m5-slices.md. What the knowledge worker hands its Activities. Until M4's
// `scanForSecrets` is wired at the final merge, the scan stops the work rather than letting it through.
// Failing closed is the point: a missing secret scan must never read as a clean one.
import type { IngestDeps } from '@ensemus/application/knowledge/ingest';
import { createParseRunner } from './parse-thread';

export function createKnowledgeRuntimePorts(): { ingest: IngestDeps } {
  return {
    ingest: {
      parse: createParseRunner(),
      contentScan: {
        scan: () => {
          throw new Error('CONTENT_SCAN_NOT_WIRED');
        },
      },
    },
  };
}
