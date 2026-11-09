// Written for the integrated migrations. Runs against real roles; no Docker was run while building it.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  createTeam,
  addTeamMember,
  setMemberRole,
  type ObjectStore,
} from '@ensemus/application';
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
  knowledgeDocuments,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { parseDocument } from '@ensemus/knowledge/parsing';
import { eq, sql } from 'drizzle-orm';
import { seedMember } from '../helpers/knowledge';
import { memoryTransport, nativeKnowledgeStore } from '../helpers/knowledge-native';
import { urls } from '../helpers/stack';

describe('knowledge uploads and source authority', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let owner: TenantContext;
  let other: TenantContext;
  let reader: TenantContext;
  const objects = new Map<string, Buffer>();
  // The runtime's native raw Knowledge composition over a memory transport (see knowledge-native).
  const transport = memoryTransport(objects);
  let store: ObjectStore;
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
    store = nativeKnowledgeStore(database.db, transport);
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
  it('denies replacement by an ordinary named reader before touching storage', async () => {
    const source = await upload([{ kind: 'membership', membershipId: reader.membershipId }]);
    await ingest(source.documentId);
    let puts = 0;
    const observed = nativeKnowledgeStore(database.db, {
      ...transport,
      put: async () => {
        puts++;
      },
      putSingleAttempt: async () => {
        puts++;
        return { transport: 'written' as const };
      },
    });
    await expect(
      addDocumentVersion(database.db, observed, reader, {
        sourceId: source.sourceId,
        expectedVersion: 1,
        title: 'Unauthorized replacement',
        mediaType: 'text/plain',
        body: Buffer.from('Generated replacement words.'),
      }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    expect(puts).toBe(0);
    expect((await getSource(database.db, reader, source.sourceId)).documentId).toBe(
      source.documentId,
    );
  });
  it('requires a readable manager and rechecks a demoted manager after the put', async () => {
    const member = await seedMember(database.db, owner, auth, 'admin'),
      manager = await resolveTenantContext(database.db, member.userId, owner.organizationId);
    const source = await addUploadedSource(database.db, store, reader, {
      title: 'Generated member source',
      mediaType: 'text/plain',
      body: Buffer.from('Generated initial words.'),
      classification: 'restricted',
      grants: [{ kind: 'membership', membershipId: manager.membershipId }],
    });
    await ingest(source.documentId);
    await expect(
      addDocumentVersion(database.db, store, owner, {
        sourceId: source.sourceId,
        expectedVersion: 1,
        title: 'Manager without a grant',
        mediaType: 'text/plain',
        body: Buffer.from('Generated unshared replacement.'),
      }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    const staged = await addDocumentVersion(database.db, store, manager, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      title: 'Allowed manager replacement',
      mediaType: 'text/plain',
      body: Buffer.from('Generated managed replacement.'),
    });
    await ingest(staged.documentId);
    let key = '';
    const delayed = nativeKnowledgeStore(database.db, {
      ...transport,
      putSingleAttempt: async (target: string, bytes: Buffer, mediaType: string) => {
        key = target;
        const written = await transport.putSingleAttempt(target, bytes, mediaType);
        await setMemberRole(database.db, owner, {
          membershipId: manager.membershipId,
          role: 'member',
        });
        return written;
      },
    });
    await expect(
      addDocumentVersion(database.db, delayed, manager, {
        sourceId: source.sourceId,
        expectedVersion: 2,
        title: 'Demoted while writing',
        mediaType: 'text/plain',
        body: Buffer.from('Generated refused replacement.'),
      }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    expect(key).not.toBe('');
    // 0516: once the admitted native PUT completed, its bytes stay durably inventoried (the writer is
    // settled) and only the native closed-source purge may delete them. The refused revision is never
    // announced or made current, which the assertions below hold exactly as before.
    expect(await store.exists(key)).toBe(true);
    expect((await getSource(database.db, manager, source.sourceId)).canManage).toBe(false);
    const current = await getSource(database.db, reader, source.sourceId);
    expect(current.documentId).toBe(staged.documentId);
    expect(current.latestVersion?.state).toBe('received');
    const announcements = await withTenantTx(
      database.db,
      createServiceContext(owner.organizationId),
      (tx) =>
        tx
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.aggregateId, current.latestVersion!.id)),
    );
    expect(announcements).toHaveLength(0);
  });
  it('supports real team grants for eligible classes, denying restricted and foreign teams', async () => {
    const team = await createTeam(database.db, owner, { name: 'Generated source team' }),
      foreign = await createTeam(database.db, other, { name: 'Generated source team' });
    if (!team || !foreign) throw new Error('GENERATED_TEAM_SEED_REFUSED');
    await addTeamMember(database.db, owner, { teamId: team.id, membershipId: reader.membershipId });
    const source = await addUploadedSource(database.db, store, owner, {
      title: 'Generated team source',
      mediaType: 'text/plain',
      body: Buffer.from('Generated team words.'),
      classification: 'confidential',
      grants: [{ kind: 'team', teamId: team.id }],
    });
    expect((await getSource(database.db, reader, source.sourceId)).canRead).toBe(true);
    for (const principal of [
      { kind: 'team' as const, teamId: team.id },
      { kind: 'organization' as const },
    ])
      await expect(
        addUploadedSource(database.db, store, owner, {
          title: 'Generated restricted source',
          mediaType: 'text/plain',
          body: Buffer.from('Generated restricted words.'),
          classification: 'restricted',
          grants: [principal],
        }),
      ).rejects.toEqual(new AppError('KNOWLEDGE_GRANT_TOO_WIDE'));
    await expect(
      setSourceGrants(database.db, owner, {
        sourceId: source.sourceId,
        expectedVersion: 1,
        add: [{ kind: 'team', teamId: foreign.id }],
        removeGrantIds: [],
      }),
    ).rejects.toEqual(new AppError('INVALID_INPUT'));
    const detail = await getSource(database.db, owner, source.sourceId),
      grant = detail.grants.find((grant) => grant.kind === 'team');
    if (!grant) throw new Error('MISSING_TEAM_GRANT');
    await setSourceGrants(database.db, owner, {
      sourceId: source.sourceId,
      expectedVersion: detail.version,
      add: [],
      removeGrantIds: [grant.id],
    });
    await expect(getSource(database.db, reader, source.sourceId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
  });
  it('exposes incoming revision state while preserving the published revision on rejection', async () => {
    const source = await upload();
    await ingest(source.documentId);
    const incoming = await addDocumentVersion(database.db, store, owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      title: 'Generated incoming revision',
      mediaType: 'text/plain',
      body: Buffer.from([0xff]),
    });
    expect(await getSource(database.db, owner, source.sourceId)).toMatchObject({
      documentId: source.documentId,
      documentState: 'searchable',
      latestVersion: { id: incoming.documentId, number: 2, state: 'received' },
    });
    await ingest(incoming.documentId);
    expect(await getSource(database.db, owner, source.sourceId)).toMatchObject({
      documentId: source.documentId,
      latestVersion: {
        id: incoming.documentId,
        number: 2,
        state: 'rejected',
        rejectCode: 'UNREADABLE_ENCODING',
      },
    });
    const next = await addDocumentVersion(database.db, store, owner, {
      sourceId: source.sourceId,
      expectedVersion: 2,
      title: 'Generated valid revision',
      mediaType: 'text/plain',
      body: Buffer.from('Generated valid replacement.'),
    });
    await ingest(next.documentId);
    expect(await getSource(database.db, owner, source.sourceId)).toMatchObject({
      documentId: next.documentId,
      latestVersion: { id: next.documentId, number: 3, state: 'searchable' },
    });
    const same = await addDocumentVersion(database.db, store, owner, {
      sourceId: source.sourceId,
      expectedVersion: 2,
      title: 'Generated valid revision',
      mediaType: 'text/plain',
      body: Buffer.from('Generated valid replacement.'),
    });
    expect(same).toEqual({ documentId: next.documentId, unchanged: true });
    const versions = await withTenantTx(
      database.db,
      createServiceContext(owner.organizationId),
      (tx) =>
        tx
          .select({ id: knowledgeDocuments.id })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.sourceId, source.sourceId)),
    );
    expect(versions).toHaveLength(3);
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
    const delayed = nativeKnowledgeStore(database.db, {
      ...transport,
      get: async (key: string) => {
        entered();
        await waiting;
        return transport.get(key);
      },
    });
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
