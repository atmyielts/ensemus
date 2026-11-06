// Graph visibility is enforced during recursion, before LIMIT, labels and the truncated flag.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, createWorkUnit } from '@ensemus/application';
import { linkNodes, traverseGraph, unlinkEdge } from '@ensemus/application/knowledge/graph';
import { proposeFact, reviewFact } from '@ensemus/application/knowledge/facts';
import {
  clients,
  createOrganization,
  knowledgeEdges,
  openAppDatabase,
  projects,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { eq, sql } from 'drizzle-orm';
import { seedMember, seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('tenant-safe bounded graph traversal', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client;
  let owner: TenantContext, reader: TenantContext, reviewer: TenantContext, foreign: TenantContext;
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const makeOwner = async () => {
      const userId = randomUUID();
      await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
        userId,
        'Generated graph person',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Generated graph company',
        commercialMode: 'sovereign',
      });
      return resolveTenantContext(database.db, userId, org.organizationId);
    };
    owner = await makeOwner();
    foreign = await makeOwner();
    const member = await seedMember(database.db, owner, auth);
    reader = await resolveTenantContext(database.db, member.userId, owner.organizationId);
    const admin = await seedMember(database.db, owner, auth, 'admin');
    reviewer = await resolveTenantContext(database.db, admin.userId, owner.organizationId);
  });
  afterAll(async () => {
    await auth?.end();
    await database?.close();
  });
  async function client(context = owner, classification = 'internal') {
    const id = randomUUID();
    await withTenantTx(database.db, context, (tx) =>
      tx.insert(clients).values({
        organizationId: context.organizationId,
        id,
        displayName: `Generated ${id}`,
        classification,
      }),
    );
    return { type: 'client' as const, id };
  }
  const link = (from: Awaited<ReturnType<typeof client>>, to: Awaited<ReturnType<typeof client>>) =>
    linkNodes(database.db, owner, { from, to, relation: 'related_to' });

  it('refuses services and inactive people, and refuses foreign or unsafe manual links', async () => {
    const a = await client(),
      b = await client(foreign);
    await expect(
      traverseGraph(database.db, createServiceContext(owner.organizationId), { from: a }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    await expect(
      linkNodes(database.db, reader, { from: a, to: a, relation: 'related_to' }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    await expect(link(a, b)).rejects.toEqual(new AppError('NOT_FOUND'));
    await expect(
      linkNodes(database.db, owner, { from: a, to: a, relation: 'arbitrary_grant' }),
    ).rejects.toEqual(new AppError('INVALID_INPUT'));
    const member = await seedMember(database.db, owner, auth),
      disabled = await resolveTenantContext(database.db, member.userId, owner.organizationId);
    await withTenantTx(database.db, owner, (tx) =>
      tx.execute(
        sql`update org.memberships set status='disabled' where id=${member.membershipId}::uuid`,
      ),
    );
    await expect(traverseGraph(database.db, disabled, { from: a })).rejects.toEqual(
      new AppError('FORBIDDEN'),
    );
  });
  it('terminates a cycle, preserves edge direction, and idempotently links/unlinks manual structure', async () => {
    const a = await client(),
      b = await client();
    const first = await link(a, b);
    expect(await link(a, b)).toEqual(first);
    await link(b, a);
    const result = await traverseGraph(database.db, reader, { from: a, depth: 3 });
    expect(result.nodes.map((node) => node.id).sort()).toEqual([a.id, b.id].sort());
    expect(result.edges).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.nodes.find((node) => node.id === a.id)?.depth).toBe(0);
    await unlinkEdge(database.db, owner, { edgeId: first.edgeId });
    expect(
      await withTenantTx(database.db, owner, (tx) =>
        tx.select().from(knowledgeEdges).where(eq(knowledgeEdges.id, first.edgeId)),
      ),
    ).toEqual([]);
  });
  it('does not walk through an unreadable restricted Work Unit to a visible project', async () => {
    const target = await client();
    const projectId = randomUUID();
    await withTenantTx(database.db, owner, (tx) =>
      tx.insert(projects).values({
        organizationId: owner.organizationId,
        id: projectId,
        name: 'Generated target project',
        clientId: target.id,
      }),
    );
    const work = await createWorkUnit(database.db, owner, {
      title: 'Generated hidden work',
      objective: 'Generated',
      classification: 'restricted',
      projectId,
      ownerMembershipId: owner.membershipId,
    });
    const source = await seedSearchableSource(database.db, owner, {
      passages: ['Generated source'],
      grants: [{ kind: 'organization' }],
    });
    const start = { type: 'knowledge_source' as const, id: source.sourceId };
    await linkNodes(database.db, owner, {
      from: start,
      relation: 'documents',
      to: { type: 'work_unit', id: work.id },
    });
    const hidden = await traverseGraph(database.db, reader, { from: start, depth: 3 });
    expect(hidden.nodes.map((node) => node.id)).toEqual([source.sourceId]);
    expect(hidden.edges).toEqual([]);
    expect(hidden.truncated).toBe(false);
    const allowed = await traverseGraph(database.db, owner, { from: start, depth: 3 });
    expect(allowed.nodes.some((node) => node.id === projectId)).toBe(true);
    expect(allowed.nodes.some((node) => node.id === target.id)).toBe(true);
  });
  it('hides confidential client/project labels from a member and all restricted client labels', async () => {
    const internal = await client(),
      secret = await client(owner, 'confidential'),
      restricted = await client(owner, 'restricted');
    await link(internal, secret);
    const projectId = randomUUID();
    await withTenantTx(database.db, owner, (tx) =>
      tx.insert(projects).values({
        organizationId: owner.organizationId,
        id: projectId,
        name: 'Generated confidential project',
        clientId: secret.id,
      }),
    );
    await expect(traverseGraph(database.db, reader, { from: secret })).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    await expect(
      traverseGraph(database.db, reader, { from: { type: 'project', id: projectId } }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    expect(
      (await traverseGraph(database.db, reader, { from: internal })).nodes.map((node) => node.id),
    ).toEqual([internal.id]);
    expect(
      (await traverseGraph(database.db, owner, { from: secret })).nodes.some(
        (node) => node.id === projectId,
      ),
    ).toBe(true);
    await expect(traverseGraph(database.db, owner, { from: restricted })).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
  });
  it('offers only verified visible fact links, never a hidden evidence-based relationship', async () => {
    const a = await client(),
      b = await client();
    const source = await seedSearchableSource(database.db, owner, {
      passages: ['Generated private evidence.'],
      grants: [
        { kind: 'membership', membershipId: owner.membershipId },
        { kind: 'membership', membershipId: reviewer.membershipId },
      ],
    });
    const fact = await proposeFact(database.db, owner, {
      subjectRef: `client:${a.id}`,
      predicate: 'relationship.note',
      claim: 'Generated fact link',
      origin: 'person',
      evidence: [{ chunkId: source.chunkIds[0]!, quoteStart: 0, quoteEnd: 9 }],
    });
    await withTenantTx(database.db, createServiceContext(owner.organizationId), (tx) =>
      tx.insert(knowledgeEdges).values({
        organizationId: owner.organizationId,
        fromType: a.type,
        fromId: a.id,
        toType: b.type,
        toId: b.id,
        relation: 'related_to',
        origin: 'fact',
        factId: fact.factId,
      }),
    );
    expect((await traverseGraph(database.db, owner, { from: a })).nodes).toHaveLength(1);
    await reviewFact(database.db, reviewer, {
      factId: fact.factId,
      expectedVersion: 1,
      decision: 'verify',
      reason: 'Generated independent review',
    });
    expect((await traverseGraph(database.db, owner, { from: a })).nodes).toHaveLength(2);
    expect((await traverseGraph(database.db, reader, { from: a })).nodes).toHaveLength(1);
  });
  it('reports visible truncation at the node limit without counting hidden nodes', async () => {
    const root = await client();
    for (let i = 0; i < 3; i++) await link(root, await client());
    const result = await traverseGraph(database.db, reader, { from: root, limit: 2 });
    expect(result.nodes).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(
      result.edges.every(
        (edge) =>
          result.nodes.some((node) => node.id === edge.from.id) &&
          result.nodes.some((node) => node.id === edge.to.id),
      ),
    ).toBe(true);
    const hiddenRoot = await client();
    await link(hiddenRoot, await client(owner, 'confidential'));
    expect(
      (await traverseGraph(database.db, reader, { from: hiddenRoot, limit: 2 })).truncated,
    ).toBe(false);
  });
});
