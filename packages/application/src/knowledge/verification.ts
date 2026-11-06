// Owned by the flagship slice (AGENT-07). See docs/06-delivery/m5-slices.md and ADR-029 D12. A person
// accepts exactly these bytes against exactly this objective, once a machine has checked every citation.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ObjectStore } from '../artifacts';

export type ArtifactCitationInput = {
  chunkId: string;
  artifactStart: number;
  artifactEnd: number;
};

/** A run recording what a draft rests on. A chunk the run's initiator cannot read is refused. */
export function recordArtifactCitations(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { artifactId: string; workUnitId: string; citations: readonly ArtifactCitationInput[] },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export type GroundingVerdict = {
  verdict: 'passed' | 'failed';
  /** `NOT_GROUNDED`, `CITATION_INVALID`, or `SOURCE_CLOSED` when a cited source has since closed. */
  reasonCode: string | null;
  citations: number;
};

/** The worker's half: checks each citation still resolves at its hash. Appends one record. */
export function checkArtifactGrounding(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _input: { artifactId: string; workUnitId: string },
): Promise<GroundingVerdict> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Needs a user context and `canManageWork`. The hash has to be the file's current one, so what was read is
 * what is accepted. KNOWLEDGE_ARTIFACT_NOT_GROUNDED when no check passed for those bytes. A rejection needs
 * a reason. Refused for a service or agent context, by the trigger as well.
 */
export function decideArtifact(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    artifactId: string;
    workUnitId: string;
    artifactSha256: string;
    verdict: 'accepted' | 'rejected';
    reason?: string;
  },
): Promise<{ verificationId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export type ArtifactVerificationView = {
  artifactId: string;
  artifactSha256: string;
  grounding: { verdict: 'passed' | 'failed'; reasonCode: string | null; at: Date } | null;
  human: { verdict: 'accepted' | 'rejected'; by: string; reason: string | null; at: Date } | null;
  citations: readonly {
    ordinal: number;
    chunkId: string;
    documentId: string;
    sourceId: string;
    /** Null when the viewer can no longer read it, or its source has closed. */
    title: string | null;
    excerpt: string | null;
    available: boolean;
  }[];
};

/** Under the Work Unit's access rules, with each citation under its source's. */
export function getArtifactVerification(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { artifactId: string; workUnitId: string },
): Promise<ArtifactVerificationView> {
  throw new Error('NOT_IMPLEMENTED');
}
