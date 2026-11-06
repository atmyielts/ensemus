// Written for the integrated migrations. Runs against real roles; no Docker was run while building it.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type ObjectStore } from '@ensemus/application';
import {
  addUploadedSource,
  addDocumentVersion,
  getSource,
  listSources,
  openDocumentBytes,
  raiseSourceClassification,
  setSourceGrants,
} from '@ensemus/application/knowledge/sources';
import { ingestDocument } from '@ensemus/application/knowledge/ingest';
import {
  createOrganization,
  domainEvents,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { parseDocument } from '@ensemus/knowledge/parsing';
import { eq, sql } from 'drizzle-orm';
import { seedMember } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('knowledge uploads and source authority', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let owner: TenantContext;
  let other: TenantContext;
  let reader: TenantContext;
  const objects = new Map<string, Buffer>();
  const store: ObjectStore = {
    put: async (key, body) => {
      objects.set(key, Buffer.from(body));
    },
    get: async (key) => {
      const body = objects.get(key);
      if (!body) throw new Error('MISSING');
      return Buffer.from(body);
    },
    delete: async (key) => {
      objects.delete(key);
    },
    exists: async (key) => objects.has(key),
  };
  const upload = (grants: Parameters<typeof addUploadedSource>[3]['grants'] = []) =>
    addUploadedSource(database.db, store, owner, {
      title: `Uploaded ${randomUUID()}`,
      mediaType: 'text/plain',
      body: Buffer.from('A generated document.'),
      classification: 'internal',
      grants,
    });
  const ingest = (documentId: string) =>
    ingestDocument(
      database.db,
      store,
      createServiceContext(owner.organizationId),
      {
        parse: async (bytes, type) => parseDocument(bytes, type),
        contentScan: { scan: () => ({ raiseTo: null, codes: [] }) },
      },
      { documentId },
    );
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const makeOwner = async () => {
      const userId = randomUUID();
      await auth.query('insert into identity.users (id, name, email) values ($1,$2,$3)', [
        userId,
        'Test person',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Same Company',
        commercialMode: 'sovereign',
      });
      return resolveTenantContext(database.db, userId, org.organizationId);
    };
    owner = await makeOwner();
    other = await makeOwner();
    const member = await seedMember(database.db, owner, auth);
    reader = await resolveTenantContext(database.db, member.userId, owner.organizationId);
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });

  it('refuses a service as an uploader and rolls back a foreign grant', async () => {
    const input = {
      title: 'Generated',
      mediaType: 'text/plain',
      body: Buffer.from('Words'),
      classification: 'internal' as const,
      grants: [],
    };
    await expect(
      addUploadedSource(database.db, store, createServiceContext(owner.organizationId), input),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    const before = objects.size;
    await expect(
      upload([{ kind: 'membership', membershipId: other.membershipId }]),
    ).rejects.toEqual(new AppError('INVALID_INPUT'));
    expect(objects.size).toBe(before);
  });
  it('refuses grants wider than the classification', async () => {
    await expect(
      addUploadedSource(database.db, store, owner, {
        title: 'Restricted',
        mediaType: 'text/plain',
        body: Buffer.from('Words'),
        classification: 'restricted',
        grants: [{ kind: 'organization' }],
      }),
    ).rejects.toEqual(new AppError('KNOWLEDGE_GRANT_TOO_WIDE'));
  });
  it('always grants the uploader, and another tenant sees neither title nor bytes', async () => {
    const source = await upload();
    expect((await getSource(database.db, owner, source.sourceId)).canRead).toBe(true);
    await expect(getSource(database.db, other, source.sourceId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    await expect(openDocumentBytes(database.db, store, other, source.documentId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    await expect(
      addDocumentVersion(database.db, store, other, {
        sourceId: source.sourceId,
        expectedVersion: 1,
        title: 'Foreign',
        mediaType: 'text/plain',
        body: Buffer.from('Cannot replace'),
      }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
  });
  it('allows managers to see metadata, without granting a document title or content', async () => {
    const memberSource = await addUploadedSource(database.db, store, reader, {
      title: 'Only the named reader',
      mediaType: 'text/plain',
      body: Buffer.from('Private generated text'),
      classification: 'confidential',
      grants: [],
    });
    const view = await getSource(database.db, owner, memberSource.sourceId);
    expect(view.title).toBeNull();
    expect(view.canRead).toBe(false);
    expect(
      (await listSources(database.db, owner, {})).items.find((s) => s.id === memberSource.sourceId)
        ?.title,
    ).toBeNull();
    await expect(
      openDocumentBytes(database.db, store, owner, memberSource.documentId),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
  });
  it('writes one source, one document and one event for a resent form', async () => {
    const input = {
      title: 'Once',
      mediaType: 'text/plain',
      body: Buffer.from('Same bytes'),
      classification: 'internal' as const,
      grants: [],
      requestKey: randomUUID(),
    };
    const first = await addUploadedSource(database.db, store, owner, input);
    expect(await addUploadedSource(database.db, store, owner, input)).toEqual(first);
    const events = await withTenantTx(database.db, owner, (tx) =>
      tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, first.documentId)),
    );
    expect(events).toHaveLength(1);
  });
  it('keeps the old searchable version while a new version is received', async () => {
    const source = await upload();
    await ingest(source.documentId);
    const second = await addDocumentVersion(database.db, store, owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      title: 'Next version',
      mediaType: 'text/plain',
      body: Buffer.from('Version two'),
    });
    expect((await getSource(database.db, owner, source.sourceId)).documentId).toBe(
      source.documentId,
    );
    await ingest(second.documentId);
    expect((await getSource(database.db, owner, source.sourceId)).documentId).toBe(
      second.documentId,
    );
    expect(
      (await openDocumentBytes(database.db, store, owner, second.documentId)).body.toString(),
    ).toBe('Version two');
  });
  it('rechecks grants after the object store responds, before returning bytes', async () => {
    const source = await upload([{ kind: 'membership', membershipId: reader.membershipId }]);
    const before = await getSource(database.db, owner, source.sourceId);
    const grant = before.grants.find(
      (g) => g.kind === 'membership' && g.membershipId === reader.membershipId,
    );
    if (!grant) throw new Error('MISSING_TEST_GRANT');
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const reading = new Promise<void>((done) => {
      entered = done;
    });
    const delayed = {
      ...store,
      get: async (key: string) => {
        entered();
        await waiting;
        return store.get(key);
      },
    };
    const opened = openDocumentBytes(database.db, delayed, reader, source.documentId);
    const result = expect(opened).rejects.toEqual(new AppError('NOT_FOUND'));
    await reading;
    await setSourceGrants(database.db, owner, {
      sourceId: source.sourceId,
      expectedVersion: before.version,
      add: [],
      removeGrantIds: [grant.id],
    });
    release();
    await result;
  });
  it('narrows organization access when a classification rises and refuses lowering it', async () => {
    const source = await upload([{ kind: 'organization' }]);
    expect((await getSource(database.db, reader, source.sourceId)).canRead).toBe(true);
    await raiseSourceClassification(database.db, owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      classification: 'confidential',
    });
    await expect(getSource(database.db, reader, source.sourceId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    await expect(
      raiseSourceClassification(database.db, owner, {
        sourceId: source.sourceId,
        expectedVersion: 2,
        classification: 'internal',
      }),
    ).rejects.toEqual(new AppError('INVALID_INPUT'));
  });
  it('refuses an old uploader context after that member was disabled', async () => {
    const member = await seedMember(database.db, owner, auth);
    const context = await resolveTenantContext(database.db, member.userId, owner.organizationId);
    await withTenantTx(database.db, owner, (tx) =>
      tx.execute(
        // Only generated IDs, with the update still made under the application role.
        sql`update org.memberships set status = 'disabled' where id = ${member.membershipId}::uuid`,
      ),
    );
    await expect(
      addUploadedSource(database.db, store, context, {
        title: 'After disabling',
        mediaType: 'text/plain',
        body: Buffer.from('Text'),
        classification: 'internal',
        grants: [],
      }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
  });
});
