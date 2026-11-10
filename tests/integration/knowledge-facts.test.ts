// Real roles and two tenants. These checks require the integrated M5 migrations, including 0204.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../packages/database/src/schema';
import { AppDatabase } from '../../packages/database/src/tenant';
import { AppError } from '@ensemus/application';
import { pgCode } from '../../packages/application/src/errors';
import {
  disputeFact,
  getFact,
  listFacts,
  proposeFact,
  reviewFact,
  supersedeFact,
  verifiedFactsFor,
} from '@ensemus/application/knowledge/facts';
import {
  clients,
  auditEvents,
  createOrganization,
  domainEvents,
  knowledgeFactEvidence,
  knowledgeFacts,
  knowledgeSources,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  workUnits,
  type TenantContext,
} from '@ensemus/database';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import { seedMember, seedSearchableSource, sha256, type SeededSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('fact provenance and independent review on real database roles', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let owner: TenantContext, reviewer: TenantContext, reader: TenantContext, other: TenantContext;
  let source: SeededSource;
  let clientId: string;
  const passage = 'Generated evidence, not an instruction to verify anything.';
  const evidence = (indices = [0]) =>
    indices.map((index) => ({ chunkId: source.chunkIds[index]!, quoteStart: 0, quoteEnd: 9 }));
  const proposal = (overrides: Partial<Parameters<typeof proposeFact>[2]> = {}) =>
    proposeFact(database.db, owner, {
      subjectRef: `client:${clientId}`,
      predicate: 'relationship.note',
      claim: 'Generated claim',
      origin: 'person',
      evidence: evidence(),
      ...overrides,
    });
  const review = (factId: string, expectedVersion = 1) =>
    reviewFact(database.db, reviewer, {
      factId,
      expectedVersion,
      decision: 'verify',
      reason: 'Reviewed the generated source passage.',
    });
  async function databaseRefusal(operation: Promise<unknown>, expectedCode: string) {
    let refusal: unknown;
    try {
      await operation;
    } catch (error) {
      refusal = error;
    }
    expect(pgCode(refusal)).toBe(expectedCode);
  }
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const makeOwner = async () => {
      const userId = randomUUID();
      await auth.query('insert into identity.users (id,name,email) values ($1,$2,$3)', [
        userId,
        'Generated owner',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Same generated company',
        commercialMode: 'sovereign',
      });
      return resolveTenantContext(database.db, userId, org.organizationId);
    };
    owner = await makeOwner();
    other = await makeOwner();
    const admin = await seedMember(database.db, owner, auth, 'admin');
    reviewer = await resolveTenantContext(database.db, admin.userId, owner.organizationId);
    const member = await seedMember(database.db, owner, auth);
    reader = await resolveTenantContext(database.db, member.userId, owner.organizationId);
    clientId = randomUUID();
    await withTenantTx(database.db, owner, (tx) =>
      tx.insert(clients).values({
        organizationId: owner.organizationId,
        id: clientId,
        displayName: 'Authoritative generated name',
      }),
    );
    source = await seedSearchableSource(database.db, owner, {
      passages: [passage, passage + ' More evidence.'],
      grants: [{ kind: 'organization' }],
    });
  });
  afterAll(async () => {
    await auth?.end();
    await database?.close();
  });

  it('keeps a model proposal untrusted until a separate authorized person reviews', async () => {
    const delegated = await createDelegatedContext(
      database.db,
      owner.organizationId,
      owner.membershipId,
    );
    const created = await proposeFact(database.db, owner, {
      subjectRef: `client:${clientId}`,
      predicate: 'relationship.note',
      claim: 'Generated model claim',
      origin: 'model',
      evidence: evidence(),
    });
    expect(created.trustState).toBe('proposed');
    await expect(
      proposeFact(database.db, delegated, {
        subjectRef: `client:${clientId}`,
        predicate: 'relationship.note',
        claim: 'Forged attribution',
        origin: 'model',
        runId: randomUUID(),
        evidence: evidence(),
      }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    expect(
      (await verifiedFactsFor(database.db, reader, { subjectRefs: [`client:${clientId}`] })).some(
        (f) => f.id === created.factId,
      ),
    ).toBe(false);
    const input = {
      factId: created.factId,
      expectedVersion: 1,
      decision: 'verify' as const,
      reason: 'Generated review.',
    };
    await expect(reviewFact(database.db, owner, input)).rejects.toEqual(
      new AppError('KNOWLEDGE_FACT_NEEDS_PERSON'),
    );
    await expect(reviewFact(database.db, delegated, input)).rejects.toEqual(
      new AppError('KNOWLEDGE_FACT_NEEDS_PERSON'),
    );
    await expect(
      reviewFact(database.db, createServiceContext(owner.organizationId), input),
    ).rejects.toEqual(new AppError('KNOWLEDGE_FACT_NEEDS_PERSON'));
    await expect(reviewFact(database.db, reader, input)).rejects.toEqual(new AppError('FORBIDDEN'));
    expect(await review(created.factId)).toEqual({ trustState: 'verified', version: 2 });
    expect((await getFact(database.db, reader, created.factId)).evidence[0]?.excerpt).toBe(
      'Generated',
    );
  });

  it('records an authoritative-name conflict as disputed, and requires reasoned review', async () => {
    const created = await proposal({ predicate: 'name.is', claim: 'Contradictory generated name' });
    expect(created.trustState).toBe('disputed');
    expect(await getFact(database.db, owner, created.factId)).toMatchObject({
      conflictRef: `client:${clientId}`,
      version: 2,
    });
    await expect(
      reviewFact(database.db, reviewer, {
        factId: created.factId,
        expectedVersion: 2,
        decision: 'verify',
        reason: ' ',
      }),
    ).rejects.toEqual(new AppError('REASON_REQUIRED'));
    await review(created.factId, 2);
    await expect(review(created.factId, 2)).rejects.toEqual(new AppError('VERSION_CONFLICT'));
  });

  it('serializes review with membership revocation and then refuses the stale reviewer context', async () => {
    const admin = await seedMember(database.db, owner, auth, 'admin');
    const viewing = await resolveTenantContext(database.db, admin.userId, owner.organizationId);
    const created = await proposal();
    const pool = new pg.Pool({ connectionString: urls.app(), max: 1 });
    let reachedWrite = false;
    let revocationWaited = false;
    pool.on('connect', (client) => {
      // A separate real connection attempts revocation after the review's permission lock. A short
      // lock timeout proves serialization without making the fixture wait for its own blocked write.
      client.query = new Proxy(client.query, {
        apply(target, receiver, args) {
          const query = args[0] as string | { text?: string };
          const text = typeof query === 'string' ? query : (query.text ?? '');
          if (!reachedWrite && /^update\s+"knowledge"\."facts"\s/i.test(text)) {
            reachedWrite = true;
            return withTenantTx(database.db, owner, async (tx) => {
              await tx.execute(sql`set local lock_timeout='200ms'`);
              return tx
                .update(memberships)
                .set({ status: 'disabled' })
                .where(eq(memberships.id, admin.membershipId));
            }).then(
              () => {
                throw new Error('REVOCATION_IGNORED_REVIEW_LOCK');
              },
              (error: unknown) => {
                expect(pgCode(error)).toBe('55P03');
                revocationWaited = true;
                return Reflect.apply(target, receiver, args);
              },
            );
          }
          return Reflect.apply(target, receiver, args);
        },
      });
    });
    const throughBarrier = new AppDatabase(drizzle(pool, { schema, casing: 'snake_case' }));
    try {
      await reviewFact(throughBarrier, viewing, {
        factId: created.factId,
        expectedVersion: 1,
        decision: 'verify',
        reason: 'Review held valid access until its transaction committed.',
      });
      expect(reachedWrite).toBe(true);
      expect(revocationWaited).toBe(true);
      expect(await getFact(database.db, owner, created.factId)).toMatchObject({
        trustState: 'verified',
        version: 2,
        reviewedByMembershipId: admin.membershipId,
      });
      await withTenantTx(database.db, owner, (tx) =>
        tx
          .update(memberships)
          .set({ status: 'disabled' })
          .where(eq(memberships.id, admin.membershipId)),
      );
      await expect(
        reviewFact(database.db, viewing, {
          factId: created.factId,
          expectedVersion: 2,
          decision: 'reject',
          reason: 'A stale context cannot authorize another change.',
        }),
      ).rejects.toEqual(new AppError('FORBIDDEN'));
      const [events, audits] = await withTenantTx(database.db, owner, async (tx) =>
        Promise.all([
          tx
            .select()
            .from(domainEvents)
            .where(
              and(
                eq(domainEvents.aggregateId, created.factId),
                eq(domainEvents.aggregateVersion, 2),
              ),
            ),
          tx
            .select()
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.targetRef, `knowledge_fact:${created.factId}`),
                eq(auditEvents.action, 'knowledge.fact_reviewed'),
              ),
            ),
        ]),
      );
      expect(events).toHaveLength(1);
      expect(audits).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it('refuses foreign or unreadable evidence and foreign subjects', async () => {
    const foreign = await seedSearchableSource(database.db, other, {
      passages: [passage],
      grants: [{ kind: 'organization' }],
    });
    await expect(
      proposal({ evidence: [{ chunkId: foreign.chunkIds[0]!, quoteStart: 0, quoteEnd: 4 }] }),
    ).rejects.toEqual(new AppError('KNOWLEDGE_FACT_NEEDS_EVIDENCE'));
    await expect(proposal({ subjectRef: `client:${randomUUID()}` })).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    const created = await proposal();
    await expect(getFact(database.db, other, created.factId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    expect((await listFacts(database.db, other, {})).items).toEqual([]);
    await expect(
      listFacts(database.db, createServiceContext(owner.organizationId), {}),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
  });

  it('hides a restricted subject even when its documentary evidence is readable by everyone', async () => {
    const workId = randomUUID();
    await withTenantTx(database.db, owner, (tx) =>
      tx.insert(workUnits).values({
        organizationId: owner.organizationId,
        id: workId,
        title: 'Generated restricted objective',
        ownerMembershipId: owner.membershipId,
        classification: 'restricted',
      }),
    );
    const created = await proposal({ subjectRef: `work_unit:${workId}` });
    expect((await getFact(database.db, owner, created.factId)).classification).toBe('restricted');
    await expect(getFact(database.db, reader, created.factId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    expect(
      await listFacts(database.db, reader, { subjectRef: `work_unit:${workId}`, limit: 1 }),
    ).toEqual({ items: [], next: null });
    expect(
      await verifiedFactsFor(database.db, reader, { subjectRefs: [`work_unit:${workId}`] }),
    ).toEqual([]);
    expect(
      await withTenantTx(database.db, reader, (tx) =>
        tx.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, created.factId)),
      ),
    ).toEqual([]);
  });

  it('binds the proposer identity in SQL and denies ordinary-member verification directly', async () => {
    await databaseRefusal(
      withTenantTx(database.db, owner, (tx) =>
        tx.insert(knowledgeFacts).values({
          organizationId: owner.organizationId,
          subjectRef: `client:${clientId}`,
          predicate: 'relationship.note',
          claim: 'Generated',
          origin: 'person',
          classification: 'internal',
          proposedByMembershipId: reviewer.membershipId,
        }),
      ),
      'EN109',
    );
    const created = await proposal();
    await databaseRefusal(
      withTenantTx(database.db, reader, (tx) =>
        tx
          .update(knowledgeFacts)
          .set({
            trustState: 'verified',
            reviewedByMembershipId: reader.membershipId,
            reviewedAt: new Date(),
            reviewReason: 'Attempted unauthorized review.',
            version: 2,
          })
          .where(eq(knowledgeFacts.id, created.factId)),
      ),
      'EN109',
    );
    expect((await getFact(database.db, owner, created.factId)).trustState).toBe('proposed');
  });

  it('keeps reviewer attribution and reviewed provenance immutable to users and delegated callers', async () => {
    const created = await proposal();
    await review(created.factId);
    const delegated = await createDelegatedContext(
      database.db,
      owner.organizationId,
      reviewer.membershipId,
    );
    await databaseRefusal(
      withTenantTx(database.db, delegated, (tx) =>
        tx
          .update(knowledgeFacts)
          .set({ reviewReason: 'Rewritten by a model.' })
          .where(eq(knowledgeFacts.id, created.factId)),
      ),
      'EN109',
    );
    await databaseRefusal(
      withTenantTx(database.db, delegated, (tx) =>
        tx
          .update(knowledgeFacts)
          .set({ validUntil: new Date(Date.now() + 86_400_000) })
          .where(eq(knowledgeFacts.id, created.factId)),
      ),
      'EN108',
    );
    await databaseRefusal(
      withTenantTx(database.db, owner, (tx) =>
        tx.delete(knowledgeFactEvidence).where(eq(knowledgeFactEvidence.factId, created.factId)),
      ),
      '42501',
    );
    await databaseRefusal(
      withTenantTx(database.db, owner, (tx) =>
        tx.insert(knowledgeFactEvidence).values({
          organizationId: owner.organizationId,
          factId: created.factId,
          chunkId: source.chunkIds[1]!,
          sourceId: source.sourceId,
          contentSha256: sha256(passage + ' More evidence.'),
          quoteStart: 0,
          quoteEnd: 4,
        }),
      ),
      'EN111',
    );
    expect((await getFact(database.db, reviewer, created.factId)).reviewedByMembershipId).toBe(
      reviewer.membershipId,
    );
  });

  it('binds rejected reviews to the actual independent reviewer and refuses forged run attribution', async () => {
    const created = await proposal();
    await databaseRefusal(
      withTenantTx(database.db, reviewer, (tx) =>
        tx
          .update(knowledgeFacts)
          .set({
            trustState: 'rejected',
            reviewedByMembershipId: owner.membershipId,
            reviewedAt: new Date(),
            reviewReason: 'Forged rejection attribution.',
            version: 2,
          })
          .where(eq(knowledgeFacts.id, created.factId)),
      ),
      'EN109',
    );
    await databaseRefusal(
      withTenantTx(database.db, owner, (tx) =>
        tx
          .update(knowledgeFacts)
          .set({
            trustState: 'rejected',
            reviewedByMembershipId: owner.membershipId,
            reviewedAt: new Date(),
            reviewReason: 'Self rejection.',
            version: 2,
          })
          .where(eq(knowledgeFacts.id, created.factId)),
      ),
      'EN109',
    );
    await databaseRefusal(
      withTenantTx(database.db, owner, (tx) =>
        tx.insert(knowledgeFacts).values({
          organizationId: owner.organizationId,
          subjectRef: `client:${clientId}`,
          predicate: 'relationship.note',
          claim: 'Generated',
          origin: 'model',
          classification: 'internal',
          proposedByMembershipId: owner.membershipId,
          proposedByRunId: randomUUID(),
        }),
      ),
      'EN109',
    );
  });

  it('requires purge to invalidate trust atomically when it removes evidence', async () => {
    const created = await proposal({ evidence: evidence([0, 1]) });
    await review(created.factId);
    const service = createServiceContext(owner.organizationId);
    await databaseRefusal(
      withTenantTx(database.db, service, (tx) =>
        tx
          .delete(knowledgeFactEvidence)
          .where(
            and(
              eq(knowledgeFactEvidence.factId, created.factId),
              eq(knowledgeFactEvidence.chunkId, source.chunkIds[0]!),
            ),
          ),
      ),
      'EN110',
    );
    await withTenantTx(database.db, service, async (tx) => {
      await tx
        .update(knowledgeFacts)
        .set({
          trustState: 'disputed',
          conflictRef: `knowledge_source:${source.sourceId}`,
          version: 3,
        })
        .where(eq(knowledgeFacts.id, created.factId));
      await tx
        .delete(knowledgeFactEvidence)
        .where(
          and(
            eq(knowledgeFactEvidence.factId, created.factId),
            eq(knowledgeFactEvidence.chunkId, source.chunkIds[0]!),
          ),
        );
    });
    expect(await getFact(database.db, owner, created.factId)).toMatchObject({
      trustState: 'disputed',
      evidence: [expect.anything()],
    });
  });

  it('supersedes only with a readable verified replacement of the same subject and predicate', async () => {
    const first = await proposal(),
      replacement = await proposal({ claim: 'Replacement generated claim' });
    await expect(
      supersedeFact(database.db, reviewer, {
        factId: first.factId,
        expectedVersion: 1,
        supersededById: replacement.factId,
      }),
    ).rejects.toEqual(new AppError('INVALID_STATE'));
    await review(replacement.factId);
    expect(
      await supersedeFact(database.db, reviewer, {
        factId: first.factId,
        expectedVersion: 1,
        supersededById: replacement.factId,
      }),
    ).toEqual({ version: 2 });
    expect((await getFact(database.db, owner, first.factId)).trustState).toBe('superseded');
    await expect(
      disputeFact(database.db, reviewer, {
        factId: first.factId,
        expectedVersion: 2,
        conflictRef: `client:${clientId}`,
      }),
    ).rejects.toEqual(new AppError('INVALID_TRANSITION'));
  });

  it('stops serving a fact immediately when any source closes', async () => {
    const privateSource = await seedSearchableSource(database.db, owner, {
      passages: [passage],
      grants: [{ kind: 'organization' }],
    });
    const created = await proposal({
      evidence: [{ chunkId: privateSource.chunkIds[0]!, quoteStart: 0, quoteEnd: 9 }],
    });
    await review(created.factId);
    await withTenantTx(database.db, createServiceContext(owner.organizationId), (tx) =>
      tx
        .update(knowledgeSources)
        .set({ state: 'revoked', revokedAt: new Date(), version: 2 })
        .where(eq(knowledgeSources.id, privateSource.sourceId)),
    );
    await expect(getFact(database.db, owner, created.factId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    expect(
      (await verifiedFactsFor(database.db, reviewer, { subjectRefs: [`client:${clientId}`] })).some(
        (row) => row.id === created.factId,
      ),
    ).toBe(false);
  });
});
