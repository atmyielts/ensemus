// 0209: real roles, explicit named access, fresh revocation and consistent lists/search/facts.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  createClient,
  createProject,
  getClientSharing,
  listClients,
  listProjects,
  setClientReaders,
} from '@ensemus/application';
import { searchCompany } from '@ensemus/application/knowledge/company-search';
import { getFact, proposeFact, reviewFact } from '@ensemus/application/knowledge/facts';
import { linkNodes, traverseGraph } from '@ensemus/application/knowledge/graph';
import {
  auditEvents,
  clientReaders,
  clients,
  createOrganization,
  memberships,
  openAppDatabase,
  projects,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import { pgCode } from '../../packages/application/src/errors';
import { seedMember, seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('named client visibility on PostgreSQL application roles', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client;
  let owner: TenantContext, reader: TenantContext, admin: TenantContext, foreign: TenantContext;
  const makeOwner = async () => {
    const id = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
      id,
      'Generated person',
      `${id}@example.invalid`,
    ]);
    const organization = await createOrganization(database.db, {
      userId: id,
      name: 'Generated company',
      commercialMode: 'sovereign',
    });
    return resolveTenantContext(database.db, id, organization.organizationId);
  };
  const makeClient = async (classification = 'restricted') => {
    const value = await createClient(database.db, owner, {
      displayName: 'Generated client ' + randomUUID(),
      classification,
    });
    if (!value) throw new Error('Client seed refused');
    return value;
  };
  const visible = (context: TenantContext, id: string) =>
    withTenantTx(database.db, context, (tx) => tx.select().from(clients).where(eq(clients.id, id)));
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    owner = await makeOwner();
    foreign = await makeOwner();
    const member = await seedMember(database.db, owner, auth);
    reader = await resolveTenantContext(database.db, member.userId, owner.organizationId);
    const manager = await seedMember(database.db, owner, auth, 'admin');
    admin = await resolveTenantContext(database.db, manager.userId, owner.organizationId);
  });
  afterAll(async () => {
    await auth?.end();
    await database?.close();
  });

  it('keeps a restricted client visible to its creator and denies an unnamed administrator', async () => {
    const client = await makeClient();
    expect(client.ownerMembershipId).toBe(owner.membershipId);
    expect(await visible(owner, client.id)).toHaveLength(1);
    for (const person of [reader, admin, foreign]) {
      expect(await visible(person, client.id)).toEqual([]);
      expect((await listClients(database.db, person)).some((value) => value.id === client.id)).toBe(
        false,
      );
    }
  });
  it('shares a client and associated projects only with explicit active named readers, with immediate revocation', async () => {
    const client = await makeClient();
    const project = await createProject(database.db, owner, {
      name: 'Generated private project',
      clientId: client.id,
    });
    if (!project) throw new Error('Project seed refused');
    expect((await listProjects(database.db, reader)).some((value) => value.id === project.id)).toBe(
      false,
    );
    expect(
      await setClientReaders(database.db, owner, {
        clientId: client.id,
        expectedVersion: 1,
        readerMembershipIds: [reader.membershipId],
      }),
    ).toEqual({ version: 2 });
    expect(await visible(reader, client.id)).toHaveLength(1);
    expect(
      (await listProjects(database.db, reader)).find((value) => value.id === project.id)
        ?.clientName,
    ).toBe(client.displayName);
    expect(await visible(admin, client.id)).toEqual([]);
    await setClientReaders(database.db, owner, {
      clientId: client.id,
      expectedVersion: 2,
      readerMembershipIds: [],
    });
    expect(await visible(reader, client.id)).toEqual([]);
    expect(
      await withTenantTx(database.db, reader, (tx) =>
        tx.select().from(projects).where(eq(projects.id, project.id)),
      ),
    ).toEqual([]);
  });
  it('keeps confidential/internal semantics while still honoring explicitly named people', async () => {
    const confidential = await makeClient('confidential'),
      internal = await makeClient('internal');
    expect(await visible(admin, confidential.id)).toHaveLength(1);
    expect(await visible(reader, confidential.id)).toEqual([]);
    expect(await visible(reader, internal.id)).toHaveLength(1);
    await setClientReaders(database.db, owner, {
      clientId: confidential.id,
      expectedVersion: 1,
      readerMembershipIds: [reader.membershipId],
    });
    expect(await visible(reader, confidential.id)).toHaveLength(1);
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .update(clients)
        .set({ classification: 'restricted' })
        .where(eq(clients.id, confidential.id)),
    );
    expect(await visible(admin, confidential.id)).toEqual([]);
    expect(await visible(reader, confidential.id)).toHaveLength(1);
  });
  it('allows reader/admin evidence locks and independent fact review without granting client mutation', async () => {
    const restricted = await makeClient(),
      confidential = await makeClient('confidential');
    await setClientReaders(database.db, owner, {
      clientId: restricted.id,
      expectedVersion: 1,
      readerMembershipIds: [reader.membershipId],
    });
    const source = await seedSearchableSource(database.db, owner, {
      passages: ['Generated evidence passage'],
      grants: [{ kind: 'organization' }],
    });
    for (const [person, client] of [
      [reader, restricted],
      [admin, confidential],
    ] as const) {
      expect(
        await withTenantTx(database.db, person, (tx) =>
          tx.select().from(clients).where(eq(clients.id, client.id)).for('share'),
        ),
      ).toHaveLength(1);
      const fact = await proposeFact(database.db, owner, {
        subjectRef: `client:${client.id}`,
        predicate: 'relationship.note',
        claim: 'Generated reviewed claim',
        origin: 'person',
        evidence: [{ chunkId: source.chunkIds[0]!, quoteStart: 0, quoteEnd: 9 }],
      });
      expect((await getFact(database.db, person, fact.factId)).claim).toBe(
        'Generated reviewed claim',
      );
      if (person === admin)
        expect(
          await reviewFact(database.db, person, {
            factId: fact.factId,
            expectedVersion: 1,
            decision: 'verify',
            reason: 'Generated independent review',
          }),
        ).toEqual({ trustState: 'verified', version: 2 });
      let refusal: unknown;
      try {
        await withTenantTx(database.db, person, (tx) =>
          tx
            .update(clients)
            .set({ displayName: 'Unauthorized change' })
            .where(eq(clients.id, client.id)),
        );
      } catch (error) {
        refusal = error;
      }
      expect(pgCode(refusal)).toBe('42501');
      expect((await visible(owner, client.id))[0]?.displayName).toBe(client.displayName);
    }
  });
  it('does not let a reader, manager, delegated actor or foreign tenant change the named-reader set', async () => {
    const client = await makeClient();
    await setClientReaders(database.db, owner, {
      clientId: client.id,
      expectedVersion: 1,
      readerMembershipIds: [reader.membershipId],
    });
    for (const person of [reader, admin, foreign])
      await expect(
        setClientReaders(database.db, person, {
          clientId: client.id,
          expectedVersion: 2,
          readerMembershipIds: [],
        }),
      ).rejects.toEqual(new AppError('NOT_FOUND'));
    const delegated = await createDelegatedContext(
      database.db,
      owner.organizationId,
      owner.membershipId,
    );
    for (const person of [delegated, createServiceContext(owner.organizationId)])
      await expect(getClientSharing(database.db, person, client.id)).rejects.toEqual(
        new AppError('FORBIDDEN'),
      );
    await expect(
      setClientReaders(database.db, owner, {
        clientId: client.id,
        expectedVersion: 2,
        readerMembershipIds: [foreign.membershipId],
      }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    expect(
      (await getClientSharing(database.db, owner, client.id)).readers.map(
        (value) => value.membershipId,
      ),
    ).toEqual([reader.membershipId]);
  });
  it.each(['confidential', 'restricted'] as const)(
    'does not let a named reader or non-owning admin reparent a %s client project into public scope',
    async (classification) => {
      const privateClient = await makeClient(classification),
        publicClient = await makeClient('public');
      await setClientReaders(database.db, owner, {
        clientId: privateClient.id,
        expectedVersion: 1,
        readerMembershipIds: [
          reader.membershipId,
          ...(classification === 'restricted' ? [admin.membershipId] : []),
        ],
      });
      const project = await createProject(database.db, owner, {
        name: 'Generated protected project',
        clientId: privateClient.id,
      });
      if (!project) throw new Error('Project seed refused');
      for (const person of [reader, admin]) {
        expect((await listProjects(database.db, person)).some((row) => row.id === project.id)).toBe(
          true,
        );
        for (const clientId of [null, publicClient.id]) {
          let refusal: unknown;
          try {
            await withTenantTx(database.db, person, (tx) =>
              tx.update(projects).set({ clientId }).where(eq(projects.id, project.id)),
            );
          } catch (error) {
            refusal = error;
          }
          expect(pgCode(refusal)).toBe('42501');
          expect(
            (await listProjects(database.db, owner)).find((row) => row.id === project.id)?.clientId,
          ).toBe(privateClient.id);
        }
      }
      // A delegated run may read as its initiating owner, but does not acquire the owner's human consent.
      const delegated = await createDelegatedContext(
        database.db,
        owner.organizationId,
        owner.membershipId,
      );
      let refusal: unknown;
      try {
        await withTenantTx(database.db, delegated, (tx) =>
          tx.update(projects).set({ clientId: null }).where(eq(projects.id, project.id)),
        );
      } catch (error) {
        refusal = error;
      }
      expect(pgCode(refusal)).toBe('42501');
      let unboundActor: unknown;
      try {
        await withTenantTx(database.db, owner, async (tx) => {
          await tx.execute(sql`select set_config('app.actor_type','',true)`);
          await tx.update(projects).set({ clientId: null }).where(eq(projects.id, project.id));
        });
      } catch (error) {
        unboundActor = error;
      }
      expect(pgCode(unboundActor)).toBe('42501');
      expect(
        await withTenantTx(database.db, owner, (tx) =>
          tx
            .update(projects)
            .set({ clientId: publicClient.id })
            .where(eq(projects.id, project.id))
            .returning({ id: projects.id }),
        ),
      ).toEqual([{ id: project.id }]);
      expect(
        (await listProjects(database.db, reader)).find((row) => row.id === project.id)?.clientId,
      ).toBe(publicClient.id);
    },
  );
  it('allows explicit service import authority and the actual owner to detach a private project', async () => {
    const privateClient = await makeClient(),
      project = await createProject(database.db, owner, {
        name: 'Generated service project',
        clientId: privateClient.id,
      });
    if (!project) throw new Error('Project seed refused');
    const service = createServiceContext(owner.organizationId);
    expect(
      await withTenantTx(database.db, service, (tx) =>
        tx
          .update(projects)
          .set({ clientId: null })
          .where(eq(projects.id, project.id))
          .returning({ id: projects.id }),
      ),
    ).toEqual([{ id: project.id }]);
    await withTenantTx(database.db, owner, (tx) =>
      tx.update(projects).set({ clientId: privateClient.id }).where(eq(projects.id, project.id)),
    );
    expect(
      await withTenantTx(database.db, owner, (tx) =>
        tx
          .update(projects)
          .set({ clientId: null })
          .where(eq(projects.id, project.id))
          .returning({ id: projects.id }),
      ),
    ).toEqual([{ id: project.id }]);
    const foreignClient = await createClient(database.db, foreign, {
      displayName: 'Generated foreign client',
      classification: 'public',
    });
    if (!foreignClient) throw new Error('Foreign client seed refused');
    for (const [person, expectedCode] of [
      [owner, '42501'],
      [service, '23503'],
    ] as const) {
      let refusal: unknown;
      try {
        await withTenantTx(database.db, person, (tx) =>
          tx
            .update(projects)
            .set({ clientId: foreignClient.id })
            .where(eq(projects.id, project.id)),
        );
      } catch (error) {
        refusal = error;
      }
      expect(pgCode(refusal)).toBe(expectedCode);
      expect(
        (await listProjects(database.db, owner)).find((row) => row.id === project.id)?.clientId,
      ).toBeNull();
    }
  });
  it('refuses client-lock contention and rechecks the committed classification on the next request', async () => {
    const client = await makeClient('internal');
    await setClientReaders(database.db, owner, {
      clientId: client.id,
      expectedVersion: 1,
      readerMembershipIds: [reader.membershipId],
    });
    const project = await createProject(database.db, owner, {
      name: 'Generated classification race',
      clientId: client.id,
    });
    if (!project) throw new Error('Project seed refused');
    await withTenantTx(database.db, owner, async (tx) => {
      await tx
        .update(clients)
        .set({ classification: 'restricted' })
        .where(eq(clients.id, client.id));
      // A second real app-role transaction sees the old committed classification, but must not
      // authorize from it or wait project -> client while this transaction owns the client row.
      let busy: unknown;
      try {
        await withTenantTx(database.db, reader, (other) =>
          other.update(projects).set({ clientId: null }).where(eq(projects.id, project.id)),
        );
      } catch (error) {
        busy = error;
      }
      expect(pgCode(busy)).toBe('55P03');
    });
    let refused: unknown;
    try {
      await withTenantTx(database.db, reader, (tx) =>
        tx.update(projects).set({ clientId: null }).where(eq(projects.id, project.id)),
      );
    } catch (error) {
      refused = error;
    }
    expect(pgCode(refused)).toBe('42501');
    expect(
      (await listProjects(database.db, owner)).find((row) => row.id === project.id)?.clientId,
    ).toBe(client.id);
  });
  it('acknowledges an identical duplicate form once and refuses a stale changed set without losing access', async () => {
    const client = await makeClient();
    const input = {
      clientId: client.id,
      expectedVersion: 1,
      readerMembershipIds: [reader.membershipId],
    };
    expect(
      await Promise.all([
        setClientReaders(database.db, owner, input),
        setClientReaders(database.db, owner, input),
      ]),
    ).toEqual([{ version: 2 }, { version: 2 }]);
    await expect(
      setClientReaders(database.db, owner, { ...input, readerMembershipIds: [] }),
    ).rejects.toEqual(new AppError('VERSION_CONFLICT'));
    const audits = await withTenantTx(database.db, owner, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetRef, `client:${client.id}`),
            eq(auditEvents.action, 'client.access_changed'),
          ),
        ),
    );
    expect(audits).toHaveLength(1);
    expect(await visible(reader, client.id)).toHaveLength(1);
  });
  it('does not expose private client/project search hits or a fact backed by otherwise readable evidence', async () => {
    const keyword = 'Private' + randomUUID().replaceAll('-', '');
    const client = await createClient(database.db, owner, {
      displayName: keyword,
      classification: 'restricted',
    });
    if (!client) throw new Error('Client seed refused');
    const project = await createProject(database.db, owner, { name: keyword, clientId: client.id });
    if (!project) throw new Error('Project seed refused');
    const source = await seedSearchableSource(database.db, owner, {
      passages: ['Generated evidence passage'],
      grants: [{ kind: 'organization' }],
    });
    const fact = await proposeFact(database.db, owner, {
      subjectRef: `client:${client.id}`,
      predicate: 'relationship.note',
      claim: 'Generated claim',
      origin: 'person',
      evidence: [{ chunkId: source.chunkIds[0]!, quoteStart: 0, quoteEnd: 9 }],
    });
    await linkNodes(database.db, owner, {
      from: { type: 'knowledge_source', id: source.sourceId },
      relation: 'documents',
      to: { type: 'client', id: client.id },
    });
    const graph = (context: TenantContext) =>
      traverseGraph(database.db, context, {
        from: { type: 'knowledge_source', id: source.sourceId },
        depth: 2,
        limit: 20,
      });
    const beforeGrant = await graph(reader);
    expect(beforeGrant.nodes.map((node) => node.id)).toEqual([source.sourceId]);
    expect(beforeGrant.edges).toEqual([]);
    expect(await searchCompany(database.db, reader, { query: keyword })).toEqual([]);
    await expect(getFact(database.db, reader, fact.factId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    await setClientReaders(database.db, owner, {
      clientId: client.id,
      expectedVersion: 1,
      readerMembershipIds: [reader.membershipId],
    });
    expect(
      (await searchCompany(database.db, reader, { query: keyword }))
        .map((value) => value.kind)
        .sort(),
    ).toEqual(['client', 'project']);
    expect((await getFact(database.db, reader, fact.factId)).claim).toBe('Generated claim');
    const staleReaderContext = reader;
    expect((await graph(staleReaderContext)).nodes.map((node) => node.id).sort()).toEqual(
      [source.sourceId, client.id, project.id].sort(),
    );
    await setClientReaders(database.db, owner, {
      clientId: client.id,
      expectedVersion: 2,
      readerMembershipIds: [],
    });
    expect(await searchCompany(database.db, staleReaderContext, { query: keyword })).toEqual([]);
    await expect(getFact(database.db, staleReaderContext, fact.factId)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    await expect(
      traverseGraph(database.db, staleReaderContext, { from: { type: 'client', id: client.id } }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    const revoked = await graph(staleReaderContext);
    expect(revoked.nodes.map((node) => node.id)).toEqual([source.sourceId]);
    expect(revoked.edges).toEqual([]);
    expect(revoked.truncated).toBe(false);
    expect(JSON.stringify(revoked)).not.toContain(keyword);
  });
  it('enforces ownership and active membership even for direct SQL without a returning clause', async () => {
    const client = await makeClient();
    let denied: unknown;
    try {
      await withTenantTx(database.db, reader, (tx) =>
        tx.insert(clients).values({
          organizationId: owner.organizationId,
          displayName: 'Forged owner',
          ownerMembershipId: owner.membershipId,
        }),
      );
    } catch (error) {
      denied = error;
    }
    expect(pgCode(denied)).toBe('42501');
    await expect(
      createProject(database.db, reader, { name: 'Hidden relationship', clientId: client.id }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    const fresh = await seedMember(database.db, owner, auth),
      disabled = await resolveTenantContext(database.db, fresh.userId, owner.organizationId);
    const own = await createClient(database.db, disabled, {
      displayName: 'Generated owned restricted',
      classification: 'restricted',
    });
    if (!own) throw new Error('Client seed refused');
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'disabled' })
        .where(eq(memberships.id, disabled.membershipId)),
    );
    expect(await visible(disabled, own.id)).toEqual([]);
    expect(
      await withTenantTx(database.db, disabled, (tx) =>
        tx.delete(clients).where(eq(clients.id, own.id)).returning({ id: clients.id }),
      ),
    ).toEqual([]);
    expect(await visible(createServiceContext(owner.organizationId), own.id)).toHaveLength(1);
    expect(
      await withTenantTx(database.db, reader, (tx) =>
        tx.delete(clientReaders).where(eq(clientReaders.clientId, client.id)).returning(),
      ),
    ).toEqual([]);
  });
});
