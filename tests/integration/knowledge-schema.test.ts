// ADR-029's database rules on their own: forced RLS, the ACL inside row-level security, and the triggers
// that hold a fact's trust gate and a closed source's purge, whatever application code does. Real
// PostgreSQL, real roles. The slices test behaviour on top of this, each in its own file.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connections,
  createOrganization,
  externalResourceAcl,
  externalResources,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeEmbeddings,
  knowledgeEmbeddingSpaces,
  knowledgeFactEvidence,
  knowledgeFacts,
  knowledgeSourceGrants,
  knowledgeSources,
  mcpTools,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import { DOCUMENT_TRANSITIONS, FACT_TRANSITIONS } from '@ensemus/domain/knowledge';
import { canReadWork } from '@ensemus/domain/policy';
import { eq, sql } from 'drizzle-orm';
import { knowledgeCanary, seedMember, seedSearchableSource, sha256 } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

describe('knowledge rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let superuser: pg.Client;
  let ownerA: TenantContext;
  let ownerB: TenantContext;
  let reader: TenantContext;
  let outsider: TenantContext;

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  const chunksVisibleTo = async (context: TenantContext) =>
    withTenantTx(database.db, context, (tx) => tx.select().from(knowledgeChunks));

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    superuser = new pg.Client({ connectionString: urls.migrator() });
    await superuser.connect();
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const orgA = await createOrganization(database.db, {
      userId: alice,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    const orgB = await createOrganization(database.db, {
      userId: bob,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    ownerA = await resolveTenantContext(database.db, alice, orgA.organizationId);
    ownerB = await resolveTenantContext(database.db, bob, orgB.organizationId);
    const readerUser = await seedMember(database.db, ownerA, auth);
    reader = await resolveTenantContext(database.db, readerUser.userId, orgA.organizationId);
    const outsiderUser = await seedMember(database.db, ownerA, auth);
    outsider = await resolveTenantContext(database.db, outsiderUser.userId, orgA.organizationId);
  });

  afterAll(async () => {
    await auth.end();
    await superuser.end();
    await database.close();
  });

  it('forces row-level security on every table in the schema, and the two beyond it', async () => {
    const { rows } = await superuser.query(`
      select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r'
         and (n.nspname = 'knowledge'
              or (n.nspname = 'integrations' and c.relname = 'mcp_tools')
              or (n.nspname = 'work' and c.relname = 'client_onboardings'))`);
    expect(rows.length).toBeGreaterThanOrEqual(19);
    for (const row of rows) {
      expect([row.relname, row.relrowsecurity, row.relforcerowsecurity]).toEqual([
        row.relname,
        true,
        true,
      ]);
    }
  });

  describe('the ACL, inside row-level security', () => {
    it('shows a passage to who it was granted to, and to nobody else, whatever the query', async () => {
      const word = knowledgeCanary();
      const { chunkIds } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'membership', membershipId: reader.membershipId }],
        passages: [`The secret word is ${word}.`],
      });
      const id = chunkIds[0] as string;
      expect((await chunksVisibleTo(reader)).map((c) => c.id)).toContain(id);
      expect((await chunksVisibleTo(outsider)).map((c) => c.id)).not.toContain(id);
    });

    it('gives an owner of the organization nothing a grant did not', async () => {
      const { chunkIds } = await seedSearchableSource(database.db, reader, {
        grants: [{ kind: 'membership', membershipId: reader.membershipId }],
        passages: ['Only the reader was granted this.'],
      });
      expect((await chunksVisibleTo(ownerA)).map((c) => c.id)).not.toContain(chunkIds[0]);
    });

    it('never crosses tenants, with the same words and the same organization name', async () => {
      const word = knowledgeCanary();
      await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'organization' }],
        passages: [word],
      });
      const seen = await chunksVisibleTo(ownerB);
      expect(seen.map((c) => c.textBody)).not.toContain(word);
    });

    it('takes a removed grant away in that commit', async () => {
      const { chunkIds, sourceId } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'membership', membershipId: reader.membershipId }],
        passages: ['Soon out of reach.'],
      });
      await withTenantTx(database.db, ownerA, (tx) =>
        tx.delete(knowledgeSourceGrants).where(eq(knowledgeSourceGrants.sourceId, sourceId)),
      );
      expect((await chunksVisibleTo(reader)).map((c) => c.id)).not.toContain(chunkIds[0]);
    });

    it('stops serving when a source closes, before any purge has run', async () => {
      const { chunkIds, sourceId } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'membership', membershipId: reader.membershipId }],
        passages: ['Closing now.'],
      });
      await withTenantTx(database.db, ownerA, (tx) =>
        tx
          .update(knowledgeSources)
          .set({ state: 'revoked', revokedAt: new Date() })
          .where(eq(knowledgeSources.id, sourceId)),
      );
      expect((await chunksVisibleTo(reader)).map((c) => c.id)).not.toContain(chunkIds[0]);
      const rows = await withTenantTx(
        database.db,
        createServiceContext(ownerA.organizationId),
        (tx) => tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId)),
      );
      expect(rows).toHaveLength(1);
    });

    it('narrows an organization grant at once when the class rises', async () => {
      const { chunkIds, sourceId } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'organization' }],
        passages: ['Everyone, for now.'],
      });
      await withTenantTx(database.db, ownerA, (tx) =>
        tx
          .update(knowledgeSources)
          .set({ classification: 'confidential' })
          .where(eq(knowledgeSources.id, sourceId)),
      );
      expect((await chunksVisibleTo(reader)).map((c) => c.id)).not.toContain(chunkIds[0]);
    });

    it('reads a connector source through M3s tables, live, and an unmapped one reads nothing', async () => {
      const connectionId = randomUUID();
      const resourceId = randomUUID();
      const service = createServiceContext(ownerA.organizationId);
      const { organizationId } = ownerA;
      await withTenantTx(database.db, ownerA, async (tx) => {
        await tx.insert(connections).values({
          organizationId,
          id: connectionId,
          connectorType: 'google_workspace',
          displayName: 'A test drive',
        });
        await tx.insert(externalResources).values({
          organizationId,
          id: resourceId,
          connectionId,
          stream: 'drive_files',
          resourceType: 'file',
          externalId: `file-${resourceId}`,
          aclState: 'mapped',
        });
        await tx.insert(externalResourceAcl).values({
          organizationId,
          resourceId,
          principalKind: 'user',
          principalExternalId: 'reader@example.invalid',
          access: 'read',
          membershipId: reader.membershipId,
        });
      });
      const sourceId = randomUUID();
      const documentId = randomUUID();
      const chunkId = randomUUID();
      await withTenantTx(database.db, service, async (tx) => {
        await tx.insert(knowledgeSources).values({
          organizationId,
          id: sourceId,
          kind: 'connector',
          connectionId,
          externalResourceId: resourceId,
          classification: 'internal',
        });
        await tx.insert(knowledgeDocuments).values({
          organizationId,
          id: documentId,
          sourceId,
          versionNo: 1,
          title: 'From a drive',
          contentSha256: sha256('x'),
          sizeBytes: 1,
          mediaType: 'text/plain',
          classification: 'internal',
        });
        await tx.insert(knowledgeChunks).values({
          organizationId,
          id: chunkId,
          documentId,
          sourceId,
          ordinal: 0,
          textBody: 'From a drive.',
          contentSha256: sha256('From a drive.'),
          tokenEstimate: 4,
          charStart: 0,
          charEnd: 13,
        });
      });
      expect((await chunksVisibleTo(reader)).map((c) => c.id)).toContain(chunkId);
      expect((await chunksVisibleTo(outsider)).map((c) => c.id)).not.toContain(chunkId);

      // The provider dropped this person, and a sync committed it. Nothing else had to happen.
      await withTenantTx(database.db, service, (tx) =>
        tx.delete(externalResourceAcl).where(eq(externalResourceAcl.resourceId, resourceId)),
      );
      expect((await chunksVisibleTo(reader)).map((c) => c.id)).not.toContain(chunkId);

      // Revoking the connection stops it too, with the grant back in place.
      await withTenantTx(database.db, service, async (tx) => {
        await tx.insert(externalResourceAcl).values({
          organizationId,
          resourceId,
          principalKind: 'user',
          principalExternalId: 'reader@example.invalid',
          access: 'read',
          membershipId: reader.membershipId,
        });
        await tx
          .update(connections)
          .set({ state: 'revoked' })
          .where(eq(connections.id, connectionId));
      });
      expect((await chunksVisibleTo(reader)).map((c) => c.id)).not.toContain(chunkId);
    });

    it('gives a transaction with no membership and no service type no document', async () => {
      const { chunkIds } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'organization' }],
        passages: ['Not for an anonymous transaction.'],
      });
      const rows = await database.db.transaction(
        { 'app.organization_id': ownerA.organizationId },
        (tx) => tx.select().from(knowledgeChunks),
      );
      expect(rows.map((c) => c.id)).not.toContain(chunkIds[0]);
    });

    it('gives a delegated context exactly the person it acts for', async () => {
      const { chunkIds } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'membership', membershipId: reader.membershipId }],
        passages: ['For the reader.'],
      });
      const asReader = await createDelegatedContext(
        database.db,
        ownerA.organizationId,
        reader.membershipId,
      );
      const asOutsider = await createDelegatedContext(
        database.db,
        ownerA.organizationId,
        outsider.membershipId,
      );
      expect((await chunksVisibleTo(asReader)).map((c) => c.id)).toContain(chunkIds[0]);
      expect((await chunksVisibleTo(asOutsider)).map((c) => c.id)).not.toContain(chunkIds[0]);
    });

    it('lets only a service context write a passage', async () => {
      const { documentId, sourceId } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'membership', membershipId: ownerA.membershipId }],
        passages: ['One.'],
      });
      await expect(
        withTenantTx(database.db, ownerA, (tx) =>
          tx.insert(knowledgeChunks).values({
            organizationId: ownerA.organizationId,
            documentId,
            sourceId,
            ordinal: 1,
            textBody: 'Two.',
            contentSha256: sha256('Two.'),
            tokenEstimate: 1,
            charStart: 5,
            charEnd: 9,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('grants', () => {
    const newSource = (classification: 'internal' | 'confidential' | 'restricted') =>
      seedSearchableSource(database.db, ownerA, { classification, passages: ['Words.'] });

    it.each([
      ['confidential', 'organization'],
      ['restricted', 'organization'],
    ] as const)('refuses %s to %s', async (classification, principalKind) => {
      const { sourceId } = await newSource(classification);
      await expect(
        withTenantTx(database.db, ownerA, (tx) =>
          tx.insert(knowledgeSourceGrants).values({
            organizationId: ownerA.organizationId,
            sourceId,
            principalKind,
          }),
        ),
      ).rejects.toEqual(sqlState('EN105'));
    });

    it('refuses a source in another tenant, whatever its ID', async () => {
      const { sourceId } = await newSource('internal');
      await expect(
        withTenantTx(database.db, ownerB, (tx) =>
          tx.insert(knowledgeSourceGrants).values({
            organizationId: ownerB.organizationId,
            sourceId,
            principalKind: 'organization',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('a closed source', () => {
    it('never comes back, and its class never falls', async () => {
      const { sourceId } = await seedSearchableSource(database.db, ownerA, {
        classification: 'confidential',
        passages: ['Words.'],
      });
      await expect(
        withTenantTx(database.db, ownerA, (tx) =>
          tx
            .update(knowledgeSources)
            .set({ classification: 'internal' })
            .where(eq(knowledgeSources.id, sourceId)),
        ),
      ).rejects.toEqual(sqlState('EN102'));
      await withTenantTx(database.db, ownerA, (tx) =>
        tx
          .update(knowledgeSources)
          .set({ state: 'deleted' })
          .where(eq(knowledgeSources.id, sourceId)),
      );
      await expect(
        withTenantTx(database.db, ownerA, (tx) =>
          tx
            .update(knowledgeSources)
            .set({ state: 'active' })
            .where(eq(knowledgeSources.id, sourceId)),
        ),
      ).rejects.toEqual(sqlState('EN101'));
    });

    it('takes no more derived rows, so a worker that started earlier cannot undo a purge', async () => {
      const { sourceId, documentId } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'membership', membershipId: ownerA.membershipId }],
        passages: ['Words.'],
      });
      await withTenantTx(database.db, ownerA, (tx) =>
        tx
          .update(knowledgeSources)
          .set({ state: 'revoked' })
          .where(eq(knowledgeSources.id, sourceId)),
      );
      await expect(
        withTenantTx(database.db, createServiceContext(ownerA.organizationId), (tx) =>
          tx.insert(knowledgeChunks).values({
            organizationId: ownerA.organizationId,
            documentId,
            sourceId,
            ordinal: 9,
            textBody: 'Late.',
            contentSha256: sha256('Late.'),
            tokenEstimate: 1,
            charStart: 100,
            charEnd: 105,
          }),
        ),
      ).rejects.toEqual(sqlState('EN103'));
    });
  });

  describe('embedding spaces', () => {
    it('refuses a vector of the wrong size for its space (QA-017)', async () => {
      const { sourceId, chunkIds } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'membership', membershipId: ownerA.membershipId }],
        passages: ['Words.'],
      });
      const service = createServiceContext(ownerA.organizationId);
      const spaceId = randomUUID();
      await withTenantTx(database.db, service, (tx) =>
        tx.insert(knowledgeEmbeddingSpaces).values({
          organizationId: ownerA.organizationId,
          id: spaceId,
          modelId: `test-${spaceId}`,
          dimension: 3,
          vectorSpaceVersion: 'v1',
          state: 'retired',
        }),
      );
      const insert = (dimension: number, embedding: number[]) =>
        withTenantTx(database.db, service, (tx) =>
          tx.insert(knowledgeEmbeddings).values({
            organizationId: ownerA.organizationId,
            chunkId: chunkIds[0] as string,
            sourceId,
            spaceId,
            dimension,
            embedding,
            contentSha256: sha256('Words.'),
          }),
        );
      await expect(insert(3, [0.1, 0.2])).rejects.toThrow();
      await expect(insert(2, [0.1, 0.2])).rejects.toThrow();
      await insert(3, [0.1, 0.2, 0.3]);
    });
  });

  describe('the trust gate', () => {
    const proposeWithEvidence = async (proposer: TenantContext, origin: 'model' | 'person') => {
      const { chunkIds, sourceId } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'organization' }],
        passages: ['The client is called Example Limited.'],
      });
      const factId = randomUUID();
      await withTenantTx(database.db, proposer, async (tx) => {
        await tx.insert(knowledgeFacts).values({
          organizationId: ownerA.organizationId,
          id: factId,
          subjectRef: `knowledge_source:${sourceId}`,
          predicate: 'name.is',
          claim: { value: 'Example Limited' },
          origin,
          classification: 'internal',
          proposedByMembershipId: origin === 'person' ? proposer.membershipId : null,
        });
        await tx.insert(knowledgeFactEvidence).values({
          organizationId: ownerA.organizationId,
          factId,
          chunkId: chunkIds[0] as string,
          sourceId,
          contentSha256: sha256('The client is called Example Limited.'),
          quoteStart: 0,
          quoteEnd: 10,
        });
      });
      return factId;
    };

    const verifyAs = (context: TenantContext, factId: string) =>
      withTenantTx(database.db, context, (tx) =>
        tx
          .update(knowledgeFacts)
          .set({
            trustState: 'verified',
            reviewedByMembershipId: context.membershipId || null,
            reviewedAt: new Date(),
            reviewReason: 'Checked.',
          })
          .where(eq(knowledgeFacts.id, factId)),
      );

    it('stores no claim with nothing behind it', async () => {
      await expect(
        withTenantTx(database.db, reader, (tx) =>
          tx.insert(knowledgeFacts).values({
            organizationId: reader.organizationId,
            subjectRef: `client:${randomUUID()}`,
            predicate: 'name.is',
            claim: { value: 'A guess' },
            origin: 'person',
            classification: 'internal',
            proposedByMembershipId: reader.membershipId,
          }),
        ),
      ).rejects.toEqual(sqlState('EN110'));
    });

    it('refuses evidence that does not match the passage, so a citation cannot be invented', async () => {
      const { chunkIds, sourceId } = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'organization' }],
        passages: ['Short.'],
      });
      await expect(
        withTenantTx(database.db, reader, async (tx) => {
          const factId = randomUUID();
          await tx.insert(knowledgeFacts).values({
            organizationId: reader.organizationId,
            id: factId,
            subjectRef: `knowledge_source:${sourceId}`,
            predicate: 'name.is',
            claim: { value: 'x' },
            origin: 'person',
            classification: 'internal',
            proposedByMembershipId: reader.membershipId,
          });
          await tx.insert(knowledgeFactEvidence).values({
            organizationId: reader.organizationId,
            factId,
            chunkId: chunkIds[0] as string,
            sourceId,
            contentSha256: sha256('Not what it says.'),
            quoteStart: 0,
            quoteEnd: 3,
          });
        }),
      ).rejects.toEqual(sqlState('EN111'));
    });

    it('lets a person verify a model proposal, and nothing else can', async () => {
      const factId = await proposeWithEvidence(
        createServiceContext(ownerA.organizationId),
        'model',
      );
      const service = createServiceContext(ownerA.organizationId);
      const delegated = await createDelegatedContext(
        database.db,
        ownerA.organizationId,
        reader.membershipId,
      );
      await expect(verifyAs(service, factId)).rejects.toEqual(sqlState('EN109'));
      await expect(verifyAs(delegated, factId)).rejects.toEqual(sqlState('EN109'));
      await verifyAs(reader, factId);
      const [fact] = await withTenantTx(database.db, reader, (tx) =>
        tx.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, factId)),
      );
      expect(fact?.trustState).toBe('verified');
    });

    it('refuses the proposer verifying their own', async () => {
      const factId = await proposeWithEvidence(reader, 'person');
      await expect(verifyAs(reader, factId)).rejects.toEqual(sqlState('EN109'));
    });

    it('hides a fact from anyone who cannot read all its evidence', async () => {
      const open = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'organization' }],
        passages: ['Open.'],
      });
      const closed = await seedSearchableSource(database.db, ownerA, {
        grants: [{ kind: 'membership', membershipId: ownerA.membershipId }],
        passages: ['Closed.'],
      });
      const factId = randomUUID();
      await withTenantTx(database.db, ownerA, async (tx) => {
        await tx.insert(knowledgeFacts).values({
          organizationId: ownerA.organizationId,
          id: factId,
          subjectRef: `knowledge_source:${open.sourceId}`,
          predicate: 'name.is',
          claim: { value: 'Both' },
          origin: 'person',
          classification: 'internal',
          proposedByMembershipId: ownerA.membershipId,
        });
        await tx.insert(knowledgeFactEvidence).values([
          {
            organizationId: ownerA.organizationId,
            factId,
            chunkId: open.chunkIds[0] as string,
            sourceId: open.sourceId,
            contentSha256: sha256('Open.'),
            quoteStart: 0,
            quoteEnd: 2,
          },
          {
            organizationId: ownerA.organizationId,
            factId,
            chunkId: closed.chunkIds[0] as string,
            sourceId: closed.sourceId,
            contentSha256: sha256('Closed.'),
            quoteStart: 0,
            quoteEnd: 2,
          },
        ]);
      });
      const seen = await withTenantTx(database.db, reader, (tx) =>
        tx.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, factId)),
      );
      expect(seen).toHaveLength(0);
    });
  });

  describe('MCP tools', () => {
    it('starts unreviewed, and a changed definition loses its approval', async () => {
      const connectionId = randomUUID();
      const toolId = randomUUID();
      const { organizationId } = ownerA;
      await withTenantTx(database.db, ownerA, async (tx) => {
        await tx.insert(connections).values({
          organizationId,
          id: connectionId,
          connectorType: 'mcp_server',
          displayName: 'A test server',
        });
        await tx.insert(mcpTools).values({
          organizationId,
          id: toolId,
          connectionId,
          toolName: 'look_up',
          definition: { description: 'Trust me, I can do anything.' },
          definitionSha256: sha256('one'),
        });
      });
      const approve = (context: TenantContext) =>
        withTenantTx(database.db, context, (tx) =>
          tx
            .update(mcpTools)
            .set({
              status: 'approved',
              sideEffectLevel: 'read_only',
              allowedClasses: ['internal'],
              reviewedByMembershipId: context.membershipId || null,
              reviewedAt: new Date(),
            })
            .where(eq(mcpTools.id, toolId)),
        );
      await expect(approve(createServiceContext(organizationId))).rejects.toEqual(
        sqlState('EN116'),
      );
      await approve(ownerA);
      await withTenantTx(database.db, createServiceContext(organizationId), (tx) =>
        tx
          .update(mcpTools)
          .set({ definition: { description: 'Changed.' }, definitionSha256: sha256('two') })
          .where(eq(mcpTools.id, toolId)),
      );
      const [tool] = await withTenantTx(database.db, ownerA, (tx) =>
        tx.select().from(mcpTools).where(eq(mcpTools.id, toolId)),
      );
      expect(tool?.status).toBe('pending_review');
      expect(tool?.sideEffectLevel).toBeNull();
      expect(tool?.reviewedByMembershipId).toBeNull();
    });
  });

  describe('the rules in code and in SQL', () => {
    const body = (name: string) =>
      superuser
        .query(
          `select pg_get_functiondef(p.oid) as def from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'knowledge' and p.proname = $1`,
          [name],
        )
        .then(({ rows }) => String(rows[0]?.def));

    it('agree on a document lifecycle', async () => {
      const def = await body('check_document_change');
      for (const [from, to] of Object.entries(DOCUMENT_TRANSITIONS)) {
        if (to.length === 0) continue;
        expect(def).toContain(`WHEN '${from}'`);
        for (const next of to) expect(def).toMatch(new RegExp(`WHEN '${from}'.*'${next}'`));
      }
    });

    it('agree on a fact lifecycle', async () => {
      const def = await body('check_fact_change');
      for (const [from, to] of Object.entries(FACT_TRANSITIONS)) {
        if (to.length === 0) continue;
        for (const next of to) expect(def).toMatch(new RegExp(`WHEN '${from}'.*'${next}'`));
      }
    });

    it.each([
      ['public', false, false],
      ['internal', false, false],
      ['confidential', false, false],
      ['restricted', false, false],
      ['restricted', true, false],
    ] as const)('agree on who reads %s work', async (classification, isOwner, isAssigned) => {
      const ownerId = isOwner ? reader.membershipId : ownerA.membershipId;
      const id = randomUUID();
      await withTenantTx(database.db, ownerA, (tx) =>
        tx.execute(
          sql`insert into work.work_units (organization_id, id, owner_membership_id, title, classification)
              values (${ownerA.organizationId}, ${id}, ${ownerId}, 'A title', ${classification})`,
        ),
      );
      const [row] = await withTenantTx(database.db, reader, (tx) =>
        tx.execute(
          sql`select knowledge.can_read_work(${id}, ${reader.membershipId}::uuid) as allowed`,
        ),
      ).then((result) => result.rows as { allowed: boolean }[]);
      expect(row?.allowed).toBe(
        canReadWork(
          { classification, ownerMembershipId: ownerId, isAssigned },
          { membershipId: reader.membershipId, role: reader.role },
        ),
      );
    });
  });
});
