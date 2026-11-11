// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md and ADR-029 D1, D4. The workers'
// half, each called with a service context. No transaction stays open during parsing or a store call.
import { createHash, randomUUID } from 'node:crypto';
import {
  connections,
  domainEvents,
  externalResources,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeDocumentStaging,
  knowledgeObjectWriters,
  knowledgeSources,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import {
  CHUNKER_VERSION,
  INGESTIBLE_MEDIA_TYPES,
  knowledgeObjectKey,
  MAX_DOCUMENT_BYTES,
  strongestClass,
  type ScanState,
} from '@ensemus/domain/knowledge';
import {
  AGGREGATE_KNOWLEDGE_DOCUMENT,
  KNOWLEDGE_DOCUMENT_RECEIVED,
  KNOWLEDGE_DOCUMENT_REJECTED,
  KNOWLEDGE_DOCUMENT_SEARCHABLE,
} from '@ensemus/domain/knowledge-events';
import type { Classification } from '@ensemus/domain/policy';
import { chunkText } from '@ensemus/knowledge/chunking';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import { beginObjectWrite, recoverObjectWrites, settleObjectWrite } from './object-writes';
import { rawKnowledgeObjects } from './raw-objects';
import type { KnowledgeCode } from '@ensemus/domain/knowledge';
import type { ContentScanPort, MalwareScanPort } from '@ensemus/knowledge/ports';
import type { ParsedDocument } from '@ensemus/knowledge/parsing';
import type { ObjectStore } from '../artifacts';

export type ParseRunner = (bytes: Uint8Array, mediaType: string) => Promise<ParsedDocument>;

export type IngestDeps = {
  /** Runs the parser in a worker thread with a memory limit and a deadline, and never in this thread. */
  parse: ParseRunner;
  contentScan: ContentScanPort;
  /** A malware scanner, run on the original bytes before any parser sees them. Without one, a document
   * says `not_scanned`, honestly (ADR-029 D4 addendum). */
  malware?: MalwareScanPort;
  /** Whether a document must scan clean before it is indexed. Defaults to true whenever `malware` is
   * set. When true, a scanner that cannot answer leaves the document `failed`, retried and unindexed. */
  malwareScanRequired?: boolean;
};

export type IngestStep = {
  outcome: 'searchable' | 'rejected' | 'failed' | 'closed' | 'already_done';
  code: KnowledgeCode | null;
  chunks: number;
};

/** Transient failures and a worker lost while parsing are retried by the bounded sweep. Rejected
 * content is terminal. A durable unknown object writer must be fenced before this can return it. */
export async function listDocumentsNeedingIngestion(
  database: AppDatabase,
  context: TenantContext,
  input: { limit: number },
): Promise<readonly { documentId: string }[]> {
  service(context);
  const limit = limitOf(input.limit);
  return withTenantTx(database, context, (tx) =>
    tx
      .select({ documentId: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .innerJoin(
        knowledgeSources,
        and(
          eq(knowledgeSources.organizationId, knowledgeDocuments.organizationId),
          eq(knowledgeSources.id, knowledgeDocuments.sourceId),
        ),
      )
      .where(
        and(
          eq(knowledgeSources.state, 'active'),
          inArray(knowledgeDocuments.state, ['received', 'parsing', 'failed']),
          sql`${knowledgeDocuments.updatedAt}<now()-interval '10 minutes'`,
          sql`not exists(select 1 from knowledge.object_writers w where w.organization_id=${context.organizationId}::uuid and w.document_id=${knowledgeDocuments.id} and w.state='active')`,
        ),
      )
      .orderBy(asc(knowledgeDocuments.updatedAt), asc(knowledgeDocuments.id))
      .limit(limit),
  );
}

/**
 * One document, from `received` or `failed` to `searchable`, safe to run again. Moves staged bytes to the
 * store, parses, scans, raises the class if the scan says so, then in one transaction writes the chunks,
 * marks the previous version superseded, marks this `searchable` and emits. A source closed meanwhile
 * ends as `closed` with nothing written (the trigger holds that, too).
 */
export async function ingestDocument(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  deps: IngestDeps,
  input: { documentId: string },
): Promise<IngestStep> {
  service(context);
  const documentId = identifier(input.documentId);
  const initial = await withTenantTx(database, context, async (tx) => {
    const [found] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId));
    if (!found) return null;
    // Source before document, the same order as upload, revoke and publication.
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, found.sourceId))
      .for('update');
    const [doc] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .for('update');
    if (!source || !doc) return null;
    if (
      doc.objectKey !== null &&
      doc.objectKey !== knowledgeObjectKey(context.organizationId, documentId)
    )
      throw new AppError('INVALID_STATE');
    const [staging] = await tx
      .select()
      .from(knowledgeDocumentStaging)
      .where(eq(knowledgeDocumentStaging.documentId, documentId));
    if (!staging) {
      const [writer] = await tx
        .select({ state: knowledgeObjectWriters.state })
        .from(knowledgeObjectWriters)
        .where(eq(knowledgeObjectWriters.documentId, documentId));
      if (writer?.state === 'active') throw new AppError('INVALID_STATE');
    }
    if (source.state === 'active' && ['received', 'failed'].includes(doc.state)) {
      await tx
        .update(knowledgeDocuments)
        .set({
          state: 'parsing',
          version: doc.version + 1,
          rejectCode: null,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, documentId));
    }
    const writer =
      source.state === 'active' && staging && ['received', 'failed', 'parsing'].includes(doc.state)
        ? await beginObjectWrite(tx, context, { sourceId: source.id, documentId })
        : null;
    return { doc, source, staging, writer };
  });
  if (!initial) return { outcome: 'already_done', code: null, chunks: 0 };
  const { doc, source, staging, writer } = initial;
  const key = doc.objectKey ?? knowledgeObjectKey(context.organizationId, documentId);
  const closed = async (): Promise<IngestStep> => {
    // A late store write must not resurrect bytes after a concurrent purge has already finished.
    if (writer) await withTenantTx(database, context, (tx) => settleObjectWrite(tx, writer));
    const result = await rawKnowledgeObjects(store).erase(context, { documentId });
    if (result.state !== 'purged') throw new Error('STORE_UNAVAILABLE');
    return { outcome: 'closed', code: 'SOURCE_CLOSED', chunks: 0 };
  };
  if (source.state !== 'active' || doc.state === 'purged') return closed();
  if (doc.state === 'searchable') return { outcome: 'already_done', code: null, chunks: 0 };
  if (doc.state === 'rejected')
    return { outcome: 'rejected', code: safeCode(doc.rejectCode, 'PARSE_FAILED'), chunks: 0 };
  let body: Buffer;
  try {
    if (staging) {
      body = staging.body;
      if (!writer) throw new AppError('PREREQUISITES_INCOMPLETE');
      await rawKnowledgeObjects(store).put(context, writer, body, doc.mediaType);
      const live = await withTenantTx(database, context, async (tx) => {
        const [current] = await tx
          .select()
          .from(knowledgeSources)
          .where(eq(knowledgeSources.id, source.id))
          .for('update');
        const [currentDoc] = await tx
          .select({ id: knowledgeDocuments.id })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.id, documentId));
        if (current?.state !== 'active' || !currentDoc) return false;
        await tx
          .update(knowledgeDocuments)
          .set({ objectKey: key })
          .where(eq(knowledgeDocuments.id, documentId));
        await tx
          .delete(knowledgeDocumentStaging)
          .where(eq(knowledgeDocumentStaging.documentId, documentId));
        if (writer) await settleObjectWrite(tx, writer);
        return true;
      });
      if (!live) return closed();
    } else body = await store.get(key);
    if (body.length > MAX_DOCUMENT_BYTES) return fail('TOO_LARGE', true);
    if (body.length !== doc.sizeBytes || hash(body) !== doc.contentSha256)
      return fail('PARSE_FAILED', true);
  } catch {
    return fail('STORE_UNAVAILABLE');
  }

  // Before parsing: an infected file is quarantined, never opened by a parser, never indexed.
  const required = deps.malwareScanRequired ?? deps.malware !== undefined;
  let scanState: ScanState = 'not_scanned';
  if (deps.malware || required) {
    try {
      if (!deps.malware) throw new Error('SCAN_FAILED');
      const verdict = await deps.malware.scan(body);
      if (verdict !== 'clean' && verdict !== 'infected') throw new Error('SCAN_FAILED');
      scanState = verdict;
    } catch {
      scanState = 'scan_failed';
    }
    if (scanState === 'infected') return fail('SCAN_FLAGGED', true, 'infected');
    if (scanState === 'scan_failed' && required) return fail('SCAN_FAILED', false, 'scan_failed');
  }

  let parsed: ParsedDocument;
  try {
    parsed = await deps.parse(body, doc.mediaType);
  } catch (error) {
    return fail(
      (error as { code?: unknown }).code === 'PARSE_TIMEOUT' ? 'PARSE_TIMEOUT' : 'PARSE_FAILED',
    );
  }
  if (!parsed.ok) return fail(parsed.code, true, scanState);
  let classification: Classification;
  try {
    const scan = deps.contentScan.scan(parsed.text);
    if (
      scan.raiseTo !== null &&
      !['public', 'internal', 'confidential', 'restricted'].includes(scan.raiseTo)
    )
      throw new Error('SCAN_FAILED');
    classification = strongestClass([
      source.classification as Classification,
      doc.classification as Classification,
      ...(scan.raiseTo ? [scan.raiseTo] : []),
    ]);
  } catch {
    return fail('PARSE_FAILED');
  }
  let chunks: ReturnType<typeof chunkText>;
  try {
    chunks = chunkText(parsed.text);
  } catch {
    return fail('TOO_LARGE', true);
  }
  if (chunks.length === 0) return fail('EMPTY_DOCUMENT', true, scanState);
  try {
    const result = await withTenantTx(database, context, async (tx): Promise<IngestStep> => {
      const [currentSource] = await tx
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, source.id))
        .for('update');
      const [current] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, documentId))
        .for('update');
      if (currentSource?.state !== 'active' || !current || current.state === 'purged')
        return { outcome: 'closed', code: 'SOURCE_CLOSED', chunks: 0 };
      if (current.state === 'searchable') return { outcome: 'already_done', code: null, chunks: 0 };
      if (current.state !== 'parsing') return { outcome: 'already_done', code: null, chunks: 0 };
      const effectiveClass = strongestClass([
        classification,
        currentSource.classification as Classification,
      ]);
      if (effectiveClass !== currentSource.classification)
        await tx
          .update(knowledgeSources)
          .set({
            classification: effectiveClass,
            version: currentSource.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSources.id, source.id));
      // If an Activity repeated after a crash, publication still consists of exactly one set of chunks.
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
      for (let offset = 0; offset < chunks.length; offset += 100) {
        await tx.insert(knowledgeChunks).values(
          chunks.slice(offset, offset + 100).map((chunk) => ({
            organizationId: context.organizationId,
            documentId,
            sourceId: source.id,
            ordinal: chunk.ordinal,
            textBody: chunk.text,
            contentSha256: chunk.sha256,
            tokenEstimate: chunk.tokenEstimate,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
          })),
        );
      }
      const now = new Date();
      await tx
        .update(knowledgeDocuments)
        .set({ supersededAt: now, updatedAt: now })
        .where(
          and(
            eq(knowledgeDocuments.sourceId, source.id),
            ne(knowledgeDocuments.id, documentId),
            isNull(knowledgeDocuments.supersededAt),
          ),
        );
      await tx
        .update(knowledgeDocuments)
        .set({
          state: 'searchable',
          classification: effectiveClass,
          // Nothing returns to `not_scanned`: with no scanner this time, an earlier answer stands.
          ...(scanState !== 'not_scanned' ? { scanState } : {}),
          rejectCode: null,
          parserVersion: parsed.parserVersion,
          chunkerVersion: CHUNKER_VERSION,
          searchableAt: now,
          supersededAt: null,
          objectKey: key,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(eq(knowledgeDocuments.id, documentId));
      await emit(tx, context, {
        eventType: KNOWLEDGE_DOCUMENT_SEARCHABLE,
        aggregateType: AGGREGATE_KNOWLEDGE_DOCUMENT,
        aggregateId: documentId,
        aggregateVersion: current.version + 1,
        classification: effectiveClass,
        payload: { source_id: source.id, chunks: chunks.length },
      });
      return { outcome: 'searchable', code: null, chunks: chunks.length };
    });
    return result.outcome === 'closed' ? closed() : result;
  } catch (error) {
    if (pgCode(error) === 'EN103') return closed();
    return fail('PARSE_FAILED');
  }

  async function fail(
    code: KnowledgeCode,
    rejected = false,
    state?: ScanState,
  ): Promise<IngestStep> {
    const result = await withTenantTx(database, context, async (tx): Promise<IngestStep> => {
      const [currentSource] = await tx
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, source.id))
        .for('update');
      const [current] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, documentId))
        .for('update');
      if (currentSource?.state !== 'active' || !current || current.state === 'purged')
        return { outcome: 'closed', code: 'SOURCE_CLOSED', chunks: 0 };
      if (current.state === 'searchable') return { outcome: 'already_done', code: null, chunks: 0 };
      if (current.state === 'rejected')
        return { outcome: 'rejected', code: safeCode(current.rejectCode, code), chunks: 0 };
      await tx
        .update(knowledgeDocuments)
        .set({
          state: rejected ? 'rejected' : 'failed',
          rejectCode: code,
          // A file that was never scanned this attempt keeps whatever an earlier attempt found.
          ...(state && state !== 'not_scanned' ? { scanState: state } : {}),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, documentId));
      await emit(tx, context, {
        eventType: KNOWLEDGE_DOCUMENT_REJECTED,
        aggregateType: AGGREGATE_KNOWLEDGE_DOCUMENT,
        aggregateId: documentId,
        aggregateVersion: current.version + 1,
        classification: currentSource.classification,
        payload: { source_id: source.id, code },
      });
      return { outcome: rejected ? 'rejected' : 'failed', code, chunks: 0 };
    });
    return result.outcome === 'closed' ? closed() : result;
  }
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
  database: AppDatabase,
  context: TenantContext,
  input: { limit: number },
): Promise<readonly StaleResource[]> {
  service(context);
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        externalResourceId: externalResources.id,
        connectionId: connections.id,
        connectorType: connections.connectorType,
        externalVersion: externalResources.externalVersion,
      })
      .from(externalResources)
      .innerJoin(connections, eq(connections.id, externalResources.connectionId))
      .where(
        and(
          eq(connections.state, 'active'),
          isNull(externalResources.deletedAt),
          // An `unmapped` resource reaches nobody, unless it is shared with a domain this organization
          // verified and has chosen to map (0712). Fetching it grants nothing: readable_source_ids decides.
          sql`(${externalResources.aclState} <> 'unmapped' or knowledge.resource_domain_shared(${externalResources.id}))`,
          inArray(connections.connectorType, ['google_workspace', 'microsoft_365']),
          inArray(externalResources.resourceType, [
            'file',
            ...INGESTIBLE_MEDIA_TYPES,
            'application/vnd.google-apps.document',
            'application/vnd.google-apps.spreadsheet',
            'application/vnd.google-apps.presentation',
          ]),
          sql`not exists (select 1 from knowledge.sources closed where closed.organization_id = ${context.organizationId}::uuid
        and closed.external_resource_id = ${externalResources.id} and closed.state <> 'active')`,
          sql`not exists (select 1 from knowledge.sources s join knowledge.documents d on d.organization_id = s.organization_id and d.source_id = s.id
        where s.organization_id = ${context.organizationId}::uuid and s.external_resource_id = ${externalResources.id}
          and s.state = 'active' and ((${externalResources.externalVersion} is null and s.updated_at >= ${externalResources.updatedAt})
            or d.source_version = ${externalResources.externalVersion}) and d.state <> 'purged')`,
        ),
      )
      .orderBy(asc(externalResources.updatedAt), asc(externalResources.id))
      .limit(limitOf(input.limit)),
  );
}

