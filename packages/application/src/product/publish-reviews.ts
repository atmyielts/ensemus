// Owned by the studio slice (AGENT-08). See docs/06-delivery/m7-slices.md and ADR-031 D6.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { RiskFinding } from '@ensemus/domain/agent-draft';
import type { ProductPorts } from './ports';
import type { SessionProof } from './privileged';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type PublishReviewView = {
  id: string;
  subjectKind: 'agent_draft' | 'process_draft';
  subjectId: string;
  subjectSha256: string;
  simulationRunId: string;
  riskLevel: 'standard' | 'elevated';
  riskSummary: readonly RiskFinding[];
  requestedByMembershipId: string;
  reviewerMembershipId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'published';
  decisionReason: string | null;
  publishedRef: string | null;
  version: number;
  createdAt: Date;
};

/**
 * Needs `studio.author`. Refuses without a passed simulation of the current hash (SIMULATION_REQUIRED or
 * SIMULATION_STALE). Standard risk may name no reviewer, and the author can then decide it themselves.
 */
export async function requestPublishReview(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    subjectKind: 'agent_draft' | 'process_draft';
    subjectId: string;
    simulationRunId: string;
    reviewerMembershipId?: string;
  },
): Promise<PublishReviewView> {
  throw NOT_BUILT();
}

export async function listPublishReviews(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { status?: PublishReviewView['status'] } = {},
): Promise<readonly PublishReviewView[]> {
  throw NOT_BUILT();
}

export async function getPublishReview(
  _database: AppDatabase,
  _context: TenantContext,
  _reviewId: string,
): Promise<PublishReviewView> {
  throw NOT_BUILT();
}

/** Needs `studio.review` and recent MFA. A reason is required to reject. REVIEW_SELF_DECISION on elevated. */
export async function decidePublishReview(
  _database: AppDatabase,
  _context: TenantContext,
  _proof: SessionProof | null,
  _input: {
    reviewId: string;
    expectedVersion: number;
    decision: 'approved' | 'rejected';
    reason?: string;
  },
): Promise<PublishReviewView> {
  throw NOT_BUILT();
}

/**
 * Needs `studio.publish` and recent MFA. Under a lock: the draft's current hash still equals the review's,
 * or SIMULATION_STALE. An agent publishes through M4 in M4's own transaction, with no lock held across it:
 * `list` finds an earlier attempt by hash first, so a crash between the two repeats nothing. A process goes
 * through `publishProcessSpecInTx`. Then the review and the draft to `published`, an audit row and one event.
 */
export async function publishApproved(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'agentRegistry'>,
  _proof: SessionProof | null,
  _input: { reviewId: string; expectedVersion: number },
): Promise<{ publishedRef: string }> {
  throw NOT_BUILT();
}
