import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@ensemus/application';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import { proposeFact, reviewFact } from '@ensemus/application/knowledge/facts';
import {
  createOrganization,
  knowledgeEvidencePackages,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createScriptedModelPort, fakeRoute } from '@ensemus/knowledge/testing';
import { eq } from 'drizzle-orm';
import { knowledgeCanary, seedMember, seedSearchableSource, sha256 } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('Context Compiler preserves scope, budget, provenance and query class', () => {
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
      const userId = randomUUID();
      await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
        userId,
        'Same name',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Same company',
        commercialMode: 'sovereign',
      });
      return resolveTenantContext(database.db, userId, org.organizationId);
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
  const compile = (
    question: string,
    model: ReturnType<typeof createScriptedModelPort>,
    context = reader,
    extra: Partial<Parameters<typeof compileEvidence>[3]> = {},
  ) =>
    compileEvidence(
      database.db,
      context,
      { model },
      {
        purpose: 'answer',
        question,
        queryClassification: 'internal',
        budgetTokens: 500,
        signal: AbortSignal.timeout(10_000),
        ...extra,
      },
    );
  const seed = (word: string, classification: 'internal' | 'restricted' = 'internal') =>
    seedSearchableSource(database.db, owner, {
      passages: [word],
      classification,
      grants: [{ kind: 'membership', membershipId: reader.membershipId }],
    });

  it('refuses a service context before reaching a model', async () => {
    const model = createScriptedModelPort({});
    await expect(
      compile(knowledgeCanary(), model, createServiceContext(owner.organizationId)),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    expect(model.calls).toEqual([]);
  });
  it('preserves a secret question with zero authorized passages and never sends it to a model', async () => {
    const word = knowledgeCanary();
    const source = await seedSearchableSource(database.db, foreign, {
      passages: [word],
      grants: [{ kind: 'organization' }],
    });
    const model = createScriptedModelPort({});
    const result = await compile(word, model, reader, {
      queryClassification: 'restricted',
      sourceIds: [source.sourceId],
    });
    expect(result).toMatchObject({
      ok: true,
      items: [],
      strongestClassification: 'restricted',
      route: null,
    });
    expect(model.calls).toEqual([]);
    if (!result.ok) throw new Error('UNEXPECTED');
    const [record] = await withTenantTx(database.db, reader, (tx) =>
      tx
        .select()
        .from(knowledgeEvidencePackages)
        .where(eq(knowledgeEvidencePackages.id, result.packageId)),
    );
    expect(record?.querySha256).toBe(sha256(word));
    expect(JSON.stringify(record)).not.toContain(word);
  });
  it('does not grant an owner permission to compile another person’s private document', async () => {
    const word = knowledgeCanary();
    await seed(word);
    expect(await compile(word, createScriptedModelPort({}), owner)).toMatchObject({
      ok: true,
      items: [],
    });
  });
  it('may drop denied evidence for an answer, while an agent turn fails with no transmission', async () => {
    const word = knowledgeCanary();
    const normal = await seed(`${word} ordinary`);
    await seed(`${word} secret`, 'restricted');
    const script = {
      route: (request: { classification: string }) =>
        request.classification === 'restricted'
          ? { decision: 'deny' as const, reasonCode: 'EGRESS_DENIED', policyVersion: 'test' }
          : { decision: 'allow' as const, route: fakeRoute() },
    };
    const answerModel = createScriptedModelPort(script);
    const answer = await compile(word, answerModel);
    expect(answer).toMatchObject({ ok: true, items: [{ sourceId: normal.sourceId }] });
    expect(answerModel.calls.every((call) => call.method === 'route')).toBe(true);
    const agentModel = createScriptedModelPort(script);
    expect(await compile(word, agentModel, reader, { purpose: 'agent_turn' })).toEqual({
      ok: false,
      code: 'EGRESS_DENIED',
    });
    expect(agentModel.calls.every((call) => call.method === 'route')).toBe(true);
  });
  it('never drops a restricted question when ordinary evidence would reach an external route', async () => {
    const word = knowledgeCanary();
    await seed(word);
    const model = createScriptedModelPort({
      route: (request) =>
        request.classification === 'restricted'
          ? { decision: 'deny', reasonCode: 'EGRESS_DENIED', policyVersion: 'test' }
          : { decision: 'allow', route: fakeRoute() },
    });
    expect(await compile(word, model, reader, { queryClassification: 'restricted' })).toEqual({
      ok: false,
      code: 'EGRESS_DENIED',
    });
    expect(model.calls.every((call) => call.method === 'route')).toBe(true);
  });
  it('stores only pinned hashes and IDs, with equal package hashes on equal inputs', async () => {
    const word = knowledgeCanary();
    await seed(word);
    const model = createScriptedModelPort({});
    const first = await compile(word, model),
      second = await compile(word, model);
    if (!first.ok || !second.ok) throw new Error('UNEXPECTED');
    expect(first.items).toEqual(second.items);
    expect(first.usedTokens).toBeLessThanOrEqual(500);
    const records = await withTenantTx(database.db, reader, (tx) =>
      tx.select().from(knowledgeEvidencePackages),
    );
    expect(records.find((row) => row.id === first.packageId)?.packageSha256).toBe(
      records.find((row) => row.id === second.packageId)?.packageSha256,
    );
    expect(JSON.stringify(records)).not.toContain(word);
  });
  it('rechecks after an optional reranker and returns no revoked passage', async () => {
    const word = knowledgeCanary();
    const source = await seed(word);
    const base = createScriptedModelPort({});
    const model = {
      ...base,
      async rerank() {
        await revokeSource(database.db, owner, {
          sourceId: source.sourceId,
          expectedVersion: 1,
          reason: 'Generated revoke during rank',
        });
        return { order: [0], usage: { inputTokens: 1, outputTokens: 0, costMicros: null } };
      },
    };
    expect(
      await compileEvidence(
        database.db,
        reader,
        { model },
        {
          purpose: 'answer',
          question: word,
          queryClassification: 'internal',
          budgetTokens: 100,
          signal: AbortSignal.timeout(10_000),
        },
      ),
    ).toMatchObject({ ok: true, items: [] });
  });
  it('includes only freshly verified facts with all evidence present and records their provenance', async () => {
    const word = knowledgeCanary();
    const source = await seedSearchableSource(database.db, owner, {
      passages: [word],
      grants: [{ kind: 'organization' }],
    });
    const fact = await proposeFact(database.db, reader, {
      subjectRef: `knowledge_source:${source.sourceId}`,
      predicate: 'generated_label',
      claim: { label: word },
      origin: 'person',
      evidence: [{ chunkId: source.chunkIds[0]!, quoteStart: 0, quoteEnd: word.length }],
    });
    expect(await compile(word, createScriptedModelPort({}))).toMatchObject({
      ok: true,
      verifiedFacts: [],
    });
    await reviewFact(database.db, owner, {
      factId: fact.factId,
      expectedVersion: 1,
      decision: 'verify',
      reason: 'Checked the generated source.',
    });
    const result = await compile(word, createScriptedModelPort({}));
    expect(result).toMatchObject({ ok: true, verifiedFacts: [{ factId: fact.factId }] });
    if (!result.ok) throw new Error('UNEXPECTED');
    const [record] = await withTenantTx(database.db, reader, (tx) =>
      tx
        .select()
        .from(knowledgeEvidencePackages)
        .where(eq(knowledgeEvidencePackages.id, result.packageId)),
    );
    expect(record?.verifiedFactIds).toEqual([fact.factId]);
    expect(JSON.stringify(record)).not.toContain(word);
  });
});
