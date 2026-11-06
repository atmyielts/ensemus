// Owned by the facts slice (KNOW-04). See docs/06-delivery/m5-slices.md and ADR-029 D7. A model's output is
// a proposal, and a trigger holds that. Only a person can verify, on evidence they can read.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { FactOrigin, FactState } from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';

export type FactEvidenceInput = { chunkId: string; quoteStart: number; quoteEnd: number };

export type FactView = {
  id: string;
  subjectRef: string;
  predicate: string;
  claim: unknown;
  trustState: FactState;
  origin: FactOrigin;
  classification: Classification;
  conflictRef: string | null;
  reviewedByMembershipId: string | null;
  reviewedAt: Date | null;
  evidence: readonly {
    chunkId: string;
    documentId: string;
    sourceId: string;
    title: string;
    excerpt: string;
    /** The document this quotes has been replaced. The fact may need another look. */
    stale: boolean;
  }[];
  version: number;
  createdAt: Date;
};

/**
 * Needs a membership, and evidence the proposer can read: the class is the strongest of its sources, and
 * cannot be set lower. `origin` is `model` when a run proposes, in a delegated or agent context. Checks
 * the subject's authoritative record in the same transaction, and a conflict lands as `disputed` with
 * `conflictRef` set, not `proposed` (QA-016).
 */
export function proposeFact(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    subjectRef: string;
    predicate: string;
    claim: unknown;
    origin: FactOrigin;
    evidence: readonly FactEvidenceInput[];
    runId?: string;
    validFrom?: Date;
    validUntil?: Date;
  },
): Promise<{ factId: string; trustState: FactState }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Needs `knowledge.review_fact`, a user context and to be able to read the fact. A reason is required.
 * Verifying a `disputed` fact needs the reason to say why the record is wrong, and is audited as such. The
 * proposer cannot review their own. Maps the triggers' refusals to KNOWLEDGE_FACT_NEEDS_PERSON and
 * KNOWLEDGE_FACT_NEEDS_EVIDENCE.
 */
export function reviewFact(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    factId: string;
    expectedVersion: number;
    decision: 'verify' | 'reject';
    reason: string;
  },
): Promise<{ trustState: FactState; version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Marks a fact as disagreeing with a record, by a person or the consolidation sweep. */
export function disputeFact(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { factId: string; expectedVersion: number; conflictRef: string },
): Promise<{ version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Needs `knowledge.review_fact`. Both facts have to be readable, and the replacement `verified`. */
export function supersedeFact(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { factId: string; expectedVersion: number; supersededById: string },
): Promise<{ version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listFacts(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { subjectRef?: string; trustState?: FactState; after?: string; limit?: number },
): Promise<{ items: readonly FactView[]; next: string | null }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getFact(
  _database: AppDatabase,
  _context: TenantContext,
  _factId: string,
): Promise<FactView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** What the compiler may treat as trusted, under the viewer's own ACL. Unexpired, and `verified` only. */
export function verifiedFactsFor(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { subjectRefs: readonly string[]; limit?: number },
): Promise<readonly FactView[]> {
  throw new Error('NOT_IMPLEMENTED');
}
