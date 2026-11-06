// SEC-03 / QA-015: live permission changes, with no cache expiry or purge needed before denial.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, addTeamMember, createTeam } from '@ensemus/application';
import { searchCompany } from '@ensemus/application/knowledge/company-search';
import { searchLexical } from '@ensemus/application/knowledge/retrieval';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import {
  connections,
  createOrganization,
  externalResourceAcl,
  externalResources,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { eq } from 'drizzle-orm';
import { knowledgeCanary, seedMember, seedSearchableSource, sha256 } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('knowledge isolation stays live after authority changes', () => {
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
      await auth.query('insert into identity.users (id,name,email) values ($1,$2,$3)', [
        userId,
        'Same name',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Same name',
        commercialMode: 'byom',
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
  const hits = (word: string, context = reader) =>
    searchLexical(database.db, context, { query: word });

  it('keeps same-text tenants separate and a source revoke takes effect before derived data is purged', async () => {
    const word = knowledgeCanary();
    const source = await seedSearchableSource(database.db, owner, {
      title: word,
      passages: [word],
      grants: [{ kind: 'organization' }],
    });
    const rival = await seedSearchableSource(database.db, foreign, {
      title: word,
      passages: [word],
      grants: [{ kind: 'organization' }],
    });
    expect((await hits(word)).map((hit) => hit.sourceId)).toEqual([source.sourceId]);
    expect((await hits(word, foreign)).map((hit) => hit.sourceId)).toEqual([rival.sourceId]);
    await revokeSource(database.db, owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Generated test revoke',
    });
    expect(await hits(word)).toEqual([]);
    expect(await searchCompany(database.db, reader, { query: word, kinds: ['document'] })).toEqual(
      [],
    );
    const retained = await withTenantTx(
      database.db,
      createServiceContext(owner.organizationId),
      (tx) =>
        tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.sourceId, source.sourceId)),
    );
    expect(retained).toHaveLength(1);
  });

  async function connector(word: string, restrictedTeam = false) {
    const connectionId = randomUUID(),
      resourceId = randomUUID(),
      sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID();
    let teamId: string | null = null;
    if (restrictedTeam) {
      const team = await createTeam(database.db, owner, { name: `Generated ${randomUUID()}` });
      teamId = team!.id;
      await addTeamMember(database.db, owner, { teamId, membershipId: reader.membershipId });
    }
    await withTenantTx(database.db, owner, async (tx) => {
      await tx.insert(connections).values({
        organizationId: owner.organizationId,
        id: connectionId,
        connectorType: 'google_workspace',
        displayName: 'Generated drive',
      });
      await tx.insert(externalResources).values({
        organizationId: owner.organizationId,
        id: resourceId,
        connectionId,
        stream: 'drive_files',
        resourceType: 'file',
        externalId: resourceId,
        aclState: 'mapped',
        classification: restrictedTeam ? 'restricted' : 'internal',
      });
      await tx.insert(externalResourceAcl).values({
        organizationId: owner.organizationId,
        resourceId,
        principalKind: restrictedTeam ? 'group' : 'user',
        principalExternalId: randomUUID(),
        access: 'read',
        membershipId: teamId ? null : reader.membershipId,
        teamId,
      });
      await tx.insert(knowledgeSources).values({
        organizationId: owner.organizationId,
        id: sourceId,
        kind: 'connector',
        connectionId,
        externalResourceId: resourceId,
        classification: restrictedTeam ? 'restricted' : 'internal',
      });
      await tx.insert(knowledgeDocuments).values({
        organizationId: owner.organizationId,
        id: documentId,
        sourceId,
        versionNo: 1,
        title: word,
        contentSha256: sha256(word),
        sizeBytes: word.length,
        mediaType: 'text/plain',
        classification: restrictedTeam ? 'restricted' : 'internal',
      });
    });
    await withTenantTx(database.db, createServiceContext(owner.organizationId), async (tx) => {
      await tx
        .update(knowledgeDocuments)
        .set({ state: 'parsing' })
        .where(eq(knowledgeDocuments.id, documentId));
      await tx.insert(knowledgeChunks).values({
        organizationId: owner.organizationId,
        id: chunkId,
        documentId,
        sourceId,
        ordinal: 0,
        textBody: word,
        contentSha256: sha256(word),
        tokenEstimate: Math.ceil(word.length / 4),
        charStart: 0,
        charEnd: word.length,
      });
      await tx
        .update(knowledgeDocuments)
        .set({ state: 'searchable', searchableAt: new Date() })
        .where(eq(knowledgeDocuments.id, documentId));
    });
    return { connectionId, resourceId, sourceId };
  }
  it('denies immediately when the provider grant goes, becomes unmapped, or the resource disappears', async () => {
    for (const change of ['grant', 'unmapped', 'gone'] as const) {
      const word = knowledgeCanary();
      const source = await connector(word);
      expect(await hits(word)).toHaveLength(1);
      await withTenantTx(database.db, owner, async (tx) => {
        if (change === 'grant')
          await tx
            .delete(externalResourceAcl)
            .where(eq(externalResourceAcl.resourceId, source.resourceId));
        else
          await tx
            .update(externalResources)
            .set(change === 'gone' ? { deletedAt: new Date() } : { aclState: 'unmapped' })
            .where(eq(externalResources.id, source.resourceId));
      });
      expect(await hits(word)).toEqual([]);
      expect(
        await searchCompany(database.db, reader, { query: word, kinds: ['document'] }),
      ).toEqual([]);
    }
  });
  it('denies immediately when a connection is revoked, and restricted resources never inherit team access', async () => {
    const word = knowledgeCanary();
    const source = await connector(word);
    expect(await hits(word)).toHaveLength(1);
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .update(connections)
        .set({ state: 'revoked', revokedAt: new Date() })
        .where(eq(connections.id, source.connectionId)),
    );
    expect(await hits(word)).toEqual([]);
    const restricted = knowledgeCanary();
    await connector(restricted, true);
    expect(await hits(restricted)).toEqual([]);
    expect(await hits(restricted, owner)).toEqual([]);
  });
  it('freshly checks a member disabled after their context was issued', async () => {
    const member = await seedMember(database.db, owner, auth);
    const context = await resolveTenantContext(database.db, member.userId, owner.organizationId);
    const word = knowledgeCanary();
    await seedSearchableSource(database.db, owner, {
      passages: [word],
      grants: [{ kind: 'membership', membershipId: member.membershipId }],
    });
    expect(await hits(word, context)).toHaveLength(1);
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'disabled' })
        .where(eq(memberships.id, member.membershipId)),
    );
    await expect(hits(word, context)).rejects.toEqual(new AppError('FORBIDDEN'));
    await expect(searchCompany(database.db, context, { query: word })).rejects.toEqual(
      new AppError('FORBIDDEN'),
    );
  });
});
