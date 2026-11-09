// Restore debt requalification (0543, 0545, ADR-026) against real RLS and the real deletion authority.
// The material restore generation is rotated the way the native restore rotates it, which is global:
// this file runs serially, as the whole integration project does (fileParallelism: false). Storage is
// an explicit memory test double; nothing here qualifies a provider.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  AppError,
  createArchiveQuarantineRecovery,
  createImportedArchivePurge,
  createWorkUnit,
  reapplyTombstoneLedger,
  requalifyArchiveRestoreDebt,
  requalifyGeneratedRestoreDebt,
  requalifyRawRestoreOrganization,
  requalifyRawRestoreSource,
  requestExecution,
  requestOrganizationImport,
  runOrganizationImport,
  SOURCE_PORTABILITY_SECTIONS,
  transitionWorkUnit,
  type LedgerReader,
  type ObjectStore,
} from '@ensemus/application';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createDelegatedWorkPurge } from '@ensemus/application/knowledge/delegated-work-purge';
import { purgeRunTranscriptsForSource, revokeSource } from '@ensemus/application/knowledge/purge';
import { addUploadedSource, getSource } from '@ensemus/application/knowledge/sources';
import { withRawKnowledgeObjects } from '@ensemus/application/knowledge/raw-objects';
import { createObjectDeletionLifecycle } from '@ensemus/application/saas/object-deletion';
import {
  createOrganization,
  openAppDatabase,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import {
  ledgerKeyFor,
  ledgerRef,
  serializeLedgerEntry,
  type LedgerEntry,
} from '@ensemus/domain/tombstone-ledger';
import { createActivities } from '@ensemus/workflows/activities';
import { pgCode } from '../../packages/application/src/errors';
import { seedAiTenant } from '../helpers/ai/fixtures';
import { nativeKnowledgeStore, runNativeKnowledgePurge } from '../helpers/knowledge-native';
import { makePerson, nativePersonContext } from '../helpers/product';
import { testRecipient } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { buildArchive } from './fixtures/archive-builder';

/** A memory bucket with the single-attempt and physical-absence capabilities the runtime store has. */
class Bucket implements ObjectStore, LedgerReader {
  objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer, contentType?: string) {
    if (contentType === '') throw new Error('GENERATED_CONTENT_TYPE_REQUIRED');
    this.objects.set(key, Buffer.from(body));
  }
  async putSingleAttempt(key: string, body: Buffer): Promise<{ transport: 'written' }> {
    this.objects.set(key, Buffer.from(body));
    return { transport: 'written' };
  }
  async get(key: string, max?: number) {
    const bytes = this.objects.get(key);
    if (!bytes || (max !== undefined && bytes.length > max)) throw new Error('MISSING');
    return bytes;
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deleteForPurge(key: string): Promise<{ transport: 'deleted'; capabilityVerified: true }> {
    this.objects.delete(key);
    return { transport: 'deleted', capabilityVerified: true };
  }
  async isPhysicallyAbsent(key: string) {
    return !this.objects.has(key);
  }
  async *listPages(prefix: string) {
    yield [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }
}

const isCode = (code: string) => (error: unknown) => pgCode(error) === code;

describe('restore debt requalification (0543, 0545)', () => {
  let app: ReturnType<typeof openAppDatabase>,
    agent: ReturnType<typeof openAgentDatabase>,
    migrator: pg.Client,
    control: pg.Client;
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    agent = openAgentDatabase(urls.agent());
    migrator = new pg.Client({ connectionString: urls.migrator() });
    control = new pg.Client({ connectionString: urls.superuser() });
    await migrator.connect();
    await control.connect();
  });
  afterAll(async () => {
    await migrator?.end();
    await control?.end();
    await agent?.close();
    await app?.close();
  });

  const owed = async (context: TenantContext) =>
    (
      await withTenantTx(app.db, createServiceContext(context.organizationId), (tx) =>
        tx.execute<{ unconfirmed: number }>(
          sql`select unconfirmed from lifecycle.object_delete_counts()`,
        ),
      )
    ).rows[0]?.unconfirmed;
  const generation = async (context: TenantContext) =>
    (
      await withTenantTx(app.db, context, (tx) =>
        tx.execute<{ value: string | null }>(
          sql`select ai.current_material_restore_generation() value`,
        ),
      )
    ).rows[0]?.value;
  /** The native restore's material rotation, exactly as the 0515 gate test drives it. */
  const rotate = async () => {
    const prior = {
      'app.organization_id': randomUUID(),
      'app.actor_type': 'user',
      'app.membership_id': randomUUID(),
      'app.user_id': randomUUID(),
      'sovereign.material_restore_mode': 'previous',
      'sovereign.material_restore_org': randomUUID(),
      'sovereign.material_restore_generation': randomUUID(),
    };
    await migrator.query('begin');
    try {
      for (const [key, value] of Object.entries(prior))
        await migrator.query('select set_config($1,$2,true)', [key, value]);
      const rotation = await migrator.query<{ tenants: number }>(
        'select sovereign.rotate_material_restore_generation() tenants',
      );
      expect(rotation.rows[0]?.tenants).toBeGreaterThan(0);
      await migrator.query('commit');
    } catch (error) {
      await migrator.query('rollback');
      throw error;
    }
  };
  /** A row as an older database restored it: written without the runtime's triggers. */
  const asRestored = async <T extends pg.QueryResultRow>(statement: string, values: unknown[]) => {
    await control.query('begin');
    try {
      await control.query(`set local session_replication_role='replica'`);
      const result = await control.query<T>(statement, values);
      await control.query('commit');
      return result;
    } catch (error) {
      await control.query('rollback');
      throw error;
    }
  };

  describe('archive restore debt (0545)', () => {
    it('keeps a restored archive file owed until its deletion is proven, and only then', async () => {
      const person = await makePerson('archive-requalify');
      const { organizationId } = await createOrganization(app.db, {
        userId: person.userId,
        name: 'Generated archive requalification',
        commercialMode: 'sovereign',
      });
      const owner = await nativePersonContext(app.db, person, organizationId);
      const service = createServiceContext(organizationId);
      const bucket = new Bucket();
      const store = withRawKnowledgeObjects({ database: app.db, store: bucket });
      const recipient = testRecipient();
      const view = await requestOrganizationImport(app.db, owner);
      const sourceArtifactId = randomUUID();
      const bytes = Buffer.from('GENERATED archive bytes for restore requalification.');
      const archive = buildArchive(recipient, {
        pages: [
          {
            section: 'artifacts',
            recordKind: 'artifact',
            records: [
              {
                kind: 'artifact',
                id: sourceArtifactId,
                name: 'Generated restored.txt',
                mime_type: 'text/plain',
                size_bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                classification: 'internal',
                created_by_membership_id: randomUUID(),
                created_at: '2026-11-07T00:00:00.000Z',
              },
            ],
          },
        ],
        files: { [sourceArtifactId]: bytes },
      });
      await runOrganizationImport(
        app.db,
        service,
        {
          importId: view.id,
          archive: archive.reader,
          recipientPrivateKeyPem: recipient.privateKeyPem,
        },
        { sections: SOURCE_PORTABILITY_SECTIONS, store, ledger: store },
      );
      const header = async () =>
        (
          await control.query<{
            object_key: string;
            state: string;
            physical_purged_at: Date | null;
          }>(
            'select object_key,state,physical_purged_at from sovereign.imported_archive_files where organization_id=$1 and import_id=$2',
            [organizationId, view.id],
          )
        ).rows[0]!;
      const lifecycle = createObjectDeletionLifecycle({ database: app.db, store: bucket }).archive;
      const purge = () =>
        createImportedArchivePurge({ database: app.db, store, lifecycle })
          .purgeTenant(service, { limit: 25 })
          .then(
            () => undefined,
            () => undefined,
          );
      await purge();
      const key = (await header()).object_key;
      expect(await header()).toMatchObject({ state: 'purged' });
      expect(bucket.objects.has(key)).toBe(false);
      // The restored store still holds the bytes: the purge receipt is reopened, and 0508 records
      // archive restore debt, which no lifecycle could ever admit before 0545.
      bucket.objects.set(key, bytes);
      await createArchiveQuarantineRecovery(store).reconcile(app.db, service);
      expect(await header()).toMatchObject({ state: 'closing', physical_purged_at: null });
      expect(await owed(owner)).toBeGreaterThan(0);
      await purge();
      expect(await header()).toMatchObject({ state: 'closing', physical_purged_at: null });
      expect(bucket.objects.has(key)).toBe(true);

      const input = { importId: view.id, sourceArtifactId };
      // Only the service may requalify, only a file that carries this debt, and only as observed.
      await expect(requalifyArchiveRestoreDebt(app.db, bucket, owner, input)).rejects.toEqual(
        new AppError('FORBIDDEN'),
      );
      await expect(
        withTenantTx(app.db, owner, (tx) =>
          tx.execute(
            sql`select lifecycle.requalify_archive_restore_debt(${view.id}::uuid,${sourceArtifactId}::uuid,'absent')`,
          ),
        ),
      ).rejects.toSatisfy(isCode('42501'));
      await expect(
        withTenantTx(app.db, service, (tx) =>
          tx.execute(
            sql`select lifecycle.requalify_archive_restore_debt(${view.id}::uuid,${randomUUID()}::uuid,'absent')`,
          ),
        ),
      ).rejects.toSatisfy(isCode('EN850'));
      await expect(
        withTenantTx(app.db, service, (tx) =>
          tx.execute(
            sql`select lifecycle.requalify_archive_restore_debt(${view.id}::uuid,${sourceArtifactId}::uuid,'gone')`,
          ),
        ),
      ).rejects.toSatisfy(isCode('42501'));
      // No runtime role reads the proof table directly.
      await expect(
        withTenantTx(app.db, service, (tx) =>
          tx.execute(sql`select * from lifecycle.archive_restore_requalifications`),
        ),
      ).rejects.toSatisfy(isCode('42501'));
      // A store that cannot certify physical absence observes nothing and records nothing.
      expect(await requalifyArchiveRestoreDebt(app.db, {}, service, input)).toEqual({
        state: 'unconfirmed',
      });
      expect(await owed(owner)).toBeGreaterThan(0);

      // The bytes survived, which is what is recorded. Twice is the same proof. Present is no deletion:
      // the file stays owed until the ordinary archive lifecycle proves one.
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await requalifyArchiveRestoreDebt(app.db, bucket, service, input)).toEqual({
          state: 'requalified',
          observed: 'present',
        });
      expect(await owed(owner)).toBeGreaterThan(0);
      await purge();
      expect(bucket.objects.has(key)).toBe(false);
      const purged = await header();
      expect(purged.state).toBe('purged');
      expect(purged.physical_purged_at).not.toBeNull();
      expect(await owed(owner)).toBe(0);
    });
  });

  describe('across restores (0515 rotation)', () => {
    // R: a closed source whose raw objects were purged before the restore. D: a generated file
    // whose deletion a restore re-applied. Separate tenants: each one's owed debt blocks only itself.
    const r = {
      bucket: new Bucket(),
      owner: undefined as unknown as TenantContext,
      service: undefined as unknown as TenantContext,
      sourceId: '',
      documentId: '',
      version: 0,
      jobId: '',
    };
    const d = {
      bucket: new Bucket(),
      owner: undefined as unknown as TenantContext,
      service: undefined as unknown as TenantContext,
      artifactId: '',
      key: '',
      entry: undefined as unknown as LedgerEntry,
    };
    const rStore = () => nativeKnowledgeStore(app.db, r.bucket);
    const dStore = () => nativeKnowledgeStore(app.db, d.bucket);
    const rawComplete = async () =>
      (
        await withTenantTx(app.db, r.service, (tx) =>
          tx.execute<{ complete: boolean }>(sql`select lifecycle.raw_source_material_complete(
            ${r.sourceId}::uuid,${r.version}::bigint,${r.jobId}::uuid,ai.current_material_restore_generation()) complete`),
        )
      ).rows[0]?.complete;
    const job = async () =>
      (
        await control.query<{ state: string; last_error_code: string | null }>(
          'select state,last_error_code from knowledge.purge_jobs where organization_id=$1 and id=$2',
          [r.owner.organizationId, r.jobId],
        )
      ).rows[0]!;
    const complete = () =>
      withTenantTx(app.db, r.service, (tx) =>
        tx.execute(
          sql`update knowledge.purge_jobs set state='completed',completed_at=clock_timestamp() where id=${r.jobId}::uuid`,
        ),
      ).then(
        () => null,
        (error: unknown) => error,
      );
    const repairCertificates = async () => {
      await purgeRunTranscriptsForSource(
        agent.db,
        r.service,
        { transcripts: createRunTranscriptPurge() },
        { sourceId: r.sourceId },
      );
      expect(
        await createDelegatedWorkPurge({
          database: agent.db,
          accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
        }).purgeSource(r.service, { sourceId: r.sourceId, limit: 25 }),
      ).toMatchObject({ confirmed: true });
    };
    const upload = (title: string) =>
      addUploadedSource(app.db, rStore(), r.owner, {
        title,
        mediaType: 'text/plain',
        body: Buffer.from(`Generated ${title}.`),
        classification: 'internal',
        grants: [],
      });
    const failures: unknown[] = [];
    const perform = (lifecycle = false) =>
      reapplyTombstoneLedger(
        app.db,
        dStore(),
        createServiceContext,
        (error) => failures.push(error),
        {
          confirmed: new Set([ledgerRef(d.entry)]),
          ...(lifecycle
            ? {
                derivedArtifacts: createObjectDeletionLifecycle({
                  database: app.db,
                  store: d.bucket,
                }).derived,
              }
            : {}),
        },
      );
    const pending = async () =>
      (
        await control.query<{ restore_reapply_pending: boolean }>(
          'select restore_reapply_pending from knowledge.artifact_lineage where organization_id=$1 and artifact_id=$2',
          [d.owner.organizationId, d.artifactId],
        )
      ).rows[0]?.restore_reapply_pending;

    it('prepares a purged source and a re-applied generated deletion before the restore', async () => {
      const rTenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
      r.owner = rTenant.owner;
      r.service = createServiceContext(rTenant.organizationId);
      const source = await upload('restored source');
      r.sourceId = source.sourceId;
      r.documentId = source.documentId;
      const { purgeJobId } = await revokeSource(app.db, r.owner, {
        sourceId: r.sourceId,
        expectedVersion: (await getSource(app.db, r.owner, r.sourceId)).version,
        reason: 'Generated closure before a restore',
      });
      r.jobId = purgeJobId;
      expect(
        await runNativeKnowledgePurge({
          app: app.db,
          agent: agent.db,
          store: rStore(),
          organizationId: rTenant.organizationId,
          sourceId: r.sourceId,
        }),
      ).toMatchObject({ state: 'completed' });
      expect(r.bucket.objects.has(knowledgeObjectKey(rTenant.organizationId, r.documentId))).toBe(
        false,
      );
      r.version = Number(
        (
          await control.query<{ version: string }>(
            'select version::text from knowledge.sources where organization_id=$1 and id=$2',
            [rTenant.organizationId, r.sourceId],
          )
        ).rows[0]!.version,
      );
      expect(await rawComplete()).toBe(true);

      const dTenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
      d.owner = dTenant.owner;
      d.service = createServiceContext(dTenant.organizationId);
      const work = await createWorkUnit(app.db, d.owner, {
        title: 'Generated requalification work',
        objective: 'Check a synthetic template output.',
        classification: 'internal',
        executionPlan: 'checklist',
      });
      await transitionWorkUnit(app.db, d.owner, {
        id: work.id,
        expectedVersion: work.version,
        to: 'ready',
      });
      await requestExecution(app.db, d.owner, work.id);
      const run = {
        organizationId: dTenant.organizationId,
        workUnitId: work.id,
        runId: randomUUID(),
      };
      const activities = createActivities({ database: app.db, store: dStore() });
      expect(await activities.prepareWork(run)).toMatchObject({ status: 'running' });
      d.artifactId = (await activities.produceChecklistArtifact(run)).artifactId;
      d.key = `${dTenant.organizationId}/artifacts/${d.artifactId}`;
      d.entry = {
        organizationId: dTenant.organizationId,
        targetType: 'artifact',
        targetId: d.artifactId,
        deletedAt: new Date(),
      };
      await dStore().put(ledgerKeyFor(d.entry), serializeLedgerEntry(d.entry), 'application/json');
      expect((await perform()).failed).toBe(1);
      expect(await pending()).toBe(true);
      expect(await owed(d.owner)).toBeGreaterThan(0);
    });

    it('never admits a deletion on a requalification of another writer (0543 admission)', async () => {
      // A proof row naming another writer token, as a forged or foreign restored row would. It covers
      // neither the debt nor the restore-pending header, so the lifecycle refuses, the object stays
      // owed, and the real proof cannot be recorded beside it in this generation.
      await control.query(
        `insert into lifecycle.object_restore_requalifications(organization_id,object_key,kind,artifact_id,writer_token,observed,
          material_restore_generation,auth_restore_generation)
         select $1,$2,'derived',$3,gen_random_uuid(),'present',o.material_restore_generation,gen_random_uuid()
          from org.organizations o where o.id=$1`,
        [d.owner.organizationId, d.key, d.artifactId],
      );
      failures.length = 0;
      expect(await perform(true)).toMatchObject({
        failed: 1,
        artifactsRemoved: 0,
        bytesRemoved: 0,
      });
      expect(d.bucket.objects.has(d.key)).toBe(true);
      expect(await pending()).toBe(true);
      expect(await owed(d.owner)).toBeGreaterThan(0);
      await expect(
        requalifyGeneratedRestoreDebt(app.db, d.bucket, d.service, d.artifactId),
      ).rejects.toSatisfy(isCode('EN850'));
    });

    it('re-proves the raw inventory a restore left in debt, exactly and only as observed', async () => {
      const before = await generation(r.owner);
      await rotate();
      expect(await generation(r.owner)).not.toBe(before);
      expect(await rawComplete()).toBe(false);
      expect(await job()).toMatchObject({ state: 'failed' });
      await repairCertificates();
      const refusal = await complete();
      expect(pgCode(refusal)).toBe('EN850');
      expect((refusal as { cause?: { message?: string } }).cause?.message).toBe(
        'RAW_SOURCE_UNCONFIRMED',
      );

      const objectKey = knowledgeObjectKey(r.owner.organizationId, r.documentId);
      // The inventory names a real document. Bytes that survived the restore are reported and
      // nothing is recorded.
      r.bucket.objects.set(objectKey, Buffer.from('Restored raw bytes.'));
      expect(await requalifyRawRestoreSource(app.db, r.bucket, r.service, r.sourceId)).toEqual({
        state: 'present',
        documentIds: [r.documentId],
      });
      expect(await rawComplete()).toBe(false);
      r.bucket.objects.delete(objectKey);
      // A store that cannot certify absence, or cannot answer, observes nothing.
      expect(await requalifyRawRestoreSource(app.db, {}, r.service, r.sourceId)).toEqual({
        state: 'unconfirmed',
      });
      expect(
        await requalifyRawRestoreSource(
          app.db,
          {
            isPhysicallyAbsent: async () => {
              throw new Error('GENERATED_STORE_DOWN');
            },
          },
          r.service,
          r.sourceId,
        ),
      ).toEqual({ state: 'unconfirmed' });
      // Only the exact set the inventory names: a missing, an extra or a repeated ID refuses.
      for (const set of [
        sql`'{}'::uuid[]`,
        sql`ARRAY[${r.documentId}::uuid,${randomUUID()}::uuid]`,
        sql`ARRAY[${randomUUID()}::uuid]`,
        sql`ARRAY[${r.documentId}::uuid,${r.documentId}::uuid]`,
      ])
        await expect(
          withTenantTx(app.db, r.service, (tx) =>
            tx.execute(
              sql`select lifecycle.requalify_raw_restore_source(${r.sourceId}::uuid,${set})`,
            ),
          ),
        ).rejects.toSatisfy(isCode('EN850'));
      expect(await rawComplete()).toBe(false);
      await expect(
        requalifyRawRestoreSource(app.db, r.bucket, r.owner, r.sourceId),
      ).rejects.toEqual(new AppError('FORBIDDEN'));
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await requalifyRawRestoreSource(app.db, r.bucket, r.service, r.sourceId)).toEqual({
          state: 'requalified',
          observed: 'absent',
        });
      expect(await rawComplete()).toBe(true);
    });

    it('stops accepting the proof the moment what it proved drifts (0543 raw_source_requalified)', async () => {
      const where = [r.owner.organizationId, r.sourceId];
      const [inventory] = (
        await control.query<{ capture_sha256: string }>(
          `select capture_sha256 from lifecycle.raw_source_inventories where organization_id=$1 and scope_kind='source' and source_id=$2`,
          where,
        )
      ).rows;
      // The sealed capture no longer matches the proof.
      await asRestored(
        `update lifecycle.raw_source_inventories set capture_sha256=$3 where organization_id=$1 and scope_kind='source' and source_id=$2`,
        [...where, inventory!.capture_sha256 === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64)],
      );
      expect(await rawComplete()).toBe(false);
      await asRestored(
        `update lifecycle.raw_source_inventories set capture_sha256=$3 where organization_id=$1 and scope_kind='source' and source_id=$2`,
        [...where, inventory!.capture_sha256],
      );
      expect(await rawComplete()).toBe(true);
      // A deletion claim for one of its objects is unresolved again.
      const reopened = await asRestored<{ id: string }>(
        `update lifecycle.object_deletion_claims set state='unknown' where organization_id=$1 and kind='raw_source'
          and raw_source_id=$2 and state='proven' returning id`,
        where,
      );
      expect(reopened.rows.length).toBeGreaterThan(0);
      expect(await rawComplete()).toBe(false);
      await asRestored(
        `update lifecycle.object_deletion_claims set state='proven' where organization_id=$1 and id=any($2::uuid[])`,
        [r.owner.organizationId, reopened.rows.map((row) => row.id)],
      );
      expect(await rawComplete()).toBe(true);
    });

    it('completes the purge on the proof, and the completion sweep keeps it only while it holds', async () => {
      expect(await complete()).toBeNull();
      expect(await job()).toMatchObject({ state: 'completed' });
      const sweep = async () =>
        (
          await withTenantTx(app.db, r.service, (tx) =>
            tx.execute<{ changed: number }>(
              sql`select lifecycle.reconcile_raw_source_completions(${r.sourceId}::uuid) changed`,
            ),
          )
        ).rows[0]?.changed;
      expect(await sweep()).toBe(0);
      expect(await job()).toMatchObject({ state: 'completed' });
      const where = [r.owner.organizationId, r.sourceId];
      const [inventory] = (
        await control.query<{ capture_sha256: string }>(
          `select capture_sha256 from lifecycle.raw_source_inventories where organization_id=$1 and scope_kind='source' and source_id=$2`,
          where,
        )
      ).rows;
      await asRestored(
        `update lifecycle.raw_source_inventories set capture_sha256=$3 where organization_id=$1 and scope_kind='source' and source_id=$2`,
        [...where, inventory!.capture_sha256 === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64)],
      );
      expect(await sweep()).toBe(1);
      expect(await job()).toMatchObject({
        state: 'failed',
        last_error_code: 'RAW_SOURCE_UNCONFIRMED',
      });
      await asRestored(
        `update lifecycle.raw_source_inventories set capture_sha256=$3 where organization_id=$1 and scope_kind='source' and source_id=$2`,
        [...where, inventory!.capture_sha256],
      );
      expect(await complete()).toBeNull();
      expect(await sweep()).toBe(0);
    });

    it('re-admits native raw uploads only through the organization requalification (0545)', async () => {
      // The restore left the organization marker in debt: no native raw upload is admitted.
      await expect(upload('refused after restore')).rejects.toBeDefined();
      await expect(requalifyRawRestoreOrganization(app.db, r.owner)).rejects.toEqual(
        new AppError('FORBIDDEN'),
      );
      await expect(
        withTenantTx(app.db, r.owner, (tx) =>
          tx.execute(sql`select lifecycle.requalify_raw_restore_org()`),
        ),
      ).rejects.toSatisfy(isCode('42501'));
      await expect(
        withTenantTx(app.db, r.service, (tx) =>
          tx.execute(sql`select * from lifecycle.raw_org_restore_requalifications`),
        ),
      ).rejects.toSatisfy(isCode('42501'));
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await requalifyRawRestoreOrganization(app.db, r.service)).toEqual({
          state: 'requalified',
        });
      const fresh = await upload('admitted after requalification');
      expect(
        r.bucket.objects.has(knowledgeObjectKey(r.owner.organizationId, fresh.documentId)),
      ).toBe(true);
      // The older source keeps its own proof; the marker proves nothing about it.
      expect(await rawComplete()).toBe(true);
    });

    it('records the generated proof and keeps the object owed while its bytes survive', async () => {
      expect(
        await requalifyGeneratedRestoreDebt(app.db, d.bucket, d.service, d.artifactId),
      ).toEqual({ state: 'requalified', observed: 'present' });
      expect(await owed(d.owner)).toBeGreaterThan(0);
      expect(await pending()).toBe(true);
    });

    it('reopens every kind of restore debt on a later restore', async () => {
      await rotate();
      // Raw source: the proof was for the previous generation.
      expect(await rawComplete()).toBe(false);
      expect(await requalifyRawRestoreSource(app.db, r.bucket, r.service, r.sourceId)).toEqual({
        state: 'requalified',
        observed: 'absent',
      });
      expect(await rawComplete()).toBe(true);
      // Organization marker: refused again until requalified in this generation.
      await expect(upload('refused after the second restore')).rejects.toBeDefined();
      expect(await requalifyRawRestoreOrganization(app.db, r.service)).toEqual({
        state: 'requalified',
      });
      await upload('admitted after the second requalification');
      // Generated file: the earlier proof no longer admits the lifecycle, and the object stays owed.
      failures.length = 0;
      expect(await perform(true)).toMatchObject({ failed: 1 });
      expect(d.bucket.objects.has(d.key)).toBe(true);
      expect(await owed(d.owner)).toBeGreaterThan(0);
      expect(
        await requalifyGeneratedRestoreDebt(app.db, d.bucket, d.service, d.artifactId),
      ).toEqual({ state: 'requalified', observed: 'present' });
      expect(await owed(d.owner)).toBeGreaterThan(0);
      failures.length = 0;
      expect(await perform(true)).toMatchObject({
        failed: 0,
        unconfirmed: 0,
        artifactsRemoved: 1,
        bytesRemoved: 1,
      });
      expect(failures).toEqual([]);
      expect(d.bucket.objects.has(d.key)).toBe(false);
      expect(await pending()).toBe(false);
      expect(await owed(d.owner)).toBe(0);
    });
  });
});
