// Owned by the purge slice (KNOW-05). See docs/06-delivery/m5-slices.md and ADR-029 D3. A revoke blocks
// serving in its own commit. Everything derived goes afterwards, in a workflow, and the job's row says when
// that finished. A source's tombstone goes through ADR-026's ledger like a file's.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { LedgerEntry } from '@ensemus/domain/tombstone-ledger';
import type { PurgeReason, PurgeState } from '@ensemus/domain/knowledge';
import type { ObjectStore } from '../artifacts';
import type { ReapplyOptions, ReapplyResult } from '../tombstone-ledger';
import type { RunTranscriptPurge } from './ports';

/** `knowledge.manage`, or being the source's owner. Refused for a service context. */
export function revokeSource(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { sourceId: string; expectedVersion: number; reason: string },
): Promise<{ purgeJobId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** The same, ending `deleted`. In one transaction: state, tombstone, purge job, and both events. */
export function deleteSource(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { sourceId: string; expectedVersion: number; reason: string },
): Promise<{ purgeJobId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The worker's half of a sync: closes every active source of a revoked connection, or whose resource has
 * gone at the provider. Reads already stopped when M3 committed that (ADR-029 D2), and this removes what
 * was derived. Bounded, and safe to repeat.
 */
export function closeOrphanedConnectorSources(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { limit: number },
): Promise<{ closed: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

export type PurgeOutcome = {
  state: PurgeState;
  documents: number;
  chunks: number;
  embeddings: number;
  facts: number;
  answers: number;
  blobs: number;
};

/**
 * Removes, in order, answers that used the source, its evidence (a fact with no other evidence goes, and
 * one with other evidence becomes `disputed`, naming this source), chunks and embeddings, staged bytes,
 * document rows, and the stored bytes, checking they have gone. No transaction is open during a store call.
 * Marks the job completed and emits `knowledge.purge_completed`. Safe to repeat, and a store outage leaves
 * the job `failed` with a code, and serving stays blocked.
 */
export function runSourcePurge(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _input: { sourceId: string },
): Promise<PurgeOutcome> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * M4's prompts can hold a closed source's words, and only its role can reach them, so this half runs on its
 * queue. Finds runs through `evidence_packages` and `evidence_items`, with a run ID, and asks the port.
 */
export function purgeRunTranscriptsForSource(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: { transcripts: RunTranscriptPurge },
  _input: { sourceId: string },
): Promise<{ removed: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

export type PurgeStatus = {
  sourceId: string;
  reason: PurgeReason;
  state: PurgeState;
  counts: Omit<PurgeOutcome, 'state'>;
  requestedAt: Date;
  completedAt: Date | null;
  lastErrorCode: string | null;
};

/** `knowledge.manage` or the owner. Gate D's report of completion. */
export function getPurgeStatus(
  _database: AppDatabase,
  _context: TenantContext,
  _sourceId: string,
): Promise<PurgeStatus> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * ADR-026 D3 for a `knowledge_source` entry, called from `reapplyTombstoneLedger`. Puts back the tombstone,
 * closes the source with `restore_reapply`, and leaves the purge to do the rest. A source whose documents
 * and bytes all survive is `unconfirmed` until an operator confirms the entry, as a whole file is.
 */
export function reapplyKnowledgeSourceEntry(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _entry: LedgerEntry,
  _result: ReapplyResult,
  _options: ReapplyOptions,
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
