// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md and ADR-029 D1, D4. The workers'
// half, each called with a service context. No transaction stays open during parsing or a store call.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { KnowledgeCode } from '@ensemus/domain/knowledge';
import type { ContentScanPort, MalwareScanPort } from '@ensemus/knowledge/ports';
import type { ParsedDocument } from '@ensemus/knowledge/parsing';
import type { ObjectStore } from '../artifacts';

export type ParseRunner = (bytes: Uint8Array, mediaType: string) => Promise<ParsedDocument>;

export type IngestDeps = {
  /** Runs the parser in a worker thread with a memory limit and a deadline, and never in this thread. */
  parse: ParseRunner;
  contentScan: ContentScanPort;
  /** Optional, and no scanner ships. Without one, `scan_state` stays `not_scanned`. */
  malware?: MalwareScanPort;
};

export type IngestStep = {
  outcome: 'searchable' | 'rejected' | 'failed' | 'closed' | 'already_done';
  code: KnowledgeCode | null;
  chunks: number;
};

/**
 * One document, from `received` or `failed` to `searchable`, safe to run again. Moves staged bytes to the
 * store, parses, scans, raises the class if the scan says so, then in one transaction writes the chunks,
 * marks the previous version superseded, marks this `searchable` and emits. A source closed meanwhile
 * ends as `closed` with nothing written (the trigger holds that, too).
 */
export function ingestDocument(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _deps: IngestDeps,
  _input: { documentId: string },
): Promise<IngestStep> {
  throw new Error('NOT_IMPLEMENTED');
}

export type StaleResource = {
  externalResourceId: string;
  connectionId: string;
  connectorType: string;
  externalVersion: string | null;
};

/**
 * Resources an active connection found that have no document at their version: an anti-join on PostgreSQL,
 * so the sweep is self-healing, and rebuilds what a restore lost. Bounded, oldest first. Skips anything
 * `unmapped`, since no one could read it, and connections whose connector has no content capability.
 */
export function listStaleConnectorResources(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { limit: number },
): Promise<readonly StaleResource[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * What a connector fetched: finds or creates the resource's source, writes a `received` document, stages
 * the bytes and emits, in one transaction. Null when the resource or its connection has gone, or nothing
 * changed. The class is the resource's, and defaults no lower than `internal`.
 */
export function recordConnectorContent(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    externalResourceId: string;
    title: string;
    sourceVersion: string | null;
    sourceUrl: string | null;
    sourceModifiedAt: Date | null;
    mediaType: string;
    body: Buffer;
  },
): Promise<{ documentId: string } | null> {
  throw new Error('NOT_IMPLEMENTED');
}