/**
 * What a connector fetched: finds or creates the resource's source, writes a `received` document, stages
 * the bytes and emits, in one transaction. Null when the resource or its connection has gone, or nothing
 * changed. The class is the resource's, and defaults no lower than `internal`. An `unmapped` resource is
 * recorded only when it is shared with a domain this organization verified and maps (ADR-029 D2 addendum).
 */
export function recordConnectorContent(
  database: AppDatabase,
  context: TenantContext,
  input: {
    externalResourceId: string;
    title: string;
    sourceVersion: string | null;
    sourceUrl: string | null;
    sourceModifiedAt: Date | null;
    mediaType: string;
    body: Buffer;
  },
): Promise<{ documentId: string } | null> {
  service(context);
  const externalResourceId = identifier(input.externalResourceId);
  if (!Buffer.isBuffer(input.body) || input.body.length > MAX_DOCUMENT_BYTES)
    throw new AppError('FILE_TOO_LARGE');
  if (!input.title.trim() || input.title.trim().length > 512 || input.title.includes('\0'))
    throw new AppError('INVALID_INPUT');
  const contentSha256 = hash(input.body);
  return withTenantTx(database, context, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${context.organizationId + ':knowledge-resource:' + externalResourceId}, 0))`,
    );
    const [resource] = await tx
      .select()
      .from(externalResources)
      .where(eq(externalResources.id, externalResourceId))
      .for('share');
    if (!resource || resource.deletedAt) return null;
    if (resource.aclState === 'unmapped') {
      const shared = await tx.execute<{ shared: boolean }>(
        sql`select knowledge.resource_domain_shared(${resource.id}::uuid) as shared`,
      );
      if (shared.rows[0]?.shared !== true) return null;
    }
    const [connection] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, resource.connectionId))
      .for('share');
    if (connection?.state !== 'active') return null;
    // Closing a source is final. A sweep cannot treat the still-existing provider row as permission to
    // re-add it under a new ID; reconnecting creates a new resource, which can be granted independently.
    const [closed] = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.externalResourceId, resource.id),
          ne(knowledgeSources.state, 'active'),
        ),
      );
    if (closed) return null;
    // A provider revision that changed during the fetch must be fetched again, not published as current.
    if (
      resource.externalVersion !== null &&
      input.sourceVersion !== null &&
      resource.externalVersion !== input.sourceVersion
    )
      return null;
    let [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.externalResourceId, resource.id),
          eq(knowledgeSources.state, 'active'),
        ),
      )
      .for('update');
    if (!source) {
      [source] = await tx
        .insert(knowledgeSources)
        .values({
          organizationId: context.organizationId,
          id: randomUUID(),
          kind: 'connector',
          connectionId: connection.id,
          externalResourceId: resource.id,
          classification: strongestClass(['internal', resource.classification as Classification]),
        })
        .returning();
    }
    if (!source) throw new AppError('INVALID_STATE');
    const [latest] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceId, source.id))
      .orderBy(desc(knowledgeDocuments.versionNo))
      .limit(1);
    if (
      latest &&
      ((latest.sourceVersion === input.sourceVersion && latest.contentSha256 === contentSha256) ||
        latest.state === 'received' ||
        latest.state === 'parsing')
    ) {
      if (latest.sourceVersion === input.sourceVersion && latest.contentSha256 === contentSha256) {
        await tx
          .update(knowledgeSources)
          .set({
            updatedAt: new Date(),
            classification: strongestClass([
              source.classification as Classification,
              resource.classification as Classification,
            ]),
          })
          .where(eq(knowledgeSources.id, source.id));
      }
      return null;
    }
    const documentId = randomUUID();
    const classification = strongestClass([
      'internal',
      source.classification as Classification,
      resource.classification as Classification,
    ]);
    let sourceUrl: string | null = null;
    try {
      if (input.sourceUrl && new URL(input.sourceUrl).protocol === 'https:')
        sourceUrl = input.sourceUrl;
    } catch {
      /* An invalid original link is omitted. */
    }
    await tx.insert(knowledgeDocuments).values({
      organizationId: context.organizationId,
      id: documentId,
      sourceId: source.id,
      versionNo: (latest?.versionNo ?? 0) + 1,
      title: input.title.trim(),
      sourceVersion: input.sourceVersion,
      sourceUrl,
      sourceModifiedAt: input.sourceModifiedAt,
      contentSha256,
      sizeBytes: input.body.length,
      mediaType: input.mediaType,
      classification,
    });
    await tx.insert(knowledgeDocumentStaging).values({
      organizationId: context.organizationId,
      documentId,
      body: input.body,
      sizeBytes: input.body.length,
    });
    await tx
      .update(knowledgeSources)
      .set({ version: source.version + (latest ? 1 : 0), updatedAt: new Date() })
      .where(eq(knowledgeSources.id, source.id));
    await emit(tx, context, {
      eventType: KNOWLEDGE_DOCUMENT_RECEIVED,
      aggregateType: AGGREGATE_KNOWLEDGE_DOCUMENT,
      aggregateId: documentId,
      aggregateVersion: 1,
      classification,
      payload: { source_id: source.id },
    });
    return { documentId };
  });
}

const service = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
};
const identifier = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
const limitOf = (value: number) => {
  if (!Number.isInteger(value) || value < 1) throw new AppError('INVALID_INPUT');
  return Math.min(value, 100);
};
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const safeCode = (value: string | null, fallback: KnowledgeCode): KnowledgeCode => {
  const codes: readonly string[] = [
    'UNSUPPORTED_FORMAT',
    'TOO_LARGE',
    'EMPTY_DOCUMENT',
    'UNREADABLE_ENCODING',
    'PARSE_TIMEOUT',
    'PARSE_FAILED',
    'ENCRYPTED_DOCUMENT',
    'NEEDS_OCR',
    'MALFORMED_DOCUMENT',
    'SCAN_FLAGGED',
    'SCAN_FAILED',
    'STORE_UNAVAILABLE',
  ];
  return value && codes.includes(value) ? (value as KnowledgeCode) : fallback;
};

/** Heals an upload's crash between its durable received row, its store write and its outbox commit. */
export async function recoverUnannouncedDocuments(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
) {
  service(context);
  await recoverObjectWrites(database, store, context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.state, 'received'),
          sql`${knowledgeDocuments.createdAt} < now() - interval '10 minutes'`,
          sql`not exists (select 1 from platform.domain_events e where e.organization_id = ${context.organizationId}::uuid and e.aggregate_id = ${knowledgeDocuments.id} and e.event_type = ${KNOWLEDGE_DOCUMENT_RECEIVED})`,
          sql`not exists (select 1 from knowledge.object_writers w where w.organization_id=${context.organizationId}::uuid and w.document_id=${knowledgeDocuments.id} and w.state='active')`,
        ),
      )
      .orderBy(asc(knowledgeDocuments.createdAt))
      .limit(50),
  );
  for (const row of rows) {
    let exists: boolean;
    try {
      exists = await store.exists(
        row.objectKey ?? knowledgeObjectKey(context.organizationId, row.id),
      );
    } catch {
      continue;
    }
    await withTenantTx(database, context, async (tx) => {
      const [source] = await tx
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, row.sourceId))
        .for('update');
      const [current] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, row.id))
        .for('update');
      if (!source || source.state !== 'active' || current?.state !== 'received') return;
      const [writer] = await tx
        .select({ state: knowledgeObjectWriters.state })
        .from(knowledgeObjectWriters)
        .where(eq(knowledgeObjectWriters.documentId, row.id));
      if (writer?.state === 'active') return;
      if (!exists) {
        await tx
          .update(knowledgeDocuments)
          .set({ state: 'failed', rejectCode: 'STORE_UNAVAILABLE' })
          .where(eq(knowledgeDocuments.id, row.id));
        return;
      }
      const [event] = await tx
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.aggregateId, row.id),
            eq(domainEvents.eventType, KNOWLEDGE_DOCUMENT_RECEIVED),
          ),
        );
      if (!event)
        await emit(tx, context, {
          eventType: KNOWLEDGE_DOCUMENT_RECEIVED,
          aggregateType: AGGREGATE_KNOWLEDGE_DOCUMENT,
          aggregateId: row.id,
          aggregateVersion: 1,
          classification: source.classification,
          payload: { source_id: source.id },
        });
    });
  }
}
