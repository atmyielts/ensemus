// Owned by the egress slice (MODEL-05). See docs/06-delivery/m5-slices.md and ADR-029 D5, D6. Deny comes
// before any text leaves, and is recorded. Runs only in the process that can reach a model.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { EmbeddingState, KnowledgeCode } from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';
import type { KnowledgeModelPort, ModelPurpose, ModelRoute } from '@ensemus/knowledge/ports';

export type EmbeddingDeps = { model: KnowledgeModelPort; batchSize?: number };

export type EmbedStep = { state: EmbeddingState; code: KnowledgeCode | null; embedded: number };

export type EmbeddingSpace = {
  id: string;
  modelId: string;
  dimension: number;
  vectorSpaceVersion: string;
};

export type ModelCallEntry = {
  purpose: ModelPurpose;
  dataClass: Classification;
  decision: 'allow' | 'deny';
  reasonCode: string;
  policyVersion: string;
  /** SHA-256 of what would go, so a call can be matched without keeping the text. */
  requestSha256: string;
  route?: ModelRoute | null;
  documentId?: string | null;
  answerId?: string | null;
  inputCount?: number;
};

/** Appends one row. A denied call writes this too: it is how an admin sees what was stopped. */
export function recordModelCall(
  _tx: Tx,
  _context: TenantContext,
  _entry: ModelCallEntry,
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * One document's chunks into the active space. Asks `route` with the document's class first: a deny writes
 * a `model_calls` row, sets `embedding_state = 'denied'` with the code, and contacts nothing (QA-011). It
 * rechecks the source before each batch, sends no text after it closes, and a repeat skips what is done.
 * A vector of the wrong length is refused by the database, and ends `failed` with `SPACE_MISMATCH`.
 */
export function embedDocument(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: EmbeddingDeps,
  _input: { documentId: string; signal: AbortSignal },
): Promise<EmbedStep> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * A question's vector, in the active space, or why not. The question's class is the caller's, because a
 * question can quote anything. A route into a different space answers `SPACE_MISMATCH`, with no call.
 */
export function embedQuery(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: EmbeddingDeps,
  _input: { query: string; classification: Classification; signal: AbortSignal },
): Promise<
  | { ok: true; spaceId: string; vector: readonly number[]; route: ModelRoute }
  | { ok: false; code: KnowledgeCode }
> {
  throw new Error('NOT_IMPLEMENTED');
}

export function activeEmbeddingSpace(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<EmbeddingSpace | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Finds or creates the space a route names, as the only active one. Retires any other. */
export function ensureEmbeddingSpace(
  _database: AppDatabase,
  _context: TenantContext,
  _route: ModelRoute,
): Promise<EmbeddingSpace> {
  throw new Error('NOT_IMPLEMENTED');
}
