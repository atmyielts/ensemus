// QA-025: a real dump predating a deletion plus a real independent S3 ledger. This test must run
// serially on the disposable stack, like restore.test.ts. It has not been executed by the builder.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AppError, createRestoreGate, reapplyTombstoneLedger } from '@ensemus/application';
import { addUploadedSource, openDocumentBytes } from '@ensemus/application/knowledge/sources';
import { ingestDocument } from '@ensemus/application/knowledge/ingest';
import { deleteSource } from '@ensemus/application/knowledge/purge';
import {
  createOrganization,
  knowledgeSources,
  openAppDatabase,
  resolveTenantContext,
  tombstones,
  withTenantTx,
} from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
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
import { runNativeKnowledgePurge } from '../helpers/knowledge-native';
import { compose, secret, urls } from '../helpers/stack';
import { withRawKnowledgeObjects } from '@ensemus/application/knowledge/raw-objects';

/** Only codes this product or PostgreSQL gave, joined, for an assertion message. */
function failureCodes(error: unknown): string {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code)) codes.push(code);
    if (typeof message === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(message)) codes.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return codes.length ? codes.join('/') : 'UNCODED';
}

describe('knowledge survives a real database restore as a closed source', () => {
  it('reapplies the external tombstone before restored bytes can be served', async () => {
    // This generated basename is the only container temporary artifact this test removes.
    const basename = `m5-knowledge-${randomUUID()}.dump`;
    if (!/^m5-knowledge-[0-9a-f-]{36}\.dump$/.test(basename))
      throw new Error('Unsafe generated dump name');
    const path = `/tmp/${basename}`;
    let database = openAppDatabase(urls.app());
    // 0515: transcript payload purge retains its hold barrier through
    // lifecycle.source_payload_hold_free, which only the agent role may execute (the app role's
    // call was refused, so the purge reported TRANSCRIPT_PURGE_UNCONFIRMED). Production runs it in
    // the agent worker (createKnowledgeTranscriptActivities) on that role's database.
    const agent = openAgentDatabase(urls.agent());
    let agentOpen = true;
    const auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const transport = new S3ObjectStore({
      endpoint: 'http://127.0.0.1:58333',
      bucket: 'ensemus',
      accessKey: secret('objects_access_key'),
      secretKey: secret('objects_secret_key'),
    });
    // 0516: raw Knowledge bytes are written and purged only through the native raw port that the
    // web and worker runtimes install on their S3 store (withRawKnowledgeObjects); a bare store has
    // no such port and an upload is refused. The port is bound to the open database, so it is
    // installed again once the restored database is reopened.
    let store = withRawKnowledgeObjects({ database: database.db, store: transport });
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
      // The purge workflow in its production order: the agent worker's transcript and delegated-Work
      // activity on the agent role (0515 accepts that proof from no other role, and 0419 requires
      // the delegated-Work proof for completion), then the knowledge worker's purge with the
      // runtime's artifact/archive bindings over this real S3 store's native raw port. This source
      // had no agent run, so no transcript is removed.
      expect(
        await runNativeKnowledgePurge({
          app: database.db,
          agent: agent.db,
          store,
          organizationId: org.organizationId,
          sourceId: source.sourceId,
        }),
      ).toMatchObject({ state: 'completed', documents: 1, transcripts: 0 });
      await store.put(ledgerKeyFor(entry), serializeLedgerEntry(entry), 'application/json');
      expect(await store.exists(knowledgeObjectKey(org.organizationId, source.documentId))).toBe(
        false,
      );
      await database.close();
      await agent.close();
      agentOpen = false;
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
      store = withRawKnowledgeObjects({ database: database.db, store: transport });
      owner = await resolveTenantContext(database.db, userId, org.organizationId);
      const [restored] = await withTenantTx(database.db, service, (tx) =>
        tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.sourceId)),
      );
      expect(restored?.state).toBe('active');
      await expect(
        createRestoreGate({ database: database.db, store }).assertServing(owner),
      ).rejects.toEqual(new AppError('RESTORE_PENDING'));
      // The ledger is the stack's own and holds every earlier suite's deletions too, so a failure is
      // named by its codes (never a key or a name) and the next run says which entry kind failed.
      const failures: string[] = [];
      const applied = await reapplyTombstoneLedger(
        database.db,
        store,
        createServiceContext,
        (error) => failures.push(failureCodes(error)),
      );
      expect(applied.failed, failures.join('; ')).toBe(0);
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
      if (agentOpen) await agent.close();
      await auth.end().catch(() => {});
      if (stopped) compose('start', 'dispatcher', 'worker', 'web', 'web-2');
      compose('exec', '-T', 'postgres', 'rm', '-f', path);
    }
  }, 300_000);
});
