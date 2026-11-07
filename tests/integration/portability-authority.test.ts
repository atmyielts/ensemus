// Authored real-role gates for0408/0409. Requires the joined journal through0412; unrun until root
// composes that schema. Generated sessions/keys/data only; no hosted provider or production claim.
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createOrganization,
  openAppDatabase,
  withTenantTx,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  requestOrganizationImport,
  runOrganizationImport,
  SOURCE_PORTABILITY_SECTIONS,
  requestOrganizationExport,
  beginExport,
} from '@ensemus/application';
import { withPortabilityScope } from '../../packages/application/src/portability-scope';
import { makePerson, nativePersonContext } from '../helpers/product';
import { testRecipient } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { buildArchive, jsonLines } from './fixtures/archive-builder';

const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const at = '2026-11-07T00:00:00.000Z';
const team = () => ({
  kind: 'team',
  id: randomUUID(),
  parent_id: null,
  name: 'Generated archive team',
  created_at: at,
});
describe('native admitted portability authority', () => {
  let app: ReturnType<typeof openAppDatabase>, control: pg.Client;
  const owner = async () => {
    const person = await makePerson('portable-owner'),
      created = await createOrganization(app.db, {
        userId: person.userId,
        name: 'Generated portability tenant',
        commercialMode: 'sovereign',
      });
    return {
      ...person,
      context: await nativePersonContext(app.db, person, created.organizationId),
    };
  };
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    control = new pg.Client({ connectionString: urls.superuser() });
    await control.connect();
  });
  afterAll(async () => {
    await app.close();
    await control.end();
  });
  const scoped = <T>(
    context: TenantContext,
    id: string,
    path: string,
    hash: string,
    run: (tx: Tx) => Promise<T>,
  ) =>
    withTenantTx(app.db, context, (tx) =>
      withPortabilityScope(
        tx,
        {
          'app.portability_import_id': id,
          'app.portability_part_path': path,
          'app.portability_part_sha256': hash,
        },
        run,
      ),
    );
  const prepared = async () => {
    const person = await owner(),
      view = await requestOrganizationImport(app.db, person.context),
      record = team(),
      recipient = testRecipient();
    const archive = buildArchive(recipient, {
        pages: [{ section: 'people', recordKind: 'team', records: [record] }],
      }),
      part = archive.manifest.parts[0]!;
    const context = createServiceContext(person.context.organizationId);
    await withTenantTx(app.db, context, (tx) =>
      tx.execute(
        sql`update sovereign.organization_imports set status='running' where id=${view.id}::uuid`,
      ),
    );
    await scoped(context, view.id, '', '', async (tx) => {
      await tx.execute(
        sql`select sovereign.register_import_manifest(${view.id}::uuid,${sha(archive.bytes)},${Buffer.from(JSON.stringify(archive.manifest))})`,
      );
      await tx.execute(
        sql`select sovereign.register_import_part(${view.id}::uuid,${part.path},${jsonLines([record])})`,
      );
      await tx.execute(sql`select sovereign.complete_import_verification(${view.id}::uuid)`);
    });
    return { person, view, record, archive, part, context };
  };
  const insertTeam = async (tx: Tx, record: ReturnType<typeof team>) =>
    tx.execute(sql`insert into org.teams(organization_id,id,name,created_at)
  values(app.current_organization_id(),${record.id}::uuid,${record.name},${record.created_at}::timestamptz)`);
  const prepare = async (tx: Tx, id: string, record: ReturnType<typeof team>) =>
    tx.execute(
      sql`select sovereign.prepare_import_effect(${id}::uuid,'team_insert',${JSON.stringify(record)}::jsonb)`,
    );

  it('runs the actual encrypted archive/parser/importer for bounded team and disabled-connection effects', async () => {
    const person = await owner(),
      view = await requestOrganizationImport(app.db, person.context),
      recipient = testRecipient(),
      record = team();
    const connection = {
      kind: 'connection',
      id: randomUUID(),
      connector_type: 'email_smtp',
      display_name: 'Generated disabled connector',
      granted_scopes: ['send'],
      created_at: at,
    };
    const archive = buildArchive(recipient, {
      pages: [
        { section: 'people', recordKind: 'team', records: [record] },
        { section: 'connections', recordKind: 'connection', records: [connection] },
      ],
    });
    const result = await runOrganizationImport(
      app.db,
      createServiceContext(person.context.organizationId),
      {
        importId: view.id,
        archive: archive.reader,
        recipientPrivateKeyPem: recipient.privateKeyPem,
      },
      {
        sections: SOURCE_PORTABILITY_SECTIONS,
        store: { put: async () => {}, delete: async () => {}, exists: async () => false },
        ledger: {
          async *listPages() {
            yield [];
          },
          get: async () => Buffer.alloc(0),
        },
      },
    );
    expect(result).toMatchObject({
      status: 'completed_with_warnings',
      failureCode: null,
      appliedCounts: { team: 1, connection: 1 },
    });
    const rows = await withTenantTx(app.db, person.context, (tx) =>
      tx.execute(
        sql`select state,credential_secret_id,granted_scopes,created_by_membership_id from integrations.connections where id=${connection.id}::uuid`,
      ),
    );
    expect(rows.rows).toEqual([
      {
        state: 'disabled',
        credential_secret_id: null,
        granted_scopes: [],
        created_by_membership_id: person.context.membershipId,
      },
    ]);
  });
  it('admits once from the actual native session and stores no live-session FK', async () => {
    const input = await prepared();
    const receipt = await withTenantTx(app.db, input.person.context, (tx) =>
      tx.execute(
        sql`select intent_authorized_session_id from sovereign.organization_imports where id=${input.view.id}::uuid`,
      ),
    );
    expect(receipt.rows[0]?.intent_authorized_session_id).toBe(input.person.sessionId);
    await control.query('delete from identity.sessions where id=$1', [input.person.sessionId]);
    await scoped(
      input.context,
      input.view.id,
      input.part.path,
      input.part.plaintext_sha256,
      async (tx) => {
        await prepare(tx, input.view.id, input.record);
        await insertTeam(tx, input.record);
      },
    );
  });
  it('refuses a service-created import admission', async () => {
    const p = await owner();
    await expect(
      withTenantTx(app.db, createServiceContext(p.context.organizationId), (tx) =>
        tx.execute(sql`insert into sovereign.organization_imports(organization_id,requested_by_membership_id,fallback_membership_id)
   values(${p.context.organizationId}::uuid,${p.context.membershipId}::uuid,${p.context.membershipId}::uuid)`),
      ),
    ).rejects.toThrow();
  });
  it('refuses caller-stamped admission even from a native owner', async () => {
    const p = await owner();
    await expect(
      withTenantTx(app.db, p.context, (tx) =>
        tx.execute(sql`insert into sovereign.organization_imports(organization_id,requested_by_membership_id,fallback_membership_id,intent_authorized_at,intent_authorized_membership_id,intent_authorized_session_id)
   values(${p.context.organizationId}::uuid,${p.context.membershipId}::uuid,${p.context.membershipId}::uuid,clock_timestamp(),${p.context.membershipId}::uuid,${p.sessionId}::uuid)`),
      ),
    ).rejects.toThrow();
  });
  it('refuses an effect with forged scope but no actual admitted import', async () => {
    const p = await owner(),
      record = team();
    await expect(
      scoped(
        createServiceContext(p.context.organizationId),
        randomUUID(),
        'people/team-000001.jsonl.sealed',
        '0'.repeat(64),
        (tx) => insertTeam(tx, record),
      ),
    ).rejects.toThrow();
  });
  it('refuses foreign-tenant intent reuse', async () => {
    const input = await prepared(),
      other = await owner();
    await expect(
      scoped(
        createServiceContext(other.context.organizationId),
        input.view.id,
        input.part.path,
        input.part.plaintext_sha256,
        (tx) => prepare(tx, input.view.id, input.record),
      ),
    ).rejects.toThrow();
  });
  it('refuses a changed part selector or plaintext hash', async () => {
    const input = await prepared();
    for (const [path, hash] of [
      [input.part.path, '0'.repeat(64)],
      ['people/team-000002.jsonl.sealed', input.part.plaintext_sha256],
    ])
      await expect(
        scoped(input.context, input.view.id, path!, hash!, (tx) =>
          prepare(tx, input.view.id, input.record),
        ),
      ).rejects.toThrow();
  });
  it('refuses content not present in the byte-verified part', async () => {
    const input = await prepared();
    await expect(
      scoped(input.context, input.view.id, input.part.path, input.part.plaintext_sha256, (tx) =>
        prepare(tx, input.view.id, { ...input.record, name: 'Changed after verification' }),
      ),
    ).rejects.toThrow();
  });
  it('refuses changed effect fields after valid preparation', async () => {
    const input = await prepared();
    await expect(
      scoped(
        input.context,
        input.view.id,
        input.part.path,
        input.part.plaintext_sha256,
        async (tx) => {
          await prepare(tx, input.view.id, input.record);
          await insertTeam(tx, { ...input.record, name: 'Changed effect' });
        },
      ),
    ).rejects.toThrow();
  });
  it('consumes an exact effect once and rejects a second insertion', async () => {
    const input = await prepared();
    await scoped(
      input.context,
      input.view.id,
      input.part.path,
      input.part.plaintext_sha256,
      async (tx) => {
        await prepare(tx, input.view.id, input.record);
        await insertTeam(tx, input.record);
      },
    );
    await expect(
      scoped(input.context, input.view.id, input.part.path, input.part.plaintext_sha256, (tx) =>
        insertTeam(tx, input.record),
      ),
    ).rejects.toThrow();
  });
  it('admits at most one of two concurrent exact effect attempts across transactions', async () => {
    const input = await prepared(),
      attempt = () =>
        scoped(
          input.context,
          input.view.id,
          input.part.path,
          input.part.plaintext_sha256,
          async (tx) => {
            await prepare(tx, input.view.id, input.record);
            await insertTeam(tx, input.record);
          },
        );
    const outcomes = await Promise.allSettled([attempt(), attempt()]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });
  it('restores the receipt on rollback, then permits one real effect', async () => {
    const input = await prepared(),
      sentinel = new Error('GENERATED_ROLLBACK');
    await expect(
      scoped(
        input.context,
        input.view.id,
        input.part.path,
        input.part.plaintext_sha256,
        async (tx) => {
          await prepare(tx, input.view.id, input.record);
          await insertTeam(tx, input.record);
          throw sentinel;
        },
      ),
    ).rejects.toBe(sentinel);
    await scoped(
      input.context,
      input.view.id,
      input.part.path,
      input.part.plaintext_sha256,
      async (tx) => {
        await prepare(tx, input.view.id, input.record);
        await insertTeam(tx, input.record);
      },
    );
  });
  it('rechecks requesting/custodian membership at effect time', async () => {
    const input = await prepared();
    await control.query(
      "update org.memberships set status='disabled' where organization_id=$1 and id=$2",
      [input.person.context.organizationId, input.person.context.membershipId],
    );
    await expect(
      scoped(input.context, input.view.id, input.part.path, input.part.plaintext_sha256, (tx) =>
        prepare(tx, input.view.id, input.record),
      ),
    ).rejects.toThrow();
  });
  it('denies effect receipt table writes to the application role', async () => {
    const input = await prepared();
    await expect(
      withTenantTx(app.db, input.context, (tx) =>
        tx.execute(sql`update sovereign.organization_import_effects set created_target=true`),
      ),
    ).rejects.toThrow();
  });
  it('freezes source/archive/manifest pins after registration', async () => {
    const input = await prepared();
    await expect(
      scoped(input.context, input.view.id, '', '', (tx) =>
        tx.execute(
          sql`select sovereign.register_import_manifest(${input.view.id}::uuid,${'0'.repeat(64)},${Buffer.from(JSON.stringify(input.archive.manifest))})`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(app.db, input.context, (tx) =>
        tx.execute(
          sql`update sovereign.organization_imports set archive_sha256=${'0'.repeat(64)} where id=${input.view.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });
  it('restores nested selector bindings on success and through real savepoint rollback', async () => {
    const input = await prepared();
    await withTenantTx(app.db, input.context, async (tx) => {
      await withPortabilityScope(
        tx,
        { 'app.portability_import_id': input.view.id },
        async (outer) => {
          const read = async (t: Tx) =>
            (await t.execute(sql`select current_setting('app.portability_import_id',true) as id`))
              .rows[0]?.id;
          await withPortabilityScope(
            outer,
            { 'app.portability_import_id': randomUUID() },
            async (inner) => expect(await read(inner)).not.toBe(input.view.id),
          );
          expect(await read(outer)).toBe(input.view.id);
          await expect(
            withPortabilityScope(
              outer,
              { 'app.portability_import_id': randomUUID() },
              async (inner) => {
                await inner.execute(sql`select 1/0`);
              },
            ),
          ).rejects.toThrow();
          expect(await read(outer)).toBe(input.view.id);
        },
      );
    });
  });
  it('pins /3 only on an actual begun export and refuses a forged guessed export selector', async () => {
    const p = await owner(),
      recipient = testRecipient(),
      view = await requestOrganizationExport(app.db, p.context, {
        recipientPublicKey: recipient.publicKeyBase64,
        sourceRelease: 'generated-test',
      }),
      worker = createServiceContext(p.context.organizationId);
    await beginExport(
      app.db,
      worker,
      { exportId: view.id },
      { sections: SOURCE_PORTABILITY_SECTIONS, sourceRelease: 'generated-test', retentionHours: 1 },
    );
    const get = async (id: string) =>
      withTenantTx(app.db, worker, (tx) =>
        withPortabilityScope(
          tx,
          { 'app.portability_export_id': id },
          async (scoped) =>
            (await scoped.execute(sql`select sovereign.portable_export_viewer() as id`)).rows[0]
              ?.id,
        ),
      );
    expect(await get(view.id)).toBe(p.context.membershipId);
    expect(await get(randomUUID())).toBeNull();
  });
  it('refuses service-created export authority even when it names an active owner', async () => {
    const p = await owner(),
      recipient = testRecipient();
    await expect(
      withTenantTx(app.db, createServiceContext(p.context.organizationId), (tx) =>
        tx.execute(sql`insert into sovereign.organization_exports(organization_id,requested_by_membership_id,recipient_public_key,recipient_key_id,source_release)
   values(${p.context.organizationId}::uuid,${p.context.membershipId}::uuid,${recipient.publicKeyBase64},${recipient.keyId},'generated-test')`),
      ),
    ).rejects.toThrow();
  });
  it('projects a real pinned object only inside its admitted export and refuses after a class change', async () => {
    const p = await owner(),
      typeId = randomUUID(),
      recordId = randomUUID(),
      shapeHash = sha(Buffer.from('{"fields":[],"relations":[]}'));
    await withTenantTx(app.db, p.context, async (tx) => {
      await tx.execute(sql`insert into objects.types(organization_id,id,slug,display_name,created_by_membership_id)
    values(${p.context.organizationId}::uuid,${typeId}::uuid,${`sample_${typeId.replaceAll('-', '')}`},'Generated portable type',${p.context.membershipId}::uuid)`);
      await tx.execute(sql`insert into objects.type_versions(organization_id,type_id,version_number,fields,relations,schema_sha256,created_by_membership_id)
    values(${p.context.organizationId}::uuid,${typeId}::uuid,1,'[]','[]',${shapeHash},${p.context.membershipId}::uuid)`);
      await tx.execute(sql`insert into objects.records(organization_id,id,type_id,type_version_number,display_name,attributes,classification,owner_membership_id,created_by_membership_id)
    values(${p.context.organizationId}::uuid,${recordId}::uuid,${typeId}::uuid,1,'Generated object canary','{}','internal',${p.context.membershipId}::uuid,${p.context.membershipId}::uuid)`);
    });
    const recipient = testRecipient(),
      view = await requestOrganizationExport(app.db, p.context, {
        recipientPublicKey: recipient.publicKeyBase64,
        sourceRelease: 'generated-test',
      }),
      worker = createServiceContext(p.context.organizationId);
    await beginExport(
      app.db,
      worker,
      { exportId: view.id },
      { sections: SOURCE_PORTABILITY_SECTIONS, sourceRelease: 'generated-test', retentionHours: 1 },
    );
    const adapter = SOURCE_PORTABILITY_SECTIONS.find((s) => s.section === 'custom-objects')!;
    await expect(
      withTenantTx(app.db, worker, (tx) =>
        adapter.exportPage(tx, worker, { cursor: null, limit: 1 }),
      ),
    ).rejects.toThrow();
    let cursor: string | null = null,
      found: unknown;
    for (let page = 0; page < 12; page++) {
      const result = await withTenantTx(app.db, worker, (tx) =>
        withPortabilityScope(tx, { 'app.portability_export_id': view.id }, (scoped) =>
          adapter.exportPage(scoped, worker, { cursor, limit: 1 }),
        ),
      );
      if (result.recordKind === 'custom_object_record' && result.records.length) {
        found = result.records[0];
        break;
      }
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(found).toMatchObject({
      kind: 'custom_object_record',
      id: recordId,
      schema_sha256: shapeHash,
      fields: [],
      relations: [],
    });
    await withTenantTx(app.db, p.context, (tx) =>
      tx.execute(
        sql`update objects.records set classification='restricted',version=version+1 where id=${recordId}::uuid`,
      ),
    );
    await expect(
      withTenantTx(app.db, worker, (tx) =>
        withPortabilityScope(tx, { 'app.portability_export_id': view.id }, (scoped) =>
          adapter.exportPage(scoped, worker, { cursor: null, limit: 1 }),
        ),
      ),
    ).rejects.toThrow();
  });
  it('keeps a private draft outside service reads and gives export SELECT no write/delete authority', async () => {
    const p = await owner(),
      id = randomUUID(),
      answers = {
        role: 'Generated role',
        intendedOutcome: 'Generated outcome',
        boundaries: [],
        knowledgeSourceIds: [],
        toolIds: [],
        triggerKind: 'manual',
        maxCostMicros: null,
        maxTurns: 2,
        maxToolCalls: 0,
        maxTotalTokens: 1000,
        qualityTier: 'balanced',
        timeoutSeconds: 60,
        autonomy: 'suggest_only',
        memoryWrite: 'none',
        outputFormat: 'markdown_brief',
        dataClasses: ['internal'],
        ownerMembershipId: p.context.membershipId,
      };
    await withTenantTx(app.db, p.context, (tx) =>
      tx.execute(sql`insert into studio.agent_drafts(organization_id,id,name,owner_membership_id,classification,answers,created_by_membership_id)
   values(${p.context.organizationId}::uuid,${id}::uuid,'Generated private draft',${p.context.membershipId}::uuid,'internal',${JSON.stringify(answers)}::jsonb,${p.context.membershipId}::uuid)`),
    );
    const worker = createServiceContext(p.context.organizationId),
      recipient = testRecipient(),
      view = await requestOrganizationExport(app.db, p.context, {
        recipientPublicKey: recipient.publicKeyBase64,
        sourceRelease: 'generated-test',
      });
    await beginExport(
      app.db,
      worker,
      { exportId: view.id },
      { sections: SOURCE_PORTABILITY_SECTIONS, sourceRelease: 'generated-test', retentionHours: 1 },
    );
    expect(
      (
        await withTenantTx(app.db, worker, (tx) =>
          tx.execute(sql`select id from studio.agent_drafts where id=${id}::uuid`),
        )
      ).rows,
    ).toEqual([]);
    await withTenantTx(app.db, worker, (tx) =>
      withPortabilityScope(tx, { 'app.portability_export_id': view.id }, async (scoped) => {
        expect(
          (await scoped.execute(sql`select id from studio.agent_drafts where id=${id}::uuid`)).rows,
        ).toEqual([{ id }]);
        expect(
          (
            await scoped.execute(
              sql`delete from studio.agent_drafts where id=${id}::uuid returning id`,
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await scoped.execute(
              sql`update studio.agent_drafts set name='Forbidden service edit' where id=${id}::uuid returning id`,
            )
          ).rows,
        ).toEqual([]);
      }),
    );
    expect(
      (
        await withTenantTx(app.db, p.context, (tx) =>
          tx.execute(sql`select name from studio.agent_drafts where id=${id}::uuid`),
        )
      ).rows,
    ).toEqual([{ name: 'Generated private draft' }]);
  });
});
