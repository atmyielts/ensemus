// Real role/RLS tests, written for the integrated migrations; not run by the parallel builder.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type ObjectStore } from '@ensemus/application';
import {
  addUploadedSource,
  addDocumentVersion,
  getSource,
  setSourceGrants,
} from '@ensemus/application/knowledge/sources';
import {
  ingestDocument,
  listStaleConnectorResources,
  listDocumentsNeedingIngestion,
  recordConnectorContent,
  recoverUnannouncedDocuments,
  type IngestDeps,
} from '@ensemus/application/knowledge/ingest';
import {
  connections,
  createOrganization,
  domainEvents,
  externalResources,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeDocumentStaging,
  knowledgeSources,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import { parseDocument } from '@ensemus/knowledge/parsing';
import { and, eq, sql } from 'drizzle-orm';
import { urls } from '../helpers/stack';
import {
  memoryTransport,
  nativeKnowledgeStore,
  runNativeKnowledgePurge,
} from '../helpers/knowledge-native';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import { openAgentDatabase } from '@ensemus/database/agent';

describe('knowledge ingestion, retries and closure', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentDatabase>;
  let auth: pg.Client;
  let owner: TenantContext;
  let other: TenantContext;
  const objects = new Map<string, Buffer>();
  // The runtime's native raw Knowledge composition over a memory transport (see knowledge-native).
  const transport = memoryTransport(objects);
  let store: ObjectStore;
  const deps: IngestDeps = {
    parse: async (bytes, mediaType) => parseDocument(bytes, mediaType),
    contentScan: { scan: () => ({ raiseTo: null, codes: [] }) },
  };
  const service = () => createServiceContext(owner.organizationId);
  const upload = (text = 'Generated words for an ingest test.') =>
    addUploadedSource(database.db, store, owner, {
      title: `Ingest ${randomUUID()}`,
      mediaType: 'text/plain',
      body: Buffer.from(text),
      classification: 'internal',
      grants: [],
    });
  const ingest = (documentId: string, overrides: Partial<IngestDeps> = {}) =>
    ingestDocument(database.db, store, service(), { ...deps, ...overrides }, { documentId });
  const chunksFor = (id: string) =>
    withTenantTx(database.db, service(), (tx) =>
      tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, id)),
    );
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    store = nativeKnowledgeStore(database.db, transport);
    agent = openAgentDatabase(urls.agent());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const makeOwner = async () => {
      const userId = randomUUID();
      await auth.query('insert into identity.users (id,name,email) values ($1,$2,$3)', [
        userId,
        'Test person',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Same Name Ltd',
        commercialMode: 'byom',
      });
      return resolveTenantContext(database.db, userId, org.organizationId);
    };
    owner = await makeOwner();
    other = await makeOwner();
  });
  afterAll(async () => {
    await auth.end();
    await agent.close();
    await database.close();
  });

  it('refuses non-service parsing and never reads another tenant document', async () => {
    const source = await upload();
    await expect(ingestDocument(database.db, store, owner, deps, source)).rejects.toEqual(
      new AppError('FORBIDDEN'),
    );
    expect(
      await ingestDocument(
        database.db,
        store,
        createServiceContext(other.organizationId),
        deps,
        source,
      ),
    ).toMatchObject({ outcome: 'already_done' });
    expect(await chunksFor(source.documentId)).toHaveLength(0);
  });
  it('publishes exact hashes and offsets once and leaves embeddings pending and scans honest', async () => {
    const source = await upload('😀 Generated paragraph.\n\nMore generated text.');
    expect(await ingest(source.documentId)).toMatchObject({ outcome: 'searchable', chunks: 1 });
    const chunks = await chunksFor(source.documentId);
    expect(chunks[0]).toMatchObject({ charStart: 0, charEnd: 45 });
    expect(await ingest(source.documentId)).toMatchObject({ outcome: 'already_done' });
    expect(await chunksFor(source.documentId)).toEqual(chunks);
    expect(await getSource(database.db, owner, source.sourceId)).toMatchObject({
      documentState: 'searchable',
      scanState: 'not_scanned',
      embeddingState: 'pending',
    });
  });
  it('fails closed when the secret scan is absent, and a retry can finish', async () => {
    const source = await upload();
    expect(
      await ingest(source.documentId, {
        contentScan: {
          scan: () => {
            throw new Error('CONTENT_SCAN_NOT_WIRED');
          },
        },
      }),
    ).toMatchObject({ outcome: 'failed', code: 'PARSE_FAILED' });
    expect(await chunksFor(source.documentId)).toHaveLength(0);
    expect(await ingest(source.documentId)).toMatchObject({ outcome: 'searchable' });
  });
  it('raises the source before publication and rejects malware without making chunks', async () => {
    const source = await upload();
    expect(
      await ingest(source.documentId, {
        contentScan: { scan: () => ({ raiseTo: 'restricted', codes: ['TEST_CANARY'] }) },
      }),
    ).toMatchObject({ outcome: 'searchable' });
    expect((await getSource(database.db, owner, source.sourceId)).classification).toBe(
      'restricted',
    );
    const flagged = await upload();
    expect(
      await ingest(flagged.documentId, { malware: { scan: async () => 'flagged' } }),
    ).toMatchObject({ outcome: 'rejected', code: 'SCAN_FLAGGED' });
    expect(await chunksFor(flagged.documentId)).toHaveLength(0);
  });
  it('repairs a stale failed ingest without a new provider revision, excluding closed sources and unsettled writers', async () => {
    const source = await upload();
    await ingest(source.documentId, {
      parse: async () => {
        throw new Error('Generated transient parser failure');
      },
    });
    await withTenantTx(database.db, service(), (tx) =>
      tx
        .update(knowledgeDocuments)
        .set({ updatedAt: new Date(Date.now() - 20 * 60_000) })
        .where(eq(knowledgeDocuments.id, source.documentId)),
    );
    expect(
      (await listDocumentsNeedingIngestion(database.db, service(), { limit: 50 })).some(
        (row) => row.documentId === source.documentId,
      ),
    ).toBe(true);
    expect(await ingest(source.documentId)).toMatchObject({ outcome: 'searchable' });
    expect(
      (await listDocumentsNeedingIngestion(database.db, service(), { limit: 50 })).some(
        (row) => row.documentId === source.documentId,
      ),
    ).toBe(false);
    const closed = await upload();
    await withTenantTx(database.db, service(), async (tx) => {
      await tx
        .update(knowledgeDocuments)
        .set({ updatedAt: new Date(Date.now() - 20 * 60_000) })
        .where(eq(knowledgeDocuments.id, closed.documentId));
      await tx
        .update(knowledgeSources)
        .set({ state: 'revoked' })
        .where(eq(knowledgeSources.id, closed.sourceId));
    });
    expect(
      (await listDocumentsNeedingIngestion(database.db, service(), { limit: 50 })).some(
        (row) => row.documentId === closed.documentId,
      ),
    ).toBe(false);
    await expect(listDocumentsNeedingIngestion(database.db, owner, { limit: 50 })).rejects.toEqual(
      new AppError('FORBIDDEN'),
    );
  });
  it('does not replace searchable v1 when parsing v2 fails', async () => {
    const first = await upload();
    await ingest(first.documentId);
    const next = await addDocumentVersion(database.db, store, owner, {
      sourceId: first.sourceId,
      expectedVersion: 1,
      title: 'New version',
      mediaType: 'text/plain',
      body: Buffer.from('Replacement'),
    });
    expect(
      await ingest(next.documentId, {
        parse: async () => ({ ok: false, code: 'UNREADABLE_ENCODING' }),
      }),
    ).toMatchObject({ outcome: 'rejected' });
    expect((await getSource(database.db, owner, first.sourceId)).documentId).toBe(first.documentId);
    expect(await chunksFor(first.documentId)).toHaveLength(1);
  });
  it('closes during parsing with no late chunks or late object resurrection', async () => {
    const source = await upload();
    let started: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entering = new Promise<void>((done) => {
      started = done;
    });
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const running = ingest(source.documentId, {
      parse: async (bytes, type) => {
        started();
        await blocked;
        return parseDocument(bytes, type);
      },
    });
    await entering;
    await revokeSource(database.db, owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Generated closure during parsing',
    });
    // A purge finishing while the parser was stopped must not be undone by its eventual return. This
    // is the actual workflow order and composition, including the native raw-object deletion.
    expect(
      await runNativeKnowledgePurge({
        app: database.db,
        agent: agent.db,
        store,
        organizationId: owner.organizationId,
        sourceId: source.sourceId,
      }),
    ).toMatchObject({ state: 'completed' });
    release();
    expect(await running).toMatchObject({ outcome: 'closed', code: 'SOURCE_CLOSED' });
    expect(await chunksFor(source.documentId)).toHaveLength(0);
    expect(await store.exists(knowledgeObjectKey(owner.organizationId, source.documentId))).toBe(
      false,
    );
  });
  it('records a store outage honestly, preserving the received row for recovery', async () => {
    const source = await upload();
    expect(
      await ingestDocument(
        database.db,
        nativeKnowledgeStore(database.db, {
          ...transport,
          get: async () => {
            throw new Error('STORE_DOWN');
          },
        }),
        service(),
        deps,
        source,
      ),
    ).toMatchObject({ outcome: 'failed', code: 'STORE_UNAVAILABLE' });
    expect(await ingest(source.documentId)).toMatchObject({ outcome: 'searchable' });
  });
  it('retries a lost upload response without duplicating its source or event', async () => {
    const input = {
      title: 'After the store write',
      mediaType: 'text/plain',
      body: Buffer.from('Stored before interruption'),
      classification: 'internal' as const,
      grants: [],
      requestKey: randomUUID(),
    };
    let whileInFlight: unknown = null;
    const crashing = nativeKnowledgeStore(database.db, {
      ...transport,
      putSingleAttempt: async (key: string, body: Buffer, type: string) => {
        await transport.putSingleAttempt(key, body, type);
        // Admitted and not yet answered: nobody knows this PUT's outcome, so the same request
        // cannot replace its writer yet.
        whileInFlight = await addUploadedSource(database.db, store, owner, input).catch(
          (error: unknown) => error,
        );
        throw new Error('INTERRUPTED');
      },
    });
    await expect(addUploadedSource(database.db, crashing, owner, input)).rejects.toEqual(
      new AppError('INVALID_STATE'),
    );
    expect(whileInFlight).toEqual(new AppError('INVALID_STATE'));
    // The lost response is now durably recorded as an unknown native outcome. The same request
    // recovers by sending the same bytes once more as the writer's next native generation, through
    // the ordinary admission and completion (0523); the unknown attempt is never certified.
    let puts = 0;
    const counted = nativeKnowledgeStore(database.db, {
      ...transport,
      putSingleAttempt: async (key: string, body: Buffer, type: string) => {
        puts++;
        return transport.putSingleAttempt(key, body, type);
      },
    });
    const result = await addUploadedSource(database.db, counted, owner, input);
    expect(puts).toBe(1);
    const sources = await withTenantTx(database.db, owner, (tx) =>
      tx.execute<{ document_id: string }>(
        sql`select d.id document_id from knowledge.sources s join knowledge.documents d
          on d.organization_id=s.organization_id and d.source_id=s.id
          where s.organization_id=${owner.organizationId}::uuid and d.title=${input.title}`,
      ),
    );
    expect(sources.rows).toEqual([{ document_id: result.documentId }]);
    const observer = new pg.Client({ connectionString: urls.superuser() });
    await observer.connect();
    try {
      const history = await observer.query<{ generation: string; state: string }>(
        'select generation::text,state from lifecycle.raw_object_writes where organization_id=$1 and document_id=$2 order by generation',
        [owner.organizationId, result.documentId],
      );
      expect(history.rows).toEqual([
        { generation: '0', state: 'catalog' },
        { generation: '1', state: 'unknown' },
        { generation: '2', state: 'finished' },
      ]);
    } finally {
      await observer.end();
    }
    const events = await withTenantTx(database.db, owner, (tx) =>
      tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, result.documentId)),
    );
    expect(events).toHaveLength(1);
    expect(await ingest(result.documentId)).toMatchObject({ outcome: 'searchable' });
  });
  it('reserves one upload key across changed bodies and concurrent retries', async () => {
    const input = {
      title: 'Generated idempotent source',
      mediaType: 'text/plain',
      body: Buffer.from('Generated original body.'),
      classification: 'internal' as const,
      grants: [],
      requestKey: randomUUID(),
    };
    const raced = await Promise.allSettled([
      addUploadedSource(database.db, store, owner, input),
      addUploadedSource(database.db, store, owner, input),
    ]);
    const successful = raced.filter(
      (result): result is PromiseFulfilledResult<{ sourceId: string; documentId: string }> =>
        result.status === 'fulfilled',
    );
    expect(successful.length).toBeGreaterThan(0);
    const result = await addUploadedSource(database.db, store, owner, input);
    expect(
      successful.every(
        (row) =>
          row.value.sourceId === result.sourceId && row.value.documentId === result.documentId,
      ),
    ).toBe(true);
    let puts = 0;
    const counted = nativeKnowledgeStore(database.db, {
      ...transport,
      put: async (key: string, bytes: Buffer, type: string) => {
        puts++;
        await transport.put(key, bytes, type);
      },
      putSingleAttempt: async (key: string, bytes: Buffer, type: string) => {
        puts++;
        return transport.putSingleAttempt(key, bytes, type);
      },
    });
    await expect(
      addUploadedSource(database.db, counted, owner, {
        ...input,
        body: Buffer.from('Changed body.'),
      }),
    ).rejects.toEqual(new AppError('IDEMPOTENCY_KEY_REUSED'));
    await expect(
      addUploadedSource(database.db, counted, owner, { ...input, title: 'Changed title' }),
    ).rejects.toEqual(new AppError('IDEMPOTENCY_KEY_REUSED'));
    expect(puts).toBe(0);
    const events = await withTenantTx(database.db, owner, (tx) =>
      tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, result.documentId)),
    );
    expect(events).toHaveLength(1);
  });
  it('reauthorizes an upload retry after its source grant was removed, before touching storage', async () => {
    const input = {
      title: 'Generated revoked upload',
      mediaType: 'text/plain',
      body: Buffer.from('Generated private words.'),
      classification: 'restricted' as const,
      grants: [],
      requestKey: randomUUID(),
    };
    const result = await addUploadedSource(database.db, store, owner, input);
    const detail = await getSource(database.db, owner, result.sourceId);
    await setSourceGrants(database.db, owner, {
      sourceId: result.sourceId,
      expectedVersion: detail.version,
      add: [],
      removeGrantIds: detail.grants.map((grant) => grant.id),
    });
    let touched = false;
    const counted = nativeKnowledgeStore(database.db, {
      ...transport,
      put: async () => {
        touched = true;
      },
      putSingleAttempt: async () => {
        touched = true;
        return { transport: 'written' as const };
      },
      exists: async () => {
        touched = true;
        return true;
      },
    });
    await expect(addUploadedSource(database.db, counted, owner, input)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    expect(touched).toBe(false);
  });
  it('stages connector bytes once, moves them to storage, and never re-adds a closed source', async () => {
    const connectionId = randomUUID();
    const externalResourceId = randomUUID();
    await withTenantTx(database.db, owner, async (tx) => {
      await tx.insert(connections).values({
        organizationId: owner.organizationId,
        id: connectionId,
        connectorType: 'google_workspace',
        displayName: 'Generated provider',
      });
      await tx.insert(externalResources).values({
        organizationId: owner.organizationId,
        id: externalResourceId,
        connectionId,
        stream: 'drive_files',
        resourceType: 'file',
        externalId: randomUUID(),
        externalVersion: 'v1',
        aclState: 'mapped',
      });
    });
    expect(
      (await listStaleConnectorResources(database.db, service(), { limit: 50 })).some(
        (r) => r.externalResourceId === externalResourceId,
      ),
    ).toBe(true);
    const input = {
      externalResourceId,
      title: 'Provider text',
      sourceVersion: 'v1',
      sourceUrl: 'https://example.invalid/document',
      sourceModifiedAt: null,
      mediaType: 'text/plain',
      body: Buffer.from('Provider content'),
    };
    const first = await recordConnectorContent(database.db, service(), input);
    if (!first) throw new Error('MISSING_TEST_DOCUMENT');
    expect(await recordConnectorContent(database.db, service(), input)).toBeNull();
    expect(
      (await listStaleConnectorResources(database.db, service(), { limit: 50 })).some(
        (r) => r.externalResourceId === externalResourceId,
      ),
    ).toBe(false);
    expect(await ingest(first.documentId)).toMatchObject({ outcome: 'searchable' });
    const [row] = await withTenantTx(database.db, service(), (tx) =>
      tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, first.documentId)),
    );
    expect(
      await withTenantTx(database.db, service(), (tx) =>
        tx
          .select()
          .from(knowledgeDocumentStaging)
          .where(eq(knowledgeDocumentStaging.documentId, first.documentId)),
      ),
    ).toEqual([]);
    await withTenantTx(database.db, service(), (tx) =>
      tx
        .update(knowledgeSources)
        .set({ state: 'revoked' })
        .where(
          and(
            eq(knowledgeSources.externalResourceId, externalResourceId),
            eq(knowledgeSources.id, row?.sourceId ?? randomUUID()),
          ),
        ),
    );
    expect(
      await recordConnectorContent(database.db, service(), { ...input, sourceVersion: 'v2' }),
    ).toBeNull();
    await recoverUnannouncedDocuments(database.db, store, service());
  });
  it('stages connector revisions beside the published one, preserves it on failure and swaps publication atomically', async () => {
    const connectionId = randomUUID(),
      externalResourceId = randomUUID();
    await withTenantTx(database.db, owner, async (tx) => {
      await tx.insert(connections).values({
        organizationId: owner.organizationId,
        id: connectionId,
        connectorType: 'google_workspace',
        displayName: 'Generated revisions',
      });
      await tx.insert(externalResources).values({
        organizationId: owner.organizationId,
        id: externalResourceId,
        connectionId,
        stream: 'drive_files',
        resourceType: 'text/plain',
        externalId: randomUUID(),
        externalVersion: 'v1',
        aclState: 'mapped',
      });
    });
    const input = {
      externalResourceId,
      title: 'Generated revisions',
      sourceVersion: 'v1',
      sourceUrl: 'https://example.invalid/revisions',
      sourceModifiedAt: null,
      mediaType: 'text/plain',
      body: Buffer.from('Generated version one.'),
    };
    const v1 = await recordConnectorContent(database.db, service(), input);
    if (!v1) throw new Error('MISSING_TEST_DOCUMENT');
    expect(await ingest(v1.documentId)).toMatchObject({ outcome: 'searchable' });
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .update(externalResources)
        .set({ externalVersion: 'v2', updatedAt: new Date() })
        .where(eq(externalResources.id, externalResourceId)),
    );
    const v2 = await recordConnectorContent(database.db, service(), {
      ...input,
      sourceVersion: 'v2',
      body: Buffer.from('Generated failed version two.'),
    });
    expect(v2).not.toBeNull();
    const [first] = await withTenantTx(database.db, service(), (tx) =>
      tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, v1.documentId)),
    );
    const sourceId = first!.sourceId;
    expect(
      (
        await withTenantTx(database.db, service(), (tx) =>
          tx
            .select()
            .from(knowledgeDocuments)
            .where(
              and(
                eq(knowledgeDocuments.sourceId, sourceId),
                eq(knowledgeDocuments.state, 'searchable'),
                sql`${knowledgeDocuments.supersededAt} is null`,
              ),
            ),
        )
      ).map((row) => row.id),
    ).toEqual([v1.documentId]);
    expect(
      await ingest(v2!.documentId, {
        parse: async () => {
          throw new Error('GENERATED_PARSE_FAILURE');
        },
      }),
    ).toMatchObject({ outcome: 'failed' });
    expect(
      (
        await withTenantTx(database.db, service(), (tx) =>
          tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, v1.documentId)),
        )
      )[0]?.supersededAt,
    ).toBeNull();
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .update(externalResources)
        .set({ externalVersion: 'v3', updatedAt: new Date() })
        .where(eq(externalResources.id, externalResourceId)),
    );
    const v3 = await recordConnectorContent(database.db, service(), {
      ...input,
      sourceVersion: 'v3',
      body: Buffer.from('Generated published version three.'),
    });
    if (!v3) throw new Error('MISSING_TEST_DOCUMENT');
    expect(await ingest(v3.documentId)).toMatchObject({ outcome: 'searchable' });
    const versions = await withTenantTx(database.db, service(), (tx) =>
      tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.sourceId, sourceId)),
    );
    expect(
      versions
        .filter((row) => row.state === 'searchable' && row.supersededAt === null)
        .map((row) => row.id),
    ).toEqual([v3.documentId]);
    expect(versions.find((row) => row.id === v1.documentId)?.supersededAt).toBeInstanceOf(Date);
    expect(versions.find((row) => row.id === v2!.documentId)?.state).toBe('failed');
  });
});
