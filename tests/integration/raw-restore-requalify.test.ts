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
import { beginErasure } from '@ensemus/application/saas/offboarding';
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
import {
  nativeKnowledgeStore,
  nativeMfaOwner,
  runNativeKnowledgePurge,
} from '../helpers/knowledge-native';
import { makePerson, nativePersonContext } from '../helpers/product';
import { testRecipient } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { buildArchive } from './fixtures/archive-builder';
import { LifecycleMemoryStore } from './saas-lifecycle-fixture';
import { publishErasureLedger, readyToErase } from './saas-offboarding-fixture';

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

/** The offboarding fixtures' memory store, with the single-attempt PUT the native raw port needs. */
class RawMap extends LifecycleMemoryStore {
  async putSingleAttempt(key: string, body: Buffer): Promise<{ transport: 'written' }> {
    this.objects.set(key, Buffer.from(body));
    return { transport: 'written' };
  }
}

const isCode = (code: string) => (error: unknown) => pgCode(error) === code;

/** The three 0545 service entry points that ensemus_app holds EXECUTE on. */
const SERVICE_ENTRY_POINTS = [
  'lifecycle.archive_restore_requalification_key(uuid,uuid)',
  'lifecycle.requalify_archive_restore_debt(uuid,uuid,text)',
  'lifecycle.requalify_raw_restore_org()',
];

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
  /**
   * The raw erasure witness, lifecycle.raw_tenant_inventory_complete() (0516, rewritten by 0545). It
   * has no runtime grant: the seal and 0516's receipt trigger (bind_raw_erasure_witness) run it as its
   * owner, so it is read here through that same migrator login, bound to one tenant.
   */
  const witness = async (organizationId: string) => {
    await migrator.query('begin');
    try {
      await migrator.query(`select set_config('app.organization_id',$1,true)`, [organizationId]);
      const result = await migrator.query<{ complete: boolean | null }>(
        'select lifecycle.raw_tenant_inventory_complete() complete',
      );
      await migrator.query('commit');
      return result.rows[0]?.complete;
    } catch (error) {
      await migrator.query('rollback');
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

  describe('service entry points (0545 postcondition)', () => {
    // ensemus_agent is created IN ROLE ensemus_app (provision.sql), so it inherits EXECUTE on every
    // function granted to ensemus_app. 0545's postcondition therefore asserts the direct grants and the
    // in-function refusal; these are the same two facts, observed on the real roles.
    it('grants EXECUTE directly to ensemus_app alone, and refuses the agent inside the function', async () => {
      const grants = await control.query<{ fn: string; grantee: string }>(
        `select p.oid::regprocedure::text fn,a.grantee::regrole::text grantee from pg_proc p
          cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where p.oid=any($1::regprocedure[]) and a.privilege_type='EXECUTE' order by 1 collate "C",2 collate "C"`,
        [SERVICE_ENTRY_POINTS],
      );
      expect(grants.rows).toEqual(
        SERVICE_ENTRY_POINTS.flatMap((fn) => [
          { fn, grantee: 'ensemus_app' },
          { fn, grantee: 'ensemus_migrator' },
        ]),
      );
      // The inheritance is real: the privilege check alone cannot tell the agent from the service.
      const inherited = await control.query<{ fn: string; agent: boolean; eraser: boolean }>(
        `select fn,has_function_privilege('ensemus_agent',fn,'EXECUTE') agent,
          has_function_privilege('ensemus_eraser',fn,'EXECUTE') eraser from unnest($1::text[]) fn`,
        [SERVICE_ENTRY_POINTS],
      );
      expect(inherited.rows).toHaveLength(SERVICE_ENTRY_POINTS.length);
      expect(inherited.rows.every((row) => row.agent && !row.eraser)).toBe(true);

      const { organizationId } = await createOrganization(app.db, {
        userId: (await makePerson('entry-point-agent')).userId,
        name: 'Generated entry point tenant',
        commercialMode: 'sovereign',
      });
      const service = createServiceContext(organizationId);
      // The agent login, even with a service actor, is refused before anything is read.
      for (const call of [
        sql`select lifecycle.archive_restore_requalification_key(${randomUUID()}::uuid,${randomUUID()}::uuid)`,
        sql`select lifecycle.requalify_archive_restore_debt(${randomUUID()}::uuid,${randomUUID()}::uuid,'absent')`,
        sql`select lifecycle.requalify_raw_restore_org()`,
      ])
        await expect(withTenantTx(agent.db, service, (tx) => tx.execute(call))).rejects.toSatisfy(
          isCode('42501'),
        );
      // The same call as the service login gets past that refusal: it fails on the missing debt
      // (EN850), not on who is calling.
      await expect(
        withTenantTx(app.db, service, (tx) =>
          tx.execute(
            sql`select lifecycle.requalify_archive_restore_debt(${randomUUID()}::uuid,${randomUUID()}::uuid,'absent')`,
          ),
        ),
      ).rejects.toSatisfy(isCode('EN850'));
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
    // The raw erasure witness (0545 raw_tenant_inventory_complete). W: a tenant whose only source was
    // purged before the restore, erased after it. E: an empty native tenant. L: a tenant an older
    // database restored, whose organization marker is protocol 0 (legacy). Each is its own tenant.
    const w = {
      bucket: new RawMap(),
      owner: undefined as unknown as TenantContext,
      service: undefined as unknown as TenantContext,
      sourceId: '',
      jobId: '',
    };
    const e = { organizationId: '', service: undefined as unknown as TenantContext };
    const l = { organizationId: '', service: undefined as unknown as TenantContext };
    /** A proof row exactly like the one the service records, but for another material generation. */
    const staleOrgProof = (organizationId: string) =>
      control.query(
        `insert into lifecycle.raw_org_restore_requalifications(organization_id,protocol_version,
          prior_material_restore_generation,material_restore_generation,auth_restore_generation)
         select i.organization_id,i.protocol_version,i.material_restore_generation,gen_random_uuid(),gen_random_uuid()
          from lifecycle.raw_source_inventories i where i.organization_id=$1 and i.scope_kind='organization'`,
        [organizationId],
      );
    const orgProofs = async (organizationId: string) =>
      (
        await control.query<{ protocol_version: number; prior: string; current: boolean }>(
          `select q.protocol_version,q.prior_material_restore_generation::text prior,
            q.material_restore_generation=o.material_restore_generation current
           from lifecycle.raw_org_restore_requalifications q join org.organizations o on o.id=q.organization_id
           where q.organization_id=$1 order by q.proven_at`,
          [organizationId],
        )
      ).rows;
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

    it('prepares the erasure witness tenants before the restore (0516)', async () => {
      w.owner = await nativeMfaOwner(app.db, 'erasure-witness');
      w.service = createServiceContext(w.owner.organizationId);
      const store = nativeKnowledgeStore(app.db, w.bucket);
      const source = await addUploadedSource(app.db, store, w.owner, {
        title: 'witness source',
        mediaType: 'text/plain',
        body: Buffer.from('Generated witness source.'),
        classification: 'internal',
        grants: [],
      });
      w.sourceId = source.sourceId;
      w.jobId = (
        await revokeSource(app.db, w.owner, {
          sourceId: w.sourceId,
          expectedVersion: (await getSource(app.db, w.owner, w.sourceId)).version,
          reason: 'Generated closure before a restore',
        })
      ).purgeJobId;
      expect(
        await runNativeKnowledgePurge({
          app: app.db,
          agent: agent.db,
          store,
          organizationId: w.owner.organizationId,
          sourceId: w.sourceId,
        }),
      ).toMatchObject({ state: 'completed' });
      expect(
        w.bucket.objects.has(knowledgeObjectKey(w.owner.organizationId, source.documentId)),
      ).toBe(false);
      // Before any restore, 0516's conjuncts hold: an open protocol-1 marker in this generation and
      // the one source sealed and complete.
      expect(await witness(w.owner.organizationId)).toBe(true);

      for (const tenant of [e, l]) {
        const { organizationId } = await createOrganization(app.db, {
          userId: (await makePerson('erasure-witness-empty')).userId,
          name: 'Generated witness tenant',
          commercialMode: 'sovereign',
        });
        tenant.organizationId = organizationId;
        tenant.service = createServiceContext(organizationId);
      }
      expect(await witness(e.organizationId)).toBe(true);
      // L's marker as a database from before 0516 left it: legacy debt, which 0516 never accepts.
      await asRestored(
        `update lifecycle.raw_source_inventories set protocol_version=0,state='legacy'
          where organization_id=$1 and scope_kind='organization'`,
        [l.organizationId],
      );
      expect(await witness(l.organizationId)).toBe(false);
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

    it('accepts the erasure witness only on current protocol-1 proofs, and erases on them (0545)', async () => {
      const tenant = w.owner.organizationId;
      // The restore above left W's organization marker and its source inventory in debt.
      expect(await witness(tenant)).toBe(false);
      expect(await requalifyRawRestoreOrganization(app.db, w.service)).toEqual({
        state: 'requalified',
      });
      // The organization proof proves nothing about the source a restore left in debt.
      expect(await witness(tenant)).toBe(false);
      // A proof of exactly this inventory, but recorded for another material generation (as a
      // restored older proof row would be), is not a proof for this one.
      await control.query(
        `insert into lifecycle.raw_restore_requalifications(organization_id,source_id,purge_job_id,source_version,
          capture_count,capture_sha256,document_ids,prior_material_restore_generation,material_restore_generation,auth_restore_generation)
         select i.organization_id,i.source_id,i.purge_job_id,i.source_version,i.capture_count,i.capture_sha256,
          coalesce((select array_agg(x.document_id order by x.document_id) from lifecycle.raw_object_writes x
           where x.organization_id=i.organization_id and x.source_id=i.source_id and x.generation=0),'{}'::uuid[]),
          i.material_restore_generation,gen_random_uuid(),gen_random_uuid()
          from lifecycle.raw_source_inventories i where i.organization_id=$1 and i.scope_kind='source' and i.source_id=$2`,
        [tenant, w.sourceId],
      );
      expect(await witness(tenant)).toBe(false);
      expect(await requalifyRawRestoreSource(app.db, w.bucket, w.service, w.sourceId)).toEqual({
        state: 'requalified',
        observed: 'absent',
      });
      // The stale row was the real proof in everything but its generation.
      const proofs = await control.query<{ current: boolean; proof: unknown }>(
        `select q.material_restore_generation=o.material_restore_generation current,
          jsonb_build_array(q.purge_job_id,q.source_version,q.capture_count,q.capture_sha256,q.document_ids,
           q.prior_material_restore_generation) proof
         from lifecycle.raw_restore_requalifications q join org.organizations o on o.id=q.organization_id
         where q.organization_id=$1 and q.source_id=$2 order by q.proven_at`,
        [tenant, w.sourceId],
      );
      expect(proofs.rows.map((row) => row.current)).toEqual([false, true]);
      expect(proofs.rows[0]?.proof).toEqual(proofs.rows[1]?.proof);
      expect(await witness(tenant)).toBe(true);

      // The erasure on that witness. The restore demoted the source's completed purge; its agent
      // certificates are re-issued for this generation and the purge completes on the proof, as R's
      // did. The seal then binds the witness through 0516's receipt trigger.
      await purgeRunTranscriptsForSource(
        agent.db,
        w.service,
        { transcripts: createRunTranscriptPurge() },
        { sourceId: w.sourceId },
      );
      expect(
        await createDelegatedWorkPurge({
          database: agent.db,
          accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
        }).purgeSource(w.service, { sourceId: w.sourceId, limit: 25 }),
      ).toMatchObject({ confirmed: true });
      await withTenantTx(app.db, w.service, (tx) =>
        tx.execute(
          sql`update knowledge.purge_jobs set state='completed',completed_at=clock_timestamp() where id=${w.jobId}::uuid`,
        ),
      );
      const ready = await readyToErase(app.db, w.owner);
      await beginErasure(app.db, ready.service, {
        offboardingId: ready.offboardingId,
        operatorRef: 'generated-witness-review@example.invalid',
      });
      await publishErasureLedger(app.db, w.owner, w.bucket);
      const sealed = await withTenantTx(app.db, ready.service, (tx) =>
        tx.execute<{ sealed: boolean }>(
          sql`select lifecycle.seal_delegated_erasure(${ready.offboardingId}::uuid) sealed`,
        ),
      );
      expect(sealed.rows[0]?.sealed).toBe(true);
      const receipt = await control.query<{
        raw_protocol_version: number;
        raw_scope_count: string;
      }>(
        'select raw_protocol_version,raw_scope_count::text from lifecycle.delegated_erasure_receipts where organization_id=$1',
        [tenant],
      );
      // The organization marker and the source inventory, both in restore debt, both proven.
      expect(receipt.rows).toEqual([{ raw_protocol_version: 1, raw_scope_count: '2' }]);

      // E, empty: a stale organization proof is refused, the current one is accepted.
      expect(await witness(e.organizationId)).toBe(false);
      await staleOrgProof(e.organizationId);
      expect(await witness(e.organizationId)).toBe(false);
      expect(await requalifyRawRestoreOrganization(app.db, e.service)).toEqual({
        state: 'requalified',
      });
      const eProofs = await orgProofs(e.organizationId);
      expect(eProofs.map((row) => row.current)).toEqual([false, true]);
      expect(eProofs[0]).toMatchObject({ protocol_version: 1, prior: eProofs[1]?.prior });
      expect(await witness(e.organizationId)).toBe(true);

      // L: a protocol-0 marker may be requalified (it re-admits births as before the restore), and
      // still never satisfies the erasure witness.
      expect(await requalifyRawRestoreOrganization(app.db, l.service)).toEqual({
        state: 'requalified',
      });
      expect(await orgProofs(l.organizationId)).toMatchObject([
        { protocol_version: 0, current: true },
      ]);
      expect(await witness(l.organizationId)).toBe(false);
    });

    it('reopens the erasure witness on a later restore (0545)', async () => {
      expect(await witness(w.owner.organizationId)).toBe(true);
      expect(await witness(e.organizationId)).toBe(true);
      await rotate();
      // Every proof was for the previous generation.
      expect(await witness(w.owner.organizationId)).toBe(false);
      expect(await witness(e.organizationId)).toBe(false);
      expect(await witness(l.organizationId)).toBe(false);
      // Only a proof in this generation answers it again.
      expect(await requalifyRawRestoreOrganization(app.db, e.service)).toEqual({
        state: 'requalified',
      });
      expect(await witness(e.organizationId)).toBe(true);
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
