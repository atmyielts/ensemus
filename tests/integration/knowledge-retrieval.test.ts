// Real roles, generated documents. Written before the service; execution is owed after integration.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@ensemus/application';
import { retrieveHybrid, searchLexical } from '@ensemus/application/knowledge/retrieval';
import {
  getSource,
  raiseSourceClassification,
  setSourceGrants,
} from '@ensemus/application/knowledge/sources';
import {
  createOrganization,
  knowledgeDocuments,
  knowledgeEmbeddings,
  knowledgeEmbeddingSpaces,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { eq } from 'drizzle-orm';
import { knowledgeCanary, seedMember, seedSearchableSource, sha256 } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('authorized lexical and hybrid retrieval', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let owner: TenantContext;
  let reader: TenantContext;
  let foreign: TenantContext;
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const createOwner = async () => {
      const id = randomUUID();
      await auth.query('insert into identity.users (id,name,email) values ($1,$2,$3)', [
        id,
        'Same person',
        `${id}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId: id,
        name: 'Same company',
        commercialMode: 'sovereign',
      });
      return resolveTenantContext(database.db, id, org.organizationId);
    };
    owner = await createOwner();
    foreign = await createOwner();
    const member = await seedMember(database.db, owner, auth);
    reader = await resolveTenantContext(database.db, member.userId, owner.organizationId);
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  const seed = (text: string, membershipId = reader.membershipId) =>
    seedSearchableSource(database.db, owner, {
      passages: [text],
      grants: [{ kind: 'membership', membershipId }],
    });

  it('refuses service search and reveals nothing when an owner names a source without a grant', async () => {
    const word = knowledgeCanary();
    const source = await seed(word);
    await expect(
      searchLexical(database.db, createServiceContext(owner.organizationId), { query: word }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    expect(
      await searchLexical(database.db, owner, { query: word, sourceIds: [source.sourceId] }),
    ).toEqual([]);
    expect(
      await searchLexical(database.db, foreign, { query: word, sourceIds: [source.sourceId] }),
    ).toEqual([]);
    expect(await retrieveHybrid(database.db, owner, { query: word, queryVector: null })).toEqual({
      mode: 'lexical',
      passages: [],
    });
  });
  it('uses exact ACL scope, English full text, stable ranks and bound query text', async () => {
    const word = knowledgeCanary();
    const source = await seed(`${word} running horses. <script>untrusted</script>`);
    const hits = await searchLexical(database.db, reader, {
      query: `${word} running`,
      sourceIds: [source.sourceId.toUpperCase()],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      sourceId: source.sourceId,
      text: `${word} running horses. <script>untrusted</script>`,
      lexicalRank: 1,
      vectorRank: null,
    });
    expect(await searchLexical(database.db, reader, { query: word, sourceIds: [] })).toEqual([]);
    expect(
      await searchLexical(database.db, reader, { query: "'; DROP TABLE knowledge.chunks; --" }),
    ).toEqual([]);
    expect(await searchLexical(database.db, reader, { query: word })).toHaveLength(1);
  });
  it('revoking a grant takes effect on the very next search', async () => {
    const word = knowledgeCanary();
    const source = await seed(word);
    expect(await searchLexical(database.db, reader, { query: word })).toHaveLength(1);
    const grants = (await getSource(database.db, owner, source.sourceId)).grants;
    await setSourceGrants(database.db, owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      add: [],
      removeGrantIds: grants.map((grant) => grant.id),
    });
    expect(await searchLexical(database.db, reader, { query: word })).toEqual([]);
    expect(await retrieveHybrid(database.db, reader, { query: word, queryVector: null })).toEqual({
      mode: 'lexical',
      passages: [],
    });
  });
  it('carries the strongest current source and document class, and hides superseded chunks', async () => {
    const word = knowledgeCanary();
    const source = await seed(word);
    await raiseSourceClassification(database.db, owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      classification: 'restricted',
    });
    expect((await searchLexical(database.db, reader, { query: word }))[0]?.classification).toBe(
      'restricted',
    );
    await withTenantTx(database.db, createServiceContext(owner.organizationId), (tx) =>
      tx
        .update(knowledgeDocuments)
        .set({ supersededAt: new Date() })
        .where(eq(knowledgeDocuments.id, source.documentId)),
    );
    expect(await searchLexical(database.db, reader, { query: word })).toEqual([]);
  });
  it('fuses exact vectors only in the active space and falls back when none is authorized', async () => {
    const word = knowledgeCanary();
    const lexical = await seed(word);
    const semanticText = knowledgeCanary();
    const semantic = await seed(semanticText);
    const hidden = await seed(knowledgeCanary(), owner.membershipId);
    const spaceId = randomUUID();
    const retired = randomUUID();
    await withTenantTx(database.db, createServiceContext(owner.organizationId), async (tx) => {
      await tx.insert(knowledgeEmbeddingSpaces).values([
        {
          organizationId: owner.organizationId,
          id: spaceId,
          modelId: 'generated-three',
          dimension: 3,
          vectorSpaceVersion: '1',
        },
        {
          organizationId: owner.organizationId,
          id: retired,
          modelId: 'generated-two',
          dimension: 2,
          vectorSpaceVersion: '1',
          state: 'retired',
          retiredAt: new Date(),
        },
      ]);
      await tx.insert(knowledgeEmbeddings).values([
        {
          organizationId: owner.organizationId,
          chunkId: semantic.chunkIds[0]!,
          sourceId: semantic.sourceId,
          spaceId,
          dimension: 3,
          embedding: [1, 0, 0],
          contentSha256: sha256(semanticText),
        },
        {
          organizationId: owner.organizationId,
          chunkId: lexical.chunkIds[0]!,
          sourceId: lexical.sourceId,
          spaceId: retired,
          dimension: 2,
          embedding: [1, 0],
          contentSha256: sha256(word),
        },
        {
          organizationId: owner.organizationId,
          chunkId: hidden.chunkIds[0]!,
          sourceId: hidden.sourceId,
          spaceId,
          dimension: 3,
          embedding: [1, 0, 0],
          contentSha256: sha256('hidden'),
        },
      ]);
    });
    const hybrid = await retrieveHybrid(database.db, reader, {
      query: word,
      queryVector: { spaceId, vector: [1, 0, 0] },
    });
    expect(hybrid.mode).toBe('hybrid');
    expect(hybrid.passages.map((hit) => hit.sourceId).sort()).toEqual(
      [lexical.sourceId, semantic.sourceId].sort(),
    );
    expect(hybrid.passages.find((hit) => hit.sourceId === semantic.sourceId)?.vectorRank).toBe(1);
    expect(
      (
        await retrieveHybrid(database.db, reader, {
          query: word,
          queryVector: { spaceId, vector: [1, 0, 0] },
          sourceIds: [lexical.sourceId],
        })
      ).mode,
    ).toBe('lexical');
    expect(
      (
        await retrieveHybrid(database.db, reader, {
          query: word,
          queryVector: { spaceId: retired, vector: [1, 0] },
        })
      ).mode,
    ).toBe('lexical');
    await expect(
      retrieveHybrid(database.db, reader, {
        query: word,
        queryVector: { spaceId, vector: [1, 0] },
      }),
    ).rejects.toEqual(new AppError('INVALID_INPUT'));
    await expect(
      retrieveHybrid(database.db, reader, {
        query: word,
        queryVector: { spaceId, vector: [NaN, 0, 0] },
      }),
    ).rejects.toEqual(new AppError('INVALID_INPUT'));
  });
});
