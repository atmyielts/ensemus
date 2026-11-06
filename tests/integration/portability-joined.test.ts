// Source-authored real-role checks. Requires joined M3/M4/M5 +0302; not a passing migration claim.
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  listImportedDefinitions,
  quarantinePortableRecord,
  createRestoreContributors,
  createImportedDefinitionPurge,
  createInvitation,
  acceptInvitation,
  requestOrganizationImport,
  runOrganizationImport,
  SOURCE_PORTABILITY_SECTIONS,
  createWorkUnit,
  beginExport,
  isExportEpochCurrent,
  requestOrganizationExport,
  exportNextBatch,
  finishExport,
  openExportArchive,
} from '@ensemus/application';
import { sql } from 'drizzle-orm';
import { seedImportRow, testRecipient } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { buildArchive } from './fixtures/archive-builder';
import { PORTABILITY_INVENTORY, PORTABILITY_INVENTORY_VERSION } from '@ensemus/domain/portability';

describe('joined portable definitions and restore audits', () => {
  let app: ReturnType<typeof openAppDatabase>, auth: pg.Client;
  const owner = async () => {
    const user = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
      user,
      'Same Name',
      `${user}@example.invalid`,
    ]);
    const created = await createOrganization(app.db, {
      userId: user,
      name: 'Same Name',
      commercialMode: 'sovereign',
    });
    return resolveTenantContext(app.db, user, created.organizationId);
  };
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });
  afterAll(async () => {
    await app.close();
    await auth.end();
  });
  const seed = async (context: TenantContext) => {
    const importId = await seedImportRow(app.db, context, { status: 'running' });
    const id = randomUUID();
    const record = {
      kind: 'agent_definition' as const,
      id,
      slug: 'imported-agent',
      name: 'Imported agent',
      owner_membership_id: context.membershipId,
      service_identity_id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    const scope = {
      importId,
      membershipFor: () => context.membershipId,
      isTombstoned: () => false,
    };
    await withTenantTx(app.db, createServiceContext(context.organizationId), (tx) =>
      quarantinePortableRecord(tx, createServiceContext(context.organizationId), scope, record),
    );
    return { record, scope };
  };
  it('retains review material while another tenant and ordinary member see no definitions', async () => {
    const a = await owner(),
      b = await owner();
    await seed(a);
    expect(await listImportedDefinitions(app.db, a)).toHaveLength(1);
    expect(await listImportedDefinitions(app.db, b)).toHaveLength(0);
    const user = randomUUID(),
      email = `${user}@example.invalid`;
    await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
      user,
      'Same Name',
      email,
    ]);
    const invitation = await createInvitation(app.db, a, { email, role: 'member' });
    await acceptInvitation(app.db, {
      userId: user,
      email,
      emailVerified: true,
      token: invitation.token,
    });
    const member = await resolveTenantContext(app.db, user, a.organizationId);
    await expect(listImportedDefinitions(app.db, member)).rejects.toThrow();
    const raw = await withTenantTx(app.db, member, (tx) =>
      tx.execute(sql`select record from sovereign.imported_definitions`),
    );
    expect(raw.rows).toHaveLength(0);
  });
  it('denies direct human insertion, cross-tenant binding and immutable rewrites', async () => {
    const a = await owner(),
      b = await owner();
    const { record, scope } = await seed(a);
    await expect(
      withTenantTx(app.db, a, (tx) =>
        quarantinePortableRecord(tx, a, scope, { ...record, id: randomUUID() }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(app.db, createServiceContext(b.organizationId), (tx) =>
        quarantinePortableRecord(tx, createServiceContext(b.organizationId), scope, {
          ...record,
          id: randomUUID(),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(app.db, createServiceContext(a.organizationId), (tx) =>
        tx.execute(sql`update sovereign.imported_definitions set record='{}'::jsonb`),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(app.db, createServiceContext(a.organizationId), (tx) =>
        tx.execute(sql`delete from sovereign.imported_definitions`),
      ),
    ).rejects.toThrow();
  });
  it('fails strict secret fields and does not manufacture a live agent definition', async () => {
    const a = await owner();
    const { record, scope } = await seed(a);
    await expect(
      withTenantTx(app.db, createServiceContext(a.organizationId), (tx) =>
        quarantinePortableRecord(tx, createServiceContext(a.organizationId), scope, {
          ...record,
          id: randomUUID(),
          secret_ref: randomUUID(),
        } as typeof record),
      ),
    ).rejects.toThrow();
    const live = await withTenantTx(app.db, createServiceContext(a.organizationId), (tx) =>
      tx.execute(sql`select id from ai.agent_definitions where id=${record.id}::uuid`),
    );
    expect(live.rows).toHaveLength(0);
  });
  it('keeps an otherwise empty restored tenant nonqualifying until actual recovery owners bind', async () => {
    const a = await owner();
    const service = createServiceContext(a.organizationId);
    for (const contributor of createRestoreContributors()) {
      expect((await contributor.reconcile(app.db, service)).needsAttention).toBeGreaterThan(0);
    }
  });
  it('closes source-bound inspection and proves actual PG-copy erasure without a serving bypass', async () => {
    const a = await owner(),
      sourceId = randomUUID();
    const service = createServiceContext(a.organizationId);
    const importId = await seedImportRow(app.db, a, { status: 'running' });
    await withTenantTx(app.db, service, async (tx) => {
      await tx.execute(sql`insert into knowledge.sources(organization_id,id,kind,classification,owner_membership_id)
        values(${a.organizationId}::uuid,${sourceId}::uuid,'upload','internal',${a.membershipId}::uuid)`);
      await tx.execute(sql`insert into knowledge.source_grants(organization_id,source_id,principal_kind,membership_id,granted_by_membership_id)
        values(${a.organizationId}::uuid,${sourceId}::uuid,'membership',${a.membershipId}::uuid,${a.membershipId}::uuid)`);
      await quarantinePortableRecord(
        tx,
        service,
        { importId, membershipFor: () => a.membershipId, isTombstoned: () => false },
        {
          kind: 'knowledge_source',
          id: sourceId,
          created_at: new Date().toISOString(),
          source_kind: 'upload',
          classification: 'internal',
          connection_id: null,
          external_resource_id: null,
          owner_membership_id: a.membershipId,
        },
      );
    });
    expect(await listImportedDefinitions(app.db, a)).toHaveLength(1);
    const eraser = createImportedDefinitionPurge(app.db);
    await expect(
      eraser.purge(service, { kind: 'knowledge_source', id: sourceId }),
    ).rejects.toThrow();
    await withTenantTx(app.db, service, (tx) =>
      tx.execute(sql`update knowledge.sources set state='deleted',version=version+1,
      revoked_at=now(),updated_at=now() where id=${sourceId}::uuid`),
    );
    expect(await listImportedDefinitions(app.db, a)).toHaveLength(0);
    expect(
      await withTenantTx(app.db, service, (tx) =>
        eraser.confirmInTx(tx, service, { kind: 'knowledge_source', id: sourceId }),
      ),
    ).toEqual({ remaining: 1 });
    expect(await eraser.purge(service, { kind: 'knowledge_source', id: sourceId })).toEqual({
      removed: 1,
      remaining: 0,
      confirmed: true,
    });
  });
  it.each([false, true])(
    'imports actual upload originals or retains an unknown writer on put failure (%s)',
    async (fault) => {
      const a = await owner(),
        service = createServiceContext(a.organizationId),
        recipient = testRecipient();
      const sourceId = randomUUID(),
        documentId = randomUUID(),
        at = new Date().toISOString();
      const body = Buffer.from('An original company document, not a private transcript.');
      const hash = createHash('sha256').update(body).digest('hex');
      const archive = buildArchive(
        recipient,
        {
          pages: [
            {
              section: 'knowledge',
              recordKind: 'knowledge_source',
              records: [
                {
                  kind: 'knowledge_source',
                  id: sourceId,
                  created_at: at,
                  source_kind: 'upload',
                  classification: 'internal',
                  connection_id: null,
                  external_resource_id: null,
                  owner_membership_id: a.membershipId,
                },
              ],
            },
            {
              section: 'knowledge',
              recordKind: 'knowledge_document',
              records: [
                {
                  kind: 'knowledge_document',
                  id: documentId,
                  created_at: at,
                  source_id: sourceId,
                  version_no: 1,
                  title: 'Original upload',
                  content_sha256: hash,
                  size_bytes: body.length,
                  media_type: 'text/plain',
                  classification: 'internal',
                  source_version: null,
                  superseded_at: null,
                },
              ],
            },
          ],
          knowledgeFiles: { [documentId]: body },
        },
        ({ manifest }) => ({
          manifest: {
            ...manifest,
            schema_version: 2,
            inventory_version: PORTABILITY_INVENTORY_VERSION,
            inventory: PORTABILITY_INVENTORY,
            generated_bodies_excluded: 0,
          },
        }),
      );
      const objects = new Map<string, Buffer>();
      let puts = 0;
      const store = {
        put: async (key: string, bytes: Buffer) => {
          puts += 1;
          if (fault) throw new Error('test store failure');
          objects.set(key, bytes);
        },
        get: async (key: string) => {
          const bytes = objects.get(key);
          if (!bytes) throw new Error('test missing');
          return bytes;
        },
        delete: async (key: string) => {
          objects.delete(key);
        },
        exists: async (key: string) => objects.has(key),
        async *listPages() {
          yield [] as string[];
        },
      };
      const requested = await requestOrganizationImport(app.db, a);
      const run = () =>
        runOrganizationImport(
          app.db,
          service,
          {
            importId: requested.id,
            archive: archive.reader,
            recipientPrivateKeyPem: recipient.privateKeyPem,
          },
          { store, ledger: store, sections: SOURCE_PORTABILITY_SECTIONS },
        );
      const result = await run();
      const actual = await withTenantTx(app.db, service, (tx) =>
        tx.execute<{ state: string; writer_state: string; content_sha256: string }>(sql`
      select d.state,w.state as writer_state,d.content_sha256 from knowledge.documents d join knowledge.object_writers w
      on w.organization_id=d.organization_id and w.document_id=d.id where d.id=${documentId}::uuid`),
      );
      expect(actual.rows[0]).toMatchObject({
        state: 'received',
        writer_state: fault ? 'active' : 'settled',
        content_sha256: hash,
      });
      if (fault) {
        expect(result).toMatchObject({ status: 'failed', failureCode: 'STORE_UNAVAILABLE' });
        expect(await run()).toMatchObject({ status: 'failed', failureCode: 'RECORD_REFUSED' });
        expect(puts).toBe(1);
      } else {
        expect(result.status).toBe('completed_with_warnings');
        expect(objects.get(`${a.organizationId}/knowledge/${documentId}`)).toEqual(body);
        expect(result.warningCounts.SOURCE_REQUIRES_REINGEST).toBeGreaterThan(0);
      }
    },
  );
  it('pins the actual epoch once, excludes routine Work progress and closes on class changes', async () => {
    const a = await owner(),
      b = await owner(),
      service = createServiceContext(a.organizationId),
      recipient = testRecipient();
    const work = await createWorkUnit(app.db, a, {
      title: 'Epoch Work',
      objective: 'Check export revocation safely.',
    });
    const read = () =>
      withTenantTx(app.db, a, (tx) =>
        tx.execute<{ epoch: string }>(
          sql`select epoch::text as epoch from sovereign.export_epochs`,
        ),
      );
    const before = (await read()).rows[0]?.epoch;
    if (!before) throw new Error('Missing epoch seed');
    await expect(
      withTenantTx(app.db, a, (tx) =>
        tx.execute(sql`update sovereign.export_epochs set epoch=epoch+1`),
      ),
    ).rejects.toThrow();
    expect(
      (
        await withTenantTx(app.db, b, (tx) =>
          tx.execute(
            sql`select epoch from sovereign.export_epochs where organization_id=${a.organizationId}::uuid`,
          ),
        )
      ).rows,
    ).toHaveLength(0);
    const exportId = (
      await requestOrganizationExport(app.db, a, {
        recipientPublicKey: recipient.publicKeyBase64,
        sourceRelease: 'test-only',
      })
    ).id;
    const deps = {
      sections: SOURCE_PORTABILITY_SECTIONS,
      sourceRelease: 'test-only',
      retentionHours: 1,
    };
    await beginExport(app.db, service, { exportId }, deps);
    expect(
      await withTenantTx(app.db, service, (tx) => isExportEpochCurrent(tx, service, exportId)),
    ).toBe(true);
    await withTenantTx(app.db, service, (tx) =>
      tx.execute(
        sql`update work.work_units set status='ready',version=version+1,updated_at=now() where id=${work.id}::uuid`,
      ),
    );
    expect((await read()).rows[0]?.epoch).toBe(before);
    await withTenantTx(app.db, service, (tx) =>
      tx.execute(
        sql`update work.work_units set classification='restricted',version=version+1,updated_at=now() where id=${work.id}::uuid`,
      ),
    );
    expect(
      await withTenantTx(app.db, service, (tx) => isExportEpochCurrent(tx, service, exportId)),
    ).toBe(false);
    await expect(
      withTenantTx(app.db, service, (tx) =>
        tx.execute(
          sql`update sovereign.organization_exports set export_epoch=(select epoch from sovereign.export_epochs where organization_id=${a.organizationId}::uuid) where id=${exportId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });
  it('rechecks revocation after an actual object read without holding locks across it', async () => {
    const a = await owner(),
      service = createServiceContext(a.organizationId),
      recipient = testRecipient();
    const work = await createWorkUnit(app.db, a, {
      title: 'Stream epoch',
      objective: 'Revoke during a bounded read.',
    });
    const objects = new Map<string, Buffer>();
    let revoke = false;
    const store = {
      put: async (key: string, bytes: Buffer) => {
        objects.set(key, bytes);
      },
      get: async (key: string) => {
        const bytes = objects.get(key);
        if (!bytes) throw new Error('test missing');
        if (revoke) {
          revoke = false;
          await withTenantTx(app.db, service, async (tx) => {
            await tx.execute(sql`set local statement_timeout='5s'`);
            await tx.execute(sql`update work.work_units set classification='restricted',version=version+1,updated_at=now()
            where id=${work.id}::uuid`);
          });
        }
        return bytes;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
      exists: async (key: string) => objects.has(key),
    };
    const exportId = (
      await requestOrganizationExport(app.db, a, {
        recipientPublicKey: recipient.publicKeyBase64,
        sourceRelease: 'test-only',
      })
    ).id;
    const deps = {
      sections: SOURCE_PORTABILITY_SECTIONS,
      sourceRelease: 'test-only',
      retentionHours: 1,
    };
    let step = await beginExport(app.db, service, { exportId }, deps);
    while (step.state === 'continue')
      step = await exportNextBatch(app.db, store, service, { exportId }, deps);
    expect(step.state).toBe('finished');
    step = await finishExport(app.db, store, service, { exportId }, deps);
    while (step.state === 'continue')
      step = await finishExport(app.db, store, service, { exportId }, deps);
    expect(step.state).toBe('finished');
    const download = await openExportArchive(app.db, store, a, exportId);
    revoke = true;
    await expect(download.chunks[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'EXPORT_SUPERSEDED',
    });
  });
});
