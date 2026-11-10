import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  embedDocument,
  embedQuery,
  ensureEmbeddingSpace,
  listDocumentsNeedingEmbedding,
} from '@ensemus/application/knowledge/embeddings';
import { searchLexical } from '@ensemus/application/knowledge/retrieval';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import { raiseSourceClassification } from '@ensemus/application/knowledge/sources';
import {
  createOrganization,
  knowledgeDocuments,
  knowledgeEmbeddings,
  knowledgeEmbeddingSpaces,
  knowledgeModelCalls,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createScriptedModelPort as scriptedModel } from '@ensemus/knowledge/testing';
import type { ModelRoute } from '@ensemus/knowledge/ports';
import { seedQualifiedKnowledgeRoute } from '../helpers/knowledge-models';
import { eq } from 'drizzle-orm';
import { knowledgeCanary, seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('policy-first embedding and isolated spaces', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client, owner: TenantContext;
  let qualifiedRoute: ModelRoute;
  const createScriptedModelPort = (script: Parameters<typeof scriptedModel>[0]) =>
    scriptedModel({
      ...script,
      route: script.route ?? (() => ({ decision: 'allow', route: qualifiedRoute })),
    });
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
      userId,
      'Generated',
      `${userId}@example.invalid`,
    ]);
    const org = await createOrganization(database.db, {
      userId,
      name: 'Generated',
      commercialMode: 'sovereign',
    });
    owner = await resolveTenantContext(database.db, userId, org.organizationId);
    qualifiedRoute = await seedQualifiedKnowledgeRoute(database.db, owner);
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  const service = () => createServiceContext(owner.organizationId);
  const seed = (word: string, classification: 'restricted' | 'internal' = 'internal') =>
    seedSearchableSource(database.db, owner, {
      passages: [word],
      classification,
      grants: [{ kind: 'membership', membershipId: owner.membershipId }],
    });
  const embed = (documentId: string, model: Parameters<typeof embedDocument>[2]['model']) =>
    embedDocument(
      database.db,
      service(),
      { model },
      { documentId, signal: AbortSignal.timeout(10_000) },
    );
  it('denies a restricted input before embedding and keeps lexical search available', async () => {
    const word = knowledgeCanary(),
      source = await seed(word, 'restricted');
    const model = createScriptedModelPort({
      route: () => ({ decision: 'deny', reasonCode: 'EGRESS_DENIED', policyVersion: 'v1' }),
    });
    expect(await embed(source.documentId, model)).toMatchObject({
      state: 'denied',
      code: 'EGRESS_DENIED',
      embedded: 0,
    });
    expect(model.calls).toEqual([{ method: 'route', purpose: 'embed' }]);
    expect(await searchLexical(database.db, owner, { query: word })).toHaveLength(1);
    const rows = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeModelCalls)
        .where(eq(knowledgeModelCalls.documentId, source.documentId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dataClass: 'restricted', decision: 'deny' });
    expect(JSON.stringify(rows)).not.toContain(word);
  });
  it('stores once, resumes by hash, and records exact vector space dimensions', async () => {
    const source = await seed(knowledgeCanary());
    const model = createScriptedModelPort({});
    expect(await embed(source.documentId, model)).toMatchObject({ state: 'embedded', embedded: 1 });
    expect(await embed(source.documentId, model)).toMatchObject({ state: 'embedded', embedded: 0 });
    expect(model.calls.filter((c) => c.method === 'embed')).toHaveLength(1);
    const rows = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeEmbeddings)
        .where(eq(knowledgeEmbeddings.sourceId, source.sourceId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.embedding).toHaveLength(4);
  });
  it('fails a wrong-size vector with a fixed code and never stores it', async () => {
    const source = await seed(knowledgeCanary());
    const model = createScriptedModelPort({
      embed: () => ({
        vectors: [[1, 0]],
        usage: { inputTokens: 1, outputTokens: 0, costMicros: null },
      }),
    });
    expect(await embed(source.documentId, model)).toMatchObject({
      state: 'failed',
      code: 'SPACE_MISMATCH',
    });
    const rows = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeEmbeddings)
        .where(eq(knowledgeEmbeddings.sourceId, source.sourceId)),
    );
    expect(rows).toEqual([]);
  });
  it('retire/activate changes never mix spaces, and queries cannot reroute into a different one', async () => {
    const first = await ensureEmbeddingSpace(database.db, service(), qualifiedRoute);
    const secondRoute = await seedQualifiedKnowledgeRoute(database.db, owner, {
      modelId: 'generated-eight',
      dimension: 8,
      vectorSpaceVersion: 'v2',
    });
    const second = await ensureEmbeddingSpace(database.db, service(), secondRoute);
    expect(second.id).not.toBe(first.id);
    const spaces = await withTenantTx(database.db, service(), (tx) =>
      tx.select().from(knowledgeEmbeddingSpaces),
    );
    expect(spaces.find((s) => s.id === first.id)?.state).toBe('retired');
    expect(spaces.filter((s) => s.state === 'active').map((s) => s.id)).toEqual([second.id]);
    const model = createScriptedModelPort({});
    expect(
      await embedQuery(
        database.db,
        owner,
        { model },
        {
          query: 'Generated question',
          classification: 'internal',
          signal: AbortSignal.timeout(10_000),
        },
      ),
    ).toEqual({ ok: false, code: 'SPACE_MISMATCH' });
    expect(model.calls).toEqual([{ method: 'route', purpose: 'embed' }]);
  });
  it('discards vectors if the source closes during the model call', async () => {
    const source = await seed(knowledgeCanary()),
      base = createScriptedModelPort({});
    const model = {
      ...base,
      async embed() {
        await revokeSource(database.db, owner, {
          sourceId: source.sourceId,
          expectedVersion: 1,
          reason: 'Generated revoke',
        });
        return {
          vectors: [[1, 0, 0, 0]],
          usage: { inputTokens: 1, outputTokens: 0, costMicros: null },
        };
      },
    };
    expect(await embed(source.documentId, model)).toMatchObject({ code: 'SOURCE_CLOSED' });
    const rows = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeEmbeddings)
        .where(eq(knowledgeEmbeddings.sourceId, source.sourceId)),
    );
    expect(rows).toEqual([]);
  });
  it('provider failure is a fixed status, and text remains searchable', async () => {
    const word = knowledgeCanary(),
      source = await seed(word);
    const model = createScriptedModelPort({
      embed: () => {
        throw new Error(word);
      },
    });
    expect(await embed(source.documentId, model)).toMatchObject({
      state: 'failed',
      code: 'MODEL_UNAVAILABLE',
    });
    const [row] = await withTenantTx(database.db, service(), (tx) =>
      tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, source.documentId)),
    );
    expect(row?.embeddingReason).toBe('MODEL_UNAVAILABLE');
    expect(await searchLexical(database.db, owner, { query: word })).toHaveLength(1);
  });
  it('denies a secret query before embedding it, even in an existing public space', async () => {
    await ensureEmbeddingSpace(database.db, service(), qualifiedRoute);
    const model = createScriptedModelPort({
      route: () => ({ decision: 'deny', reasonCode: 'EGRESS_DENIED', policyVersion: 'v1' }),
    });
    expect(
      await embedQuery(
        database.db,
        owner,
        { model },
        {
          query: knowledgeCanary(),
          classification: 'restricted',
          signal: AbortSignal.timeout(10_000),
        },
      ),
    ).toEqual({ ok: false, code: 'EGRESS_DENIED' });
    expect(model.calls).toEqual([{ method: 'route', purpose: 'embed' }]);
  });
  it('discards a returned vector if the source class rose during inference', async () => {
    const source = await seed(knowledgeCanary()),
      base = createScriptedModelPort({});
    const model = {
      ...base,
      async embed() {
        await raiseSourceClassification(database.db, owner, {
          sourceId: source.sourceId,
          expectedVersion: 1,
          classification: 'restricted',
        });
        return {
          vectors: [[1, 0, 0, 0]],
          usage: { inputTokens: 1, outputTokens: 0, costMicros: null },
        };
      },
    };
    expect(await embed(source.documentId, model)).toMatchObject({
      state: 'denied',
      code: 'EGRESS_DENIED',
    });
    expect(
      await withTenantTx(database.db, service(), (tx) =>
        tx
          .select()
          .from(knowledgeEmbeddings)
          .where(eq(knowledgeEmbeddings.sourceId, source.sourceId)),
      ),
    ).toEqual([]);
  });
  it('discovers a published document after a space change and reindexes without replacing its lexical version', async () => {
    const word = knowledgeCanary(),
      source = await seed(word);
    await embed(source.documentId, createScriptedModelPort({}));
    const route = await seedQualifiedKnowledgeRoute(database.db, owner, {
      modelId: 'generated-reindex-eight',
      dimension: 8,
      vectorSpaceVersion: 'v3',
    });
    const space = await ensureEmbeddingSpace(database.db, service(), route);
    expect(
      (await listDocumentsNeedingEmbedding(database.db, service(), { limit: 50 })).some(
        (row) => row.documentId === source.documentId,
      ),
    ).toBe(true);
    expect(
      await embed(
        source.documentId,
        createScriptedModelPort({ route: () => ({ decision: 'allow', route }) }),
      ),
    ).toMatchObject({ state: 'embedded', embedded: 1 });
    const vectors = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeEmbeddings)
        .where(eq(knowledgeEmbeddings.sourceId, source.sourceId)),
    );
    expect(vectors.some((row) => row.spaceId === space.id && row.dimension === 8)).toBe(true);
    expect(await searchLexical(database.db, owner, { query: word })).toHaveLength(1);
  });
});
