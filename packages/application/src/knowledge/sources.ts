// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md and ADR-029 D1, D2. A person's half:
// adding a source, who can see it, and what it says. Reading goes through row-level security, so a source
// someone cannot read shows no title and answers not found for its content.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type {
  DocumentState,
  EmbeddingState,
  ScanState,
  SourceKind,
  SourceState,
} from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';
import type { ObjectStore } from '../artifacts';

export type SourceGrantInput =
  | { kind: 'membership'; membershipId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'organization' };

export type SourceSummary = {
  id: string;
  kind: SourceKind;
  state: SourceState;
  classification: Classification;
  /** Null when the viewer's ACL does not cover it. A manager still sees that it exists, and its class. */
  title: string | null;
  canRead: boolean;
  documentState: DocumentState | null;
  embeddingState: EmbeddingState | null;
  searchableAt: Date | null;
  sourceModifiedAt: Date | null;
  version: number;
  createdAt: Date;
};

export type SourcePage = { items: readonly SourceSummary[]; next: string | null };

export type SourceDetail = SourceSummary & {
  documentId: string | null;
  mediaType: string | null;
  sizeBytes: number | null;
  sourceUrl: string | null;
  sourceVersion: string | null;
  scanState: ScanState | null;
  rejectCode: string | null;
  grants: readonly (SourceGrantInput & { id: string })[];
  /** True for a connector's source, whose permissions come from the provider and cannot be edited here. */
  grantsManagedByProvider: boolean;
};

/**
 * Needs `knowledge.add`. Writes the source, its grants (always including the adder) and a `received`
 * document, then the bytes, then the outbox event, so nothing is ingested before its bytes exist. Refuses
 * a format outside `INGESTIBLE_MEDIA_TYPES`, and a size over `MAX_DOCUMENT_BYTES`. The same `requestKey`
 * with the same content returns the first result.
 */
export function addUploadedSource(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _input: {
    title: string;
    mediaType: string;
    body: Buffer;
    classification: Classification;
    grants: readonly SourceGrantInput[];
    requestKey?: string;
  },
): Promise<{ sourceId: string; documentId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** A new version of an upload. Needs the ability to read it and `knowledge.add`. Same content: nothing. */
export function addDocumentVersion(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _input: {
    sourceId: string;
    expectedVersion: number;
    title: string;
    mediaType: string;
    body: Buffer;
  },
): Promise<{ documentId: string; unchanged: boolean }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Sources the viewer can read. With `knowledge.manage`, every source, with no title on the rest. */
export function listSources(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { state?: SourceState; after?: string; limit?: number },
): Promise<SourcePage> {
  throw new Error('NOT_IMPLEMENTED');
}

/** NOT_FOUND unless the viewer can read it, or has `knowledge.manage`, which shows no title or URL. */
export function getSource(
  _database: AppDatabase,
  _context: TenantContext,
  _sourceId: string,
): Promise<SourceDetail> {
  throw new Error('NOT_IMPLEMENTED');
}

/** The original bytes, as a citation's path back to its source. NOT_FOUND through the ACL. */
export function openDocumentBytes(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _documentId: string,
): Promise<{ body: Buffer; mediaType: string; title: string; classification: Classification }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Needs `knowledge.manage` or to be the source's owner. Takes effect in this commit. Audited with IDs, not
 * names. A connector's source answers KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE, and a grant too wide for the
 * class answers KNOWLEDGE_GRANT_TOO_WIDE. Removing someone's access needs no purge: reads are live.
 */
export function setSourceGrants(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    sourceId: string;
    expectedVersion: number;
    add: readonly SourceGrantInput[];
    removeGrantIds: readonly string[];
  },
): Promise<{ version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Same rights as grants. Only rises, and the database refuses the rest. */
export function raiseSourceClassification(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { sourceId: string; expectedVersion: number; classification: Classification },
): Promise<{ version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}
