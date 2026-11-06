// QA-025: a real dump predating a deletion plus a real independent S3 ledger. This test must run
// serially on the disposable stack, like restore.test.ts. It has not been executed by the builder.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AppError, createRestoreGate, reapplyTombstoneLedger } from '@ensemus/application';
import { addUploadedSource, openDocumentBytes } from '@ensemus/application/knowledge/sources';
import { ingestDocument } from '@ensemus/application/knowledge/ingest';
import {
  deleteSource,
  purgeRunTranscriptsForSource,
  runSourcePurge,
} from '@ensemus/application/knowledge/purge';
import {
  createOrganization,
  knowledgeSources,
  openAppDatabase,
  resolveTenantContext,
  tombstones,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import {
  ledgerKeyFor,
  serializeLedgerEntry,
  type LedgerEntry,
} from '@ensemus/domain/tombstone-ledger';
import { parseDocument } from '@ensemus/knowledge/parsing';
import { S3ObjectStore } from '@ensemus/storage';
import { eq } from 'drizzle-orm';
import { compose, secret, urls } from '../helpers/stack';

describe('knowledge survives a real database restore as a closed source', () => {
  it('reapplies the external tombstone before restored bytes can be served', async () => {
    // This generated basename is the only container temporary artifact this test removes.
    const basename = `m5-knowledge-${randomUUID()}.dump`;
    if (!/^m5-knowledge-[0-9a-f-]{36}\.dump$/.test(basename))
      throw new Error('Unsafe generated dump name');
    const path = `/tmp/${basename}`;
    let database = openAppDatabase(urls.app());
    const auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const store = new S3ObjectStore({
      endpoint: 'http://127.0.0.1:58333',
      bucket: 'ensemus',
      accessKey: secret('objects_access_key'),
      secretKey: secret('objects_secret_key'),
    });
    let stopped = false;
    try {
      const userId = randomUUID();
      await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
        userId,
        'Generated restore owner',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Generated restored knowledge',
        commercialMode: 'sovereign',
      });
      let owner = await resolveTenantContext(database.db, userId, org.organizationId);
      const service = createServiceContext(org.organizationId);
      const source = await addUploadedSource(database.db, store, owner, {
        title: 'Generated removed source',
        mediaType: 'text/plain',
        body: Buffer.from('Generated deleted knowledge bytes.'),
        classification: 'internal',
        grants: [],
      });
      expect(
        await ingestDocument(
          database.db,
          store,
          service,
          {
            parse: async (body, type) => parseDocument(body, type),
            contentScan: { scan: () => ({ raiseTo: null, codes: [] }) },
          },
          { documentId: source.documentId },
        ),
      ).toMatchObject({ outcome: 'searchable' });
      compose(
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '-U',
        'postgres',
        '-d',
        'ensemus',
        '-Fc',
        '-f',
        path,
      );
      await deleteSource(database.db, owner, {
        sourceId: source.sourceId,
        expectedVersion: 1,
        reason: 'Generated deletion after backup',
      });
      const [mark] = await withTenantTx(database.db, service, (tx) =>
        tx.select().from(tombstones).where(eq(tombstones.targetId, source.sourceId)),
      );
      const entry: LedgerEntry = {
        organizationId: org.organizationId,
        targetType: 'knowledge_source',
        targetId: source.sourceId,
        deletedAt: mark!.createdAt,
      };
      // Explicit test-only M4 adapter: this source has no agent run or transcript, which is asserted by
      // the service's provenance query. The integrated M4 fence is exercised by its own acceptance gate.
      await purgeRunTranscriptsForSource(
        database.db,
        service,
        {
          transcripts: {
            fenceUsing: async (_tx, _context, { runIds }) => {
              expect(runIds).toEqual([]);
              return { fenced: true };
            },
            purgeUsing: async () => ({ removed: 0, remaining: 0 }),
          },
        },
        { sourceId: source.sourceId },
      );
      expect(
        (
          await runSourcePurge(
            database.db,
            store,
            service,
            { sourceId: source.sourceId },
            {
              derivedArtifacts: {
                purgeSource: async () => ({ removed: 0, remaining: 0, held: 0, confirmed: true }),
                confirmInTx: async () => ({ remaining: 0 }),
              },
            },
          )
        ).state,
      ).toBe('completed');
      await store.put(ledgerKeyFor(entry), serializeLedgerEntry(entry), 'application/json');
      expect(await store.exists(knowledgeObjectKey(org.organizationId, source.documentId))).toBe(
        false,
      );
      await database.close();
      await auth.end();
      // Deliberately leave the first web replica running, as the operational restore test does.
      compose('stop', 'dispatcher', 'worker', 'web-2');
      stopped = true;
      compose(
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '-U',
        'postgres',
        '-d',
        'ensemus',
        '--clean',
        '--if-exists',
        '--single-transaction',
        '--exit-on-error',
        path,
      );
      compose('run', '--rm', '--no-deps', 'migrate');
      database = openAppDatabase(urls.app());
      owner = await resolveTenantContext(database.db, userId, org.organizationId);
      const [restored] = await withTenantTx(database.db, service, (tx) =>
        tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.sourceId)),
      );
      expect(restored?.state).toBe('active');
      await expect(
        createRestoreGate({ database: database.db, store }).assertServing(owner),
      ).rejects.toEqual(new AppError('RESTORE_PENDING'));
      const applied = await reapplyTombstoneLedger(database.db, store, createServiceContext);
      expect(applied.failed).toBe(0);
      expect(applied.tombstonesAdded).toBeGreaterThanOrEqual(1);
      const [closed] = await withTenantTx(database.db, service, (tx) =>
        tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.sourceId)),
      );
      expect(closed?.state).toBe('deleted');
      await expect(openDocumentBytes(database.db, store, owner, source.documentId)).rejects.toEqual(
        new AppError('NOT_FOUND'),
      );
      await expect(
        createRestoreGate({ database: database.db, store }).assertServing(owner),
      ).resolves.toBeUndefined();
    } finally {
      await database.close();
      await auth.end().catch(() => {});
      if (stopped) compose('start', 'dispatcher', 'worker', 'web', 'web-2');
      compose('exec', '-T', 'postgres', 'rm', '-f', path);
    }
  }, 300_000);
});
