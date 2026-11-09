// 0212 actual app/service-role regressions. Authored only; no migration or database run is claimed.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { AppError, type ObjectStore } from '@ensemus/application';
import { addUploadedSource, getSource } from '@ensemus/application/knowledge/sources';
import { ingestDocument } from '@ensemus/application/knowledge/ingest';
import { parseDocument } from '@ensemus/knowledge/parsing';
import {
  createOrganization,
  knowledgeSources,
  knowledgeSourceGrants,
  knowledgeDocuments,
  knowledgeObjectWriters,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext, createDelegatedContext } from '@ensemus/database/service';
import {
  beginObjectWrite,
  settleObjectWrite,
  type ObjectWrite,
} from '../../packages/application/src/knowledge/object-writes';
import { rawKnowledgeObjects } from '../../packages/application/src/knowledge/raw-objects';
import { seedMember, sha256 } from '../helpers/knowledge';
import { memoryTransport, nativeKnowledgeStore } from '../helpers/knowledge-native';
import { urls } from '../helpers/stack';

describe('human source mutation authority at the SQL boundary (0212)', () => {
  let database: ReturnType<typeof openAppDatabase>,
    auth: pg.Client,
    owner: TenantContext,
    reader: TenantContext;
  // The runtime's native raw Knowledge composition over a memory transport (see knowledge-native):
  // raw bytes are written only through SQL admission and one single-attempt PUT (0516).
  const objects = new Map<string, Buffer>();
  let store: ObjectStore;
  /** What storeUpload does after beginObjectWrite: the admitted native PUT of the document's exact
   * bytes, then the writer settles on that finished native generation. Never a bare settle. */
  async function finishWrite(context: TenantContext, write: ObjectWrite, body: string) {
    await rawKnowledgeObjects(store).put(context, write, Buffer.from(body), 'text/plain');
    await withTenantTx(database.db, context, (tx) => settleObjectWrite(tx, write));
  }
  beforeAll(async () => {
    database = openAppDatabase(urls.app(), { max: 2 });
    store = nativeKnowledgeStore(database.db, memoryTransport(objects));
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
      userId,
      'Generated source authority owner',
      `${userId}@example.invalid`,
    ]);
    const org = await createOrganization(database.db, {
      userId,
      name: 'Generated source authority',
      commercialMode: 'sovereign',
    });
    owner = await resolveTenantContext(database.db, userId, org.organizationId);
    const member = await seedMember(database.db, owner, auth);
    reader = await resolveTenantContext(database.db, member.userId, org.organizationId);
  });
  afterAll(async () => {
    await auth?.end();
    await database?.close();
  });
  const service = () => createServiceContext(owner.organizationId);
  async function source(shared = true) {
    const row = await addUploadedSource(database.db, store, owner, {
      title: 'Generated authority source',
      mediaType: 'text/plain',
      body: Buffer.from('Generated authority words.'),
      classification: 'restricted',
      grants: shared ? [{ kind: 'membership', membershipId: reader.membershipId }] : [],
    });
    await ingestDocument(
      database.db,
      store,
      service(),
      {
        parse: async (bytes, type) => parseDocument(bytes, type),
        contentScan: { scan: () => ({ raiseTo: null, codes: [] }) },
      },
      row,
    );
    return row;
  }
  const document = (sourceId: string, createdByMembershipId: string) => ({
    organizationId: owner.organizationId,
    id: randomUUID(),
    sourceId,
    versionNo: 2,
    title: 'Generated replacement',
    mediaType: 'text/plain',
    contentSha256: sha256('Generated replacement'),
    sizeBytes: 21,
    classification: 'restricted',
    createdByMembershipId,
  });
  it('denies direct owner forgery, metadata changes and fabricated source ownership', async () => {
    const row = await source();
    for (const values of [
      { ownerMembershipId: reader.membershipId },
      { version: 99 },
      { classification: 'restricted' as const },
    ])
      await expect(
        withTenantTx(database.db, reader, (tx) =>
          tx.update(knowledgeSources).set(values).where(eq(knowledgeSources.id, row.sourceId)),
        ),
      ).rejects.toThrow();
    await expect(
      withTenantTx(database.db, reader, (tx) =>
        tx.insert(knowledgeSources).values({
          organizationId: owner.organizationId,
          id: randomUUID(),
          kind: 'upload',
          classification: 'restricted',
          ownerMembershipId: owner.membershipId,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(database.db, owner, (tx) =>
        tx
          .update(knowledgeSources)
          .set({ ownerMembershipId: reader.membershipId })
          .where(eq(knowledgeSources.id, row.sourceId)),
      ),
    ).rejects.toThrow();
  });
  it('denies grant self-escalation and ordinary-reader grant deletion', async () => {
    const privateSource = await source(false);
    await expect(
      withTenantTx(database.db, reader, (tx) =>
        tx.insert(knowledgeSourceGrants).values({
          organizationId: owner.organizationId,
          sourceId: privateSource.sourceId,
          principalKind: 'membership',
          membershipId: reader.membershipId,
          grantedByMembershipId: reader.membershipId,
        }),
      ),
    ).rejects.toThrow();
    await expect(getSource(database.db, reader, privateSource.sourceId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    const shared = await source(),
      detail = await getSource(database.db, owner, shared.sourceId),
      grant = detail.grants.find(
        (grant) => grant.kind === 'membership' && grant.membershipId === owner.membershipId,
      );
    if (!grant) throw new Error('MISSING_GENERATED_GRANT');
    await expect(
      withTenantTx(database.db, reader, (tx) =>
        tx.delete(knowledgeSourceGrants).where(eq(knowledgeSourceGrants.id, grant.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(database.db, owner, (tx) =>
        tx.insert(knowledgeSourceGrants).values({
          organizationId: owner.organizationId,
          sourceId: shared.sourceId,
          principalKind: 'membership',
          membershipId: reader.membershipId,
          grantedByMembershipId: reader.membershipId,
        }),
      ),
    ).rejects.toThrow();
  });
  it('denies direct ordinary-reader document and writer preparation while preserving owner token checks', async () => {
    const row = await source(),
      input = document(row.sourceId, reader.membershipId);
    await expect(
      withTenantTx(database.db, reader, (tx) => tx.insert(knowledgeDocuments).values(input)),
    ).rejects.toThrow();
    const pending = document(row.sourceId, owner.membershipId);
    await withTenantTx(database.db, owner, (tx) => tx.insert(knowledgeDocuments).values(pending));
    await expect(
      withTenantTx(database.db, reader, (tx) =>
        tx.insert(knowledgeObjectWriters).values({
          organizationId: owner.organizationId,
          documentId: pending.id,
          sourceId: row.sourceId,
          generation: 1,
          writeId: randomUUID(),
          startedByMembershipId: reader.membershipId,
          state: 'active',
        }),
      ),
    ).rejects.toThrow();
    const write = await withTenantTx(database.db, owner, (tx) =>
      beginObjectWrite(tx, owner, { sourceId: row.sourceId, documentId: pending.id }),
    );
    await expect(
      withTenantTx(database.db, owner, (tx) =>
        tx
          .update(knowledgeObjectWriters)
          .set({ state: 'settled', writeId: randomUUID() })
          .where(eq(knowledgeObjectWriters.documentId, pending.id)),
      ),
    ).rejects.toThrow();
    await finishWrite(owner, write, 'Generated replacement');
  });
  it('never treats a delegated worker as a human source owner or a trusted ingestion service', async () => {
    const row = await source(),
      delegated = await createDelegatedContext(
        database.db,
        owner.organizationId,
        owner.membershipId,
      );
    await expect(
      withTenantTx(database.db, delegated, (tx) =>
        tx.insert(knowledgeSources).values({
          organizationId: owner.organizationId,
          id: randomUUID(),
          kind: 'upload',
          classification: 'restricted',
          ownerMembershipId: owner.membershipId,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(database.db, delegated, (tx) =>
        tx.insert(knowledgeDocuments).values(document(row.sourceId, owner.membershipId)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(database.db, delegated, (tx) =>
        tx
          .insert(knowledgeSourceGrants)
          .values({
            organizationId: owner.organizationId,
            sourceId: row.sourceId,
            principalKind: 'membership',
            membershipId: reader.membershipId,
            grantedByMembershipId: owner.membershipId,
          })
          .onConflictDoNothing(),
      ),
    ).rejects.toThrow();
    const pending = document(row.sourceId, owner.membershipId);
    const write = await withTenantTx(database.db, owner, async (tx) => {
      await tx.insert(knowledgeDocuments).values(pending);
      return beginObjectWrite(tx, owner, { sourceId: row.sourceId, documentId: pending.id });
    });
    await expect(
      withTenantTx(database.db, delegated, (tx) =>
        tx
          .update(knowledgeObjectWriters)
          .set({ state: 'settled' })
          .where(eq(knowledgeObjectWriters.documentId, pending.id)),
      ),
    ).rejects.toThrow();
    await finishWrite(owner, write, 'Generated replacement');
  });
  it('allows a readable manager with the actual grantor/uploader and explicit trusted service ingestion', async () => {
    const row = await addUploadedSource(database.db, store, reader, {
      title: 'Generated member-owned source',
      mediaType: 'text/plain',
      body: Buffer.from('Generated member-owned words.'),
      classification: 'restricted',
      grants: [{ kind: 'membership', membershipId: owner.membershipId }],
    });
    await ingestDocument(
      database.db,
      store,
      service(),
      {
        parse: async (bytes, type) => parseDocument(bytes, type),
        contentScan: { scan: () => ({ raiseTo: null, codes: [] }) },
      },
      row,
    );
    const pending = document(row.sourceId, owner.membershipId);
    const write = await withTenantTx(database.db, owner, async (tx) => {
      await tx.insert(knowledgeDocuments).values(pending);
      return beginObjectWrite(tx, owner, { sourceId: row.sourceId, documentId: pending.id });
    });
    await finishWrite(owner, write, 'Generated replacement');
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .insert(knowledgeSourceGrants)
        .values({
          organizationId: owner.organizationId,
          sourceId: row.sourceId,
          principalKind: 'membership',
          membershipId: owner.membershipId,
          grantedByMembershipId: owner.membershipId,
        })
        .onConflictDoNothing(),
    );
    const trusted = await source(false),
      systemDocument = {
        ...document(trusted.sourceId, owner.membershipId),
        createdByMembershipId: null,
      };
    await withTenantTx(database.db, service(), (tx) =>
      tx.insert(knowledgeDocuments).values(systemDocument),
    );
  });
});
