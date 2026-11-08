// ADR-030's database rules on their own: forced RLS, what each role can reach, and the triggers. Real
// PostgreSQL, real roles. The slices test behaviour on top of this, and each writes its own file.
//
// Needs migrations 0300 and 0301 in the journal, which the final merge stitches. Until then this cannot pass.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  licenseRecords,
  openAppDatabase,
  organizationExportParts,
  organizationExports,
  organizationImports,
  signedDocuments,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { eq } from 'drizzle-orm';
import {
  beginExport,
  runOrganizationImport,
  SOURCE_PORTABILITY_SECTIONS,
} from '@ensemus/application';
import { createServiceContext } from '@ensemus/database/service';
import {
  nativeSovereignContext,
  seedExportRow,
  seedImportRow,
  seedLicenseRow,
  sha256Hex,
  testKeyring,
  testRecipient,
} from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { buildArchive } from './fixtures/archive-builder';

const client = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

describe('sovereign rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let su: pg.Client;
  let ctxA: TenantContext;
  let ctxB: TenantContext;
  const { key } = testKeyring();
  const recipient = testRecipient();

  const makeOwner = async (label: string) => {
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      label,
      `${label}-${userId}@example.invalid`,
    ]);
    const { organizationId } = await createOrganization(database.db, {
      userId,
      name: 'Same Name Ltd',
      commercialMode: 'sovereign',
    });
    return nativeSovereignContext(database.db, userId, organizationId);
  };

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = await client(urls.auth());
    su = await client(urls.superuser());
    ctxA = await makeOwner('alice');
    ctxB = await makeOwner('bob');
  });

  afterAll(async () => {
    await database.close();
    await auth.end();
    await su.end();
  });

  it('forces RLS on every table in the schema, including future ones', async () => {
    const { rows } = await su.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p') and n.nspname = 'sovereign'
          and not (c.relrowsecurity and c.relforcerowsecurity)`,
    );
    expect(rows).toEqual([]);
  });

  it('gives the schema to the application role and nobody else', async () => {
    for (const url of [urls.dispatcher(), urls.auth()]) {
      const other = await client(url);
      await expect(other.query('select * from sovereign.license_records')).rejects.toThrow(
        /permission denied/,
      );
      await other.end();
    }
  });

  it('shows nothing with no tenant bound', async () => {
    await seedLicenseRow(database.db, ctxA, key);
    const rows = await database.db.run((tx) => tx.select().from(licenseRecords));
    expect(rows).toEqual([]);
  });

  it('keeps one tenant out of another, with the same names on both sides', async () => {
    const seeded = await seedLicenseRow(database.db, ctxA, key);
    const exportId = await seedExportRow(database.db, ctxA, recipient);
    const seen = await withTenantTx(database.db, ctxB, async (tx) => ({
      licenses: await tx.select().from(licenseRecords).where(eq(licenseRecords.id, seeded.id)),
      exports: await tx
        .select()
        .from(organizationExports)
        .where(eq(organizationExports.id, exportId)),
    }));
    expect(seen).toEqual({ licenses: [], exports: [] });
  });

  it('refuses writing a row into another tenant', async () => {
    await expect(
      withTenantTx(database.db, ctxB, (tx) =>
        tx.insert(signedDocuments).values({
          organizationId: ctxA.organizationId,
          documentType: 'advisory',
          documentId: 'TEST-1',
          keyIds: ['x'],
          envelope: '{}',
          envelopeSha256: sha256Hex('{}'),
          issuedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('never changes or removes a signed document, for anyone', async () => {
    const seeded = await seedLicenseRow(database.db, ctxA, key);
    await expect(
      withTenantTx(database.db, ctxA, (tx) =>
        tx.update(licenseRecords).set({ edition: 'other' }).where(eq(licenseRecords.id, seeded.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(database.db, ctxA, (tx) =>
        tx.delete(licenseRecords).where(eq(licenseRecords.id, seeded.id)),
      ),
    ).rejects.toThrow();
  });

  it('stores one file once', async () => {
    const seeded = await seedLicenseRow(database.db, ctxA, key);
    await expect(
      withTenantTx(database.db, ctxA, (tx) =>
        tx.insert(licenseRecords).values({
          organizationId: ctxA.organizationId,
          licenseId: seeded.licenseId,
          edition: 'sovereign',
          licensedVersion: '2.0.0',
          termKind: 'perpetual',
          keyIds: [key.keyId],
          envelope: seeded.envelope,
          envelopeSha256: sha256Hex(seeded.envelope),
          issuedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  describe('an export', () => {
    const move = (context: TenantContext, id: string, status: string, extra: object = {}) => {
      if (status === 'running')
        return beginExport(
          database.db,
          createServiceContext(context.organizationId),
          { exportId: id },
          {
            sections: SOURCE_PORTABILITY_SECTIONS,
            sourceRelease: 'generated-test',
            retentionHours: 1,
          },
        );
      return withTenantTx(database.db, context, (tx) =>
        tx
          .update(organizationExports)
          .set({ status, ...extra })
          .where(eq(organizationExports.id, id)),
      );
    };

    it('runs one at a time for a tenant', async () => {
      const context = await makeOwner('carol');
      await seedExportRow(database.db, context, recipient);
      await expect(seedExportRow(database.db, context, recipient)).rejects.toThrow();
    });

    it('cannot change who it is sealed for', async () => {
      const context = await makeOwner('dan');
      const id = await seedExportRow(database.db, context, recipient);
      const app = await client(urls.app());
      await expect(
        app.query(`update sovereign.organization_exports set recipient_public_key = 'x'`),
      ).rejects.toThrow(/permission denied/);
      await app.end();
      expect(id).toBeTruthy();
    });

    it('follows its statuses, and nothing goes back to ready', async () => {
      const context = await makeOwner('erin');
      const id = await seedExportRow(database.db, context, recipient);
      await expect(move(context, id, 'ready')).rejects.toThrow();
      await move(context, id, 'running');
      await expect(move(context, id, 'ready', { snapshotAt: new Date() })).rejects.toThrow();
      await move(context, id, 'ready', {
        snapshotAt: new Date(),
        manifestSealedSha256: sha256Hex('m'),
      });
      await move(context, id, 'expired');
      await expect(move(context, id, 'ready')).rejects.toThrow();
    });

    it('keeps its parts as written', async () => {
      const context = await makeOwner('frank');
      const id = await seedExportRow(database.db, context, recipient);
      const part = {
        organizationId: context.organizationId,
        exportId: id,
        path: 'work/work_units-000001.jsonl.sealed',
        section: 'work',
        recordCount: 1,
        plaintextSha256: sha256Hex('a'),
        sealedSha256: sha256Hex('b'),
        sealedBytes: 1,
        objectKey: 'x',
      };
      await withTenantTx(database.db, context, (tx) =>
        tx.insert(organizationExportParts).values(part),
      );
      await expect(
        withTenantTx(database.db, context, (tx) => tx.insert(organizationExportParts).values(part)),
      ).rejects.toThrow();
      await expect(
        withTenantTx(database.db, context, (tx) => tx.delete(organizationExportParts)),
      ).rejects.toThrow();
    });
  });

  describe('an import', () => {
    it('happens to an organization once, unless it failed', async () => {
      const context = await makeOwner('grace');
      const id = await seedImportRow(database.db, context);
      await expect(seedImportRow(database.db, context)).rejects.toThrow();
      await withTenantTx(database.db, context, (tx) =>
        tx
          .update(organizationImports)
          .set({ status: 'failed' })
          .where(eq(organizationImports.id, id)),
      );
      await expect(seedImportRow(database.db, context)).resolves.toBeTruthy();
    });

    it('cannot leave a finished status', async () => {
      const context = await makeOwner('heidi');
      const id = await seedImportRow(database.db, context);
      const move = (status: string) =>
        withTenantTx(database.db, createServiceContext(context.organizationId), (tx) =>
          tx.update(organizationImports).set({ status }).where(eq(organizationImports.id, id)),
        );
      await expect(move('completed')).rejects.toThrow();
      const recipient = testRecipient(),
        archive = buildArchive(recipient, { pages: [] });
      const result = await runOrganizationImport(
        database.db,
        createServiceContext(context.organizationId),
        { importId: id, archive: archive.reader, recipientPrivateKeyPem: recipient.privateKeyPem },
        {
          sections: SOURCE_PORTABILITY_SECTIONS,
          store: {
            put: async () => {},
            get: async () => {
              throw new Error('GENERATED_NO_BINARY_PART');
            },
            exists: async () => false,
            delete: async () => {},
          },
          ledger: {
            async *listPages() {
              yield [];
            },
            get: async () => Buffer.alloc(0),
          },
        },
      );
      expect(result).toMatchObject({ status: 'completed_with_warnings', failureCode: null });
      await expect(move('running')).rejects.toThrow();
    });
  });
});
