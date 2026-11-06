// Owned by the ingest slice (`parse`) and the purge slice (`transcripts`). See m5-slices.md. What the
// knowledge worker hands its Activities. Until M4's real ports are wired at the final merge, a port with
// nothing behind it stops the work rather than letting it through. Failing closed is the point: a missing
// secret scan must never read as a clean one.
import type { IngestDeps } from '@ensemus/application/knowledge/ingest';
import type { RunTranscriptPurge } from '@ensemus/application/knowledge/ports';

export function createKnowledgeRuntimePorts(): {
  ingest: IngestDeps;
  transcripts: RunTranscriptPurge;
} {
  return {
    ingest: {
      parse: () => {
        throw new Error('NOT_IMPLEMENTED');
      },
      contentScan: {
        scan: () => {
          throw new Error('CONTENT_SCAN_NOT_WIRED');
        },
      },
    },
    transcripts: {
      purgeUsing: () => {
        throw new Error('TRANSCRIPT_PURGE_NOT_WIRED');
      },
    },
  };
}
