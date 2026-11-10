import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@ensemus/application';
import {
  askQuestion,
  getAnswer,
  listMyAnswers,
  runAnswer,
} from '@ensemus/application/knowledge/answers';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import {
  createOrganization,
  knowledgeAnswers,
  knowledgeAnswerSources,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createScriptedModelPort, fakeRoute } from '@ensemus/knowledge/testing';
import { eq } from 'drizzle-orm';
import { knowledgeCanary, seedMember, seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('durable cited answers use the asker’s own reach', () => {
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
  const seed = (word: string) =>
    seedSearchableSource(database.db, owner, {
      passages: [word],
      grants: [{ kind: 'organization' }],
    });
  const run = (answerId: string, model: Parameters<typeof runAnswer>[2]['model']) =>
    runAnswer(
      database.db,
      { service: createServiceContext(owner.organizationId), asker: reader },
      { model },
      { answerId, signal: AbortSignal.timeout(10_000) },
    );

  it('refuses service questions, defaults omitted class to restricted, and hides another asker or tenant', async () => {
    await expect(
      askQuestion(database.db, createServiceContext(owner.organizationId), {
        question: 'Generated',
      }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    const input = { question: knowledgeCanary(), requestKey: randomUUID() };
    const first = await askQuestion(database.db, reader, input);
    expect(await askQuestion(database.db, reader, input)).toEqual(first);
    expect((await getAnswer(database.db, reader, first.answerId)).questionClassification).toBe(
      'restricted',
    );
    for (const context of [owner, foreign])
      await expect(getAnswer(database.db, context, first.answerId)).rejects.toEqual(
        new AppError('NOT_FOUND'),
      );
  });
  it('makes no model call with no authorized evidence, even for a secret question', async () => {
    const { answerId } = await askQuestion(database.db, reader, {
      question: knowledgeCanary(),
      classification: 'restricted',
    });
    const model = createScriptedModelPort({});
    expect(await run(answerId, model)).toEqual({
      outcome: 'no_evidence',
      code: 'NO_AUTHORIZED_EVIDENCE',
    });
    expect(model.calls).toEqual([]);
    expect(await getAnswer(database.db, reader, answerId)).toMatchObject({
      answerText: null,
      strongestClassification: 'restricted',
    });
  });
  it('does not send a secret question merely because the retrieved document is ordinary', async () => {
    const word = knowledgeCanary();
    await seed(word);
    const { answerId } = await askQuestion(database.db, reader, {
      question: word,
      classification: 'restricted',
    });
    const model = createScriptedModelPort({
      route: (request) =>
        request.classification === 'restricted'
          ? { decision: 'deny', reasonCode: 'EGRESS_DENIED', policyVersion: 'test' }
          : { decision: 'allow', route: fakeRoute() },
    });
    expect(await run(answerId, model)).toEqual({ outcome: 'refused', code: 'EGRESS_DENIED' });
    expect(model.calls.every((call) => call.method === 'route')).toBe(true);
  });
  it('stores checked citations and measured cost once, and lists only the asker’s answers', async () => {
    const word = knowledgeCanary();
    const source = await seed(word);
    const { answerId } = await askQuestion(database.db, reader, {
      question: word,
      classification: 'internal',
    });
    const model = createScriptedModelPort({
      answer: () => ({
        text: 'Generated claim.[S1]',
        usage: { inputTokens: 10, outputTokens: 3, costMicros: 21 },
      }),
    });
    expect(await run(answerId, model)).toEqual({ outcome: 'answered', code: null });
    expect(await run(answerId, model)).toEqual({ outcome: 'already_done', code: null });
    expect(model.calls.filter((call) => call.method === 'answer')).toHaveLength(1);
    expect(await getAnswer(database.db, reader, answerId)).toMatchObject({
      answerText: 'Generated claim.',
      costMicros: 21,
      citations: [
        { sourceId: source.sourceId, answerStart: 0, answerEnd: 16, freshness: 'current' },
      ],
    });
    expect((await listMyAnswers(database.db, reader, { limit: 1 })).items).toHaveLength(1);
    expect((await listMyAnswers(database.db, owner, {})).items).toEqual([]);
  });
  it('discards forged citation output and every raw provider exception', async () => {
    for (const kind of ['citation', 'provider'] as const) {
      const word = knowledgeCanary();
      await seed(word);
      const { answerId } = await askQuestion(database.db, reader, {
        question: word,
        classification: 'internal',
      });
      const canary = knowledgeCanary('provider');
      const model = createScriptedModelPort({
        answer: () => {
          if (kind === 'provider') throw new Error(canary);
          return {
            text: `${canary}.[S999]`,
            usage: { inputTokens: 1, outputTokens: 1, costMicros: null },
          };
        },
      });
      expect(await run(answerId, model)).toMatchObject({
        outcome: kind === 'provider' ? 'failed' : 'refused',
      });
      const view = await getAnswer(database.db, reader, answerId);
      expect(view.answerText).toBeNull();
      expect(JSON.stringify(view)).not.toContain(canary);
    }
  });
  it('records every supplied source before a model call and discards a response after revoke', async () => {
    const word = knowledgeCanary();
    const source = await seed(word);
    const { answerId } = await askQuestion(database.db, reader, {
      question: word,
      classification: 'internal',
    });
    const base = createScriptedModelPort({});
    const model = {
      ...base,
      async answer() {
        const sources = await withTenantTx(
          database.db,
          createServiceContext(owner.organizationId),
          (tx) =>
            tx
              .select()
              .from(knowledgeAnswerSources)
              .where(eq(knowledgeAnswerSources.answerId, answerId)),
        );
        expect(sources.map((row) => row.sourceId)).toEqual([source.sourceId]);
        await revokeSource(database.db, owner, {
          sourceId: source.sourceId,
          expectedVersion: 1,
          reason: 'Generated revoke during answer',
        });
        return {
          text: 'Generated claim.[S1]',
          usage: { inputTokens: 1, outputTokens: 1, costMicros: null },
        };
      },
    };
    expect(await run(answerId, model)).toMatchObject({ outcome: 'refused', code: 'EGRESS_DENIED' });
    await expect(getAnswer(database.db, reader, answerId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    const [row] = await withTenantTx(
      database.db,
      createServiceContext(owner.organizationId),
      (tx) => tx.select().from(knowledgeAnswers).where(eq(knowledgeAnswers.id, answerId)),
    );
    expect(row?.answerText).toBeNull();
  });
});
