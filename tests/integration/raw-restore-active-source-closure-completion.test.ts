// What 0551 lets a closed active-source restore debt reach once it is purged, and what still refuses
// it: the tenant erasure witness and the completion sweep (check finding 1), the survivor-claim
// routing (finding 6), the SQL supersede trigger itself on a closed source (finding 8), and the
// observation entry point when the store cannot be read (finding 9). FLAGGED FOR HUMAN SECURITY
// REVIEW, not yet reviewed by a person. raw-restore-active-source-closure.test.ts covers the closure
// paths themselves; this file is self-contained and copies its fixtures. The material restore
// generation is rotated the way the native restore rotates it, which is global: this file runs
// serially, as the whole integration project does (fileParallelism: false). Storage is an explicit
// memory test double; nothing here qualifies a provider.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  AppError,
  deleteRawRestoreSurvivor,
  recordRawRestoreActiveSourceClosure,
  requalifyRawRestoreActiveSource,
  requalifyRawRestoreOrganization,
  type ActiveSourceRequalificationStore,
  type ObjectStore,
} from '@ensemus/application';
import { ingestDocument, type IngestDeps } from '@ensemus/application/knowledge/ingest';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import {
  addDocumentVersion,
  addUploadedSource,
  getSource,
} from '@ensemus/application/knowledge/sources';
import { openAppDatabase, withTenantTx, type TenantContext } from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import { parseDocument } from '@ensemus/knowledge/parsing';
import { pgCode } from '../../packages/application/src/errors';
import { seedAiTenant } from '../helpers/ai/fixtures';
import { nativeKnowledgeStore, runNativeKnowledgePurge } from '../helpers/knowledge-native';
import { urls } from '../helpers/stack';

/** A memory bucket with the single-attempt and physical-absence capabilities the runtime store has. */
class Bucket implements ObjectStore {
  objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, Buffer.from(body));
  }
  async putSingleAttempt(key: string, body: Buffer): Promise<{ transport: 'written' }> {
    this.objects.set(key, Buffer.from(body));
    return { transport: 'written' };
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('MISSING');
    return Buffer.from(bytes);
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
}

/** The same bucket, whose single-attempt PUT loses its response: the native outcome is unknown. */
const losingResponses = (bucket: Bucket): ObjectStore => ({
  put: (key, body) => bucket.put(key, body),
  get: (key) => bucket.get(key),
  exists: (key) => bucket.exists(key),
  delete: (key) => bucket.delete(key),
  putSingleAttempt: async () => {
    throw new Error('Generated lost response');
  },
  deleteForPurge: (key) => bucket.deleteForPurge(key),
  isPhysicallyAbsent: (key) => bucket.isPhysicallyAbsent(key),
});

type Tenant = {
  bucket: Bucket;
  owner: TenantContext;
  service: TenantContext;
  organizationId: string;
  sourceId: string;
  documentId: string;
  key: string;
  bytes: Buffer;
};

/** The SQL refusal behind an error: its code and the exception the migration raised. */
const refusal = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => ({
      code: pgCode(error),
      reason: (error as { cause?: { message?: string } }).cause?.message,
    }),
  );
/**
 * The PL/pgSQL function that raised an error: the innermost frame of PostgreSQL's error context, which
 * begins "PL/pgSQL function <schema>.<name>() line N at RAISE" when a trigger function raised it. A
 * re-raise from the function's own EXCEPTION block keeps that frame. Read from the driver's error, or
 * from the driver error the query builder wraps.
 */
const raisedIn = (error: unknown) => {
  const where =
    (error as { where?: string }).where ?? (error as { cause?: { where?: string } }).cause?.where;
  return /PL\/pgSQL function (?:\w+\.)?(\w+)\(/.exec(where ?? '')?.[1];
};
/** The same SQL refusal, with the trigger function that raised it. */
const attributed = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => ({
      code: pgCode(error),
      reason: (error as { cause?: { message?: string } }).cause?.message,
      raisedIn: raisedIn(error),
    }),
  );
const ingestDeps: IngestDeps = {
  parse: async (body, type) => parseDocument(body, type),
  contentScan: { scan: () => ({ raiseTo: null, codes: [] }) },
};

describe('completing the closure of an active source a restore left in raw debt (0551)', () => {
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

  /** The native restore's material rotation, exactly as raw-restore-active-source.test.ts drives it. */
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
  const inventory = async (f: Tenant) =>
    (
      await control.query<{
        state: string;
        sealed: boolean;
        job: string | null;
        version: string | null;
      }>(
        `select i.state,i.sealed_at is not null sealed,i.purge_job_id::text job,i.source_version::text version
         from lifecycle.raw_source_inventories i
         where i.organization_id=$1 and i.scope_kind='source' and i.source_id=$2`,
        [f.organizationId, f.sourceId],
      )
    ).rows[0];
  const observations = async (f: Tenant) =>
    (
      await control.query<{ absent: string[]; changed: string[] }>(
        `select e.absent_document_ids::text[] absent,e.changed_document_ids::text[] changed
         from lifecycle.raw_active_source_closure_observations e
         where e.organization_id=$1 and e.source_id=$2`,
        [f.organizationId, f.sourceId],
      )
    ).rows;
  const allObservations = async () =>
    (
      await control.query<{ n: number }>(
        'select count(*)::int n from lifecycle.raw_active_source_closure_observations',
      )
    ).rows[0]!.n;
  const headers = async (f: Tenant) =>
    (
      await control.query<{ documents: number; chunks: number; writers: number }>(
        `select (select count(*)::int from knowledge.documents where organization_id=$1 and source_id=$2) documents,
          (select count(*)::int from knowledge.chunks where organization_id=$1 and source_id=$2) chunks,
          (select count(*)::int from knowledge.object_writers where organization_id=$1 and source_id=$2) writers`,
        [f.organizationId, f.sourceId],
      )
    ).rows[0];
  const job = async (f: Tenant) =>
    (
      await control.query<{ state: string; last_error_code: string | null }>(
        'select state,last_error_code from knowledge.purge_jobs where organization_id=$1 and source_id=$2',
        [f.organizationId, f.sourceId],
      )
    ).rows[0];
  /** Every raw deletion claim on the source, with whether it is of the current generation. */
  const claims = async (f: Tenant) =>
    (
      await control.query<{ id: string; state: string; current: boolean }>(
        `select c.id::text id,c.state,c.material_restore_generation=o.material_restore_generation current
         from lifecycle.object_deletion_claims c join org.organizations o on o.id=c.organization_id
         where c.organization_id=$1 and c.kind='raw_source' and c.raw_source_id=$2 order by c.admitted_at,c.id`,
        [f.organizationId, f.sourceId],
      )
    ).rows;
  /**
   * An internal predicate of the raw object authority, asked as its owner inside the raw metadata
   * scope the fixed functions read it in, bound to one tenant. Nothing is written: rolled back.
   */
  const asOwner = async <T>(f: Tenant, statement: string, values: unknown[]) => {
    await migrator.query('begin');
    try {
      await migrator.query(
        "select set_config('app.organization_id',$1,true),set_config('lifecycle.raw_object_org',$1,true)",
        [f.organizationId],
      );
      return (await migrator.query<{ answer: T }>(statement, values)).rows[0]?.answer;
    } finally {
      await migrator.query('rollback');
    }
  };
  /**
   * The raw erasure witness, lifecycle.raw_tenant_inventory_complete() (0516, 0545, widened by 0551
   * in exactly three places). It has no runtime grant: the seal and 0516's receipt trigger run it as
   * its owner, so it is read here through that same migrator login, bound to one tenant.
   */
  const witness = async (f: Tenant) => {
    await migrator.query('begin');
    try {
      await migrator.query(`select set_config('app.organization_id',$1,true)`, [f.organizationId]);
      return (
        await migrator.query<{ complete: boolean }>(
          'select lifecycle.raw_tenant_inventory_complete() complete',
        )
      ).rows[0]?.complete;
    } finally {
      await migrator.query('rollback');
    }
  };
  /** 0551's one completion predicate for closed active-source debt, at the inventory's version and job. */
  const closureComplete = async (f: Tenant) => {
    const i = (await inventory(f))!;
    return asOwner<boolean>(
      f,
      `select lifecycle.raw_active_closure_complete($1::uuid,$2::bigint,$3::uuid,
        ai.current_material_restore_generation(),app.current_auth_restore_generation()) answer`,
      [f.sourceId, i.version, i.job],
    );
  };
  /** 0547's survivor-claim routing, as 0551 narrowed it. */
  const survivorClaim = (f: Tenant, claimId: string) =>
    asOwner<boolean>(f, 'select lifecycle.raw_restore_survivor_claim($1::uuid) answer', [claimId]);
  /** The public absence proof the runtime calls after a terminal DELETE, as the service. */
  const absent = async (f: Tenant, claimId: string) =>
    (
      await withTenantTx(app.db, f.service, (tx) =>
        tx.execute<{ proven: boolean }>(
          sql`select lifecycle.object_delete_absent(${claimId}::uuid) as proven`,
        ),
      )
    ).rows[0]?.proven;
  /** The completion sweep, as the runtime's raw object port calls it. */
  const sweep = async (f: Tenant) =>
    (
      await withTenantTx(app.db, f.service, (tx) =>
        tx.execute<{ changed: number }>(
          sql`select lifecycle.reconcile_raw_source_completions(${f.sourceId}::uuid) changed`,
        ),
      )
    ).rows[0]?.changed;
  /** Completing the purge job again, which 0516's completion guard admits only on a proof. */
  const completeJob = (f: Tenant) =>
    withTenantTx(app.db, f.service, (tx) =>
      tx.execute(
        sql`update knowledge.purge_jobs set state='completed',completed_at=clock_timestamp()
            where source_id=${f.sourceId}::uuid`,
      ),
    );
  const complete = (f: Tenant) => refusal(completeJob(f));
  /**
   * The same completion UPDATE, as ensemus_app with a service actor, with every BEFORE trigger of
   * knowledge.purge_jobs in place except what `setup` changes first, as the superuser, inside this one
   * transaction, which is always rolled back: no other session can see it, and nothing is committed.
   * This is how the completion is asked of 0516's purge_jobs_raw_completion when an earlier guard in
   * name order would otherwise answer first (the same harness as finding 8's supersedeAtTrigger).
   * Only the completion UPDATE's own refusal is returned; a failing setup step fails the test.
   */
  const completeAtTrigger = async (f: Tenant, setup: (client: pg.Client) => Promise<void>) => {
    await control.query('begin');
    try {
      await setup(control);
      await control.query('set local session authorization ensemus_app');
      await control.query(
        `select set_config('app.organization_id',$1,true),set_config('app.user_id','',true),
          set_config('app.membership_id','',true),set_config('app.actor_type','service',true),
          set_config('app.agent_run_id','',true),set_config('app.agent_input_protocol','',true),
          set_config('app.interactive_session_id','',true)`,
        [f.organizationId],
      );
      return await control
        .query(
          `update knowledge.purge_jobs set state='completed',completed_at=clock_timestamp()
           where organization_id=$1 and source_id=$2`,
          [f.organizationId, f.sourceId],
        )
        .then(
          (result) => ({ completed: result.rowCount }),
          (error: unknown) => {
            const { code, message } = error as { code?: string; message?: string };
            return { code, reason: message, raisedIn: raisedIn(error) };
          },
        );
    } finally {
      await control.query('rollback');
    }
  };
  /** Turns off 0508's purge_jobs_0508_delete_proof alone, inside completeAtTrigger's transaction. */
  const without0508 = async (client: pg.Client) => {
    await client.query(
      'alter table knowledge.purge_jobs disable trigger purge_jobs_0508_delete_proof',
    );
  };
  /**
   * The question 0516's completion guard (knowledge.guard_raw_purge_completion, BEFORE trigger
   * purge_jobs_raw_completion, as 0527 left it) asks before it admits a completion:
   * lifecycle.raw_source_material_complete at the source's live version, the purge job and the
   * current material generation, as the service. That guard is the one 0551 widened, but on
   * knowledge.purge_jobs BEFORE triggers fire in name order, so an earlier guard may refuse the same
   * UPDATE first; this reaches 0516's own predicate whichever guard refuses the UPDATE, and
   * completeAtTrigger below reaches 0516's trigger itself.
   */
  const materialComplete = async (f: Tenant) => {
    const target = (
      await control.query<{ job: string; version: string }>(
        `select j.id::text job,s.version::text version from knowledge.purge_jobs j
         join knowledge.sources s on s.organization_id=j.organization_id and s.id=j.source_id
         where j.organization_id=$1 and j.source_id=$2`,
        [f.organizationId, f.sourceId],
      )
    ).rows;
    expect(target).toHaveLength(1);
    return (
      await withTenantTx(app.db, f.service, (tx) =>
        tx.execute<{ complete: boolean }>(
          sql`select lifecycle.raw_source_material_complete(${f.sourceId}::uuid,${target[0]!.version}::bigint,
            ${target[0]!.job}::uuid,ai.current_material_restore_generation()) complete`,
        ),
      )
    ).rows[0]?.complete;
  };
  /** The completion timestamps 0515's rotation and 0527's demotions are told apart by. */
  const completion = async (f: Tenant) =>
    (
      await control.query<{ completed: string | null; prior: string | null }>(
        `select completed_at::text completed,prior_completed_at::text prior
         from knowledge.purge_jobs where organization_id=$1 and source_id=$2`,
        [f.organizationId, f.sourceId],
      )
    ).rows[0];
  const version = async (f: Tenant) => (await getSource(app.db, f.owner, f.sourceId)).version;
  const revoke = async (f: Tenant) =>
    revokeSource(app.db, f.owner, {
      sourceId: f.sourceId,
      expectedVersion: await version(f),
      reason: 'Generated closure after a restore',
    });
  const purge = (f: Tenant) =>
    runNativeKnowledgePurge({
      app: app.db,
      agent: agent.db,
      store: nativeKnowledgeStore(app.db, f.bucket),
      organizationId: f.organizationId,
      sourceId: f.sourceId,
    });

  /** An open source with one raw object, uploaded natively and ingested before the restore. */
  const prepare = async (title: string): Promise<Tenant> => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const bucket = new Bucket();
    const store = nativeKnowledgeStore(app.db, bucket);
    const source = await addUploadedSource(app.db, store, tenant.owner, {
      title,
      mediaType: 'text/plain',
      body: Buffer.from(`Generated ${title}.`),
      classification: 'internal',
      grants: [],
    });
    const key = knowledgeObjectKey(tenant.organizationId, source.documentId);
    const bytes = bucket.objects.get(key);
    expect(bytes).toBeDefined();
    const service = createServiceContext(tenant.organizationId);
    expect(
      await ingestDocument(app.db, store, service, ingestDeps, { documentId: source.documentId }),
    ).toMatchObject({ outcome: 'searchable' });
    return {
      bucket,
      owner: tenant.owner,
      service,
      organizationId: tenant.organizationId,
      sourceId: source.sourceId,
      documentId: source.documentId,
      key,
      bytes: bytes!,
    };
  };
  /** A closed source whose one raw object was purged natively before the restore (0547's fixture). */
  const prepareSurvivor = async (title: string): Promise<Tenant> => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const bucket = new Bucket();
    const store = nativeKnowledgeStore(app.db, bucket);
    const source = await addUploadedSource(app.db, store, tenant.owner, {
      title,
      mediaType: 'text/plain',
      body: Buffer.from(`Generated ${title}.`),
      classification: 'internal',
      grants: [],
    });
    const key = knowledgeObjectKey(tenant.organizationId, source.documentId);
    const bytes = bucket.objects.get(key);
    expect(bytes).toBeDefined();
    const f: Tenant = {
      bucket,
      owner: tenant.owner,
      service: createServiceContext(tenant.organizationId),
      organizationId: tenant.organizationId,
      sourceId: source.sourceId,
      documentId: source.documentId,
      key,
      bytes: bytes!,
    };
    await revoke(f);
    expect(await purge(f)).toMatchObject({ state: 'completed' });
    expect(bucket.objects.has(key)).toBe(false);
    expect(await inventory(f)).toMatchObject({ sealed: true });
    return f;
  };

  // A is requalified (0550), closed and purged; O has a missing object, is observed (0551), closed and
  // purged; W keeps a lost upload across its closure; N is observed through stores that cannot read;
  // S is a closed source purged before the restore whose bytes the restore brought back. Separate
  // tenants: each one's debt blocks only itself, and one rotation restores all five.
  let a: Tenant, o: Tenant, w: Tenant, n: Tenant, s: Tenant;
  // A's settled writer header, as it was before the purge removed it.
  let writerRows: string[] = [];

  it('prepares four open sources and a purged one, and leaves each in restore debt', async () => {
    a = await prepare('requalified, closed and purged');
    o = await prepare('observed, closed and purged');
    w = await prepare('lost upload across the closure');
    n = await prepare('observed through an unreadable store');
    s = await prepareSurvivor('survivor of the restore');
    await rotate();
    for (const f of [a, o, w, n]) {
      expect(await inventory(f)).toMatchObject({ state: 'restore_debt', sealed: false, job: null });
      expect(await requalifyRawRestoreOrganization(app.db, f.service)).toEqual({
        state: 'requalified',
      });
    }
    // The restored store brought S's purged bytes back; its inventory was sealed before the restore.
    s.bucket.objects.set(s.key, s.bytes);
    expect(await inventory(s)).toMatchObject({ state: 'restore_debt', sealed: true });
    expect(await requalifyRawRestoreOrganization(app.db, s.service)).toEqual({
      state: 'requalified',
    });
  });

  it('records nothing when the store has no read, or a read fails without certified absence (finding 9)', async () => {
    n.bucket.objects.delete(n.key);
    const before = await allObservations();
    const unreadable: [string, ActiveSourceRequalificationStore][] = [
      // (a) No read at all: the store cannot say what is at any key.
      ['no read', { isPhysicallyAbsent: (key) => n.bucket.isPhysicallyAbsent(key) }],
      // (b) The read fails and the store has no physical-absence check: a failed read is not absence.
      ['no absence check', { get: (key) => n.bucket.get(key) }],
      // (b) The read fails and the absence check itself fails.
      [
        'absence check failed',
        {
          get: (key) => n.bucket.get(key),
          isPhysicallyAbsent: async () => {
            throw new Error('Generated absence check outage');
          },
        },
      ],
      // (b) The read fails and the store answers the object is still there.
      [
        'read failed, object present',
        {
          get: async () => {
            throw new Error('Generated read outage');
          },
          isPhysicallyAbsent: async () => false,
        },
      ],
    ];
    for (const [, store] of unreadable) {
      expect(
        await recordRawRestoreActiveSourceClosure(app.db, store, n.service, n.sourceId),
      ).toEqual({ state: 'unconfirmed' });
      expect(await observations(n)).toEqual([]);
      expect(await allObservations()).toBe(before);
    }
    // Nothing was recorded, so the source still cannot be closed.
    expect(await refusal(revoke(n))).toEqual({ code: '42501', reason: 'RAW_INVENTORY_IMMUTABLE' });
    // The same source through a store that reads and certifies absence: what was missing above was
    // the store, not the source.
    expect(
      await recordRawRestoreActiveSourceClosure(app.db, n.bucket, n.service, n.sourceId),
    ).toEqual({ state: 'recorded', absentDocumentIds: [n.documentId] });
    expect(await observations(n)).toEqual([{ absent: [n.documentId], changed: [] }]);
    expect(await allObservations()).toBe(before + 1);
  });

  it("refuses a supersede of a closed source in 0523's trigger itself, not only in the application (finding 8)", async () => {
    expect(await requalifyRawRestoreActiveSource(app.db, w.bucket, w.service, w.sourceId)).toEqual({
      state: 'requalified',
      observed: 'present',
    });
    // An upload whose admitted single-attempt PUT lost its response: its writer stays active, on a
    // write that is natively 'unknown', and is exactly what 0523 lets the next generation supersede.
    await expect(
      addDocumentVersion(app.db, nativeKnowledgeStore(app.db, losingResponses(w.bucket)), w.owner, {
        sourceId: w.sourceId,
        expectedVersion: await version(w),
        title: 'Generated version whose response was lost',
        mediaType: 'text/plain',
        body: Buffer.from('Generated version whose response was lost.'),
      }),
    ).rejects.toEqual(new AppError('INVALID_STATE'));
    const lost = await control.query<{ document: string }>(
      `select a.document_id::text document from knowledge.object_writers a join lifecycle.raw_object_writes x
        on x.organization_id=a.organization_id and x.document_id=a.document_id and x.write_id=a.write_id and x.generation=a.generation
       where a.organization_id=$1 and a.source_id=$2 and a.state='active' and x.state='unknown'`,
      [w.organizationId, w.sourceId],
    );
    expect(lost.rows).toHaveLength(1);
    const documentId = lost.rows[0]!.document;
    const writes = async () =>
      (
        await control.query<{ generation: string; state: string }>(
          `select x.generation::text generation,x.state from lifecycle.raw_object_writes x
           where x.organization_id=$1 and x.document_id=$2 and x.generation>0 order by x.generation`,
          [w.organizationId, documentId],
        )
      ).rows;
    expect(await writes()).toEqual([{ generation: '1', state: 'unknown' }]);
    /**
     * The supersede UPDATE the runtime issues, as ensemus_app with a service actor.
     *
     * With every trigger in place ('enforced') this is the real path, and on a closed source it never
     * reaches record_raw_supersede: knowledge.check_object_writer (0205's BEFORE row trigger
     * object_writers_check, as 0523 rewrote it) runs first. 0523 lets an active writer whose write is
     * natively 'unknown' skip 0205's settle-only branch (0523:65-66), but the next check it keeps from
     * 0205 (0523:74-77) requires the source to be 'active' and raises KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED
     * (42501) for a revoked one. record_raw_supersede is the AFTER trigger writers_raw_supersede
     * (0523:130), so it only ever sees an UPDATE that 0205's check already admitted.
     *
     * To ask record_raw_supersede itself (0523, as 0551 rewrote its inventory check, finding 8) whether
     * it refuses a closed source on its own, 'disabled' turns off object_writers_check alone, inside
     * this one transaction, which is always rolled back: no other session can see it, and nothing here
     * is committed. Both variants are asserted below, so the SQL backstop and the real refusal are each
     * pinned to their exact code.
     */
    const supersedeAtTrigger = async (writerCheck: 'disabled' | 'enforced') => {
      await control.query('begin');
      try {
        if (writerCheck === 'disabled')
          await control.query(
            'alter table knowledge.object_writers disable trigger object_writers_check',
          );
        await control.query('set local session authorization ensemus_app');
        await control.query(
          `select set_config('app.organization_id',$1,true),set_config('app.user_id','',true),
            set_config('app.membership_id','',true),set_config('app.actor_type','service',true),
            set_config('app.agent_run_id','',true),set_config('app.agent_input_protocol','',true),
            set_config('app.interactive_session_id','',true)`,
          [w.organizationId],
        );
        await control.query(
          `update knowledge.object_writers set write_id=gen_random_uuid(),generation=generation+1,state='active',
            started_by_membership_id=null,started_at=clock_timestamp()
           where organization_id=$1 and document_id=$2`,
          [w.organizationId, documentId],
        );
        await control.query('reset session authorization');
        const inserted = await control.query<{ generation: string; state: string }>(
          `select x.generation::text generation,x.state from lifecycle.raw_object_writes x
           where x.organization_id=$1 and x.document_id=$2 and x.generation>0 order by x.generation`,
          [w.organizationId, documentId],
        );
        return { superseded: inserted.rows };
      } catch (error) {
        const { code, message } = error as { code?: string; message?: string };
        return { code, reason: message };
      } finally {
        await control.query('rollback');
      }
    };
    // While the source is active and requalified, the trigger records the next generation's intent.
    expect(await supersedeAtTrigger('disabled')).toEqual({
      superseded: [
        { generation: '1', state: 'unknown' },
        { generation: '2', state: 'intent' },
      ],
    });
    expect(await writes()).toEqual([{ generation: '1', state: 'unknown' }]);
    const { purgeJobId } = await revoke(w);
    expect(await inventory(w)).toMatchObject({ state: 'restore_debt', job: purgeJobId });
    // The same UPDATE once the source is closed: every other condition of the trigger is unchanged,
    // and 0551's corrected raw_active_source_requalified no longer admits the restore-debt inventory.
    expect(await supersedeAtTrigger('disabled')).toEqual({
      code: 'EN850',
      reason: 'RAW_SUPERSEDE_UNCONFIRMED',
    });
    // The real path, the same service UPDATE with every trigger in place: 0205's writer check (as 0523
    // left it) refuses the revoked source before record_raw_supersede can run.
    expect(await supersedeAtTrigger('enforced')).toEqual({
      code: '42501',
      reason: 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED',
    });
    expect(await writes()).toEqual([{ generation: '1', state: 'unknown' }]);
    // The same UPDATE as the person, through the application role with every trigger in place: the
    // same 0205 check, the same refusal.
    expect(
      await refusal(
        withTenantTx(app.db, w.owner, (tx) =>
          tx.execute(
            sql`update knowledge.object_writers set write_id=gen_random_uuid(),generation=generation+1,
                state='active',started_by_membership_id=${w.owner.membershipId}::uuid,started_at=clock_timestamp()
                where document_id=${documentId}::uuid`,
          ),
        ),
      ),
    ).toEqual({ code: '42501', reason: 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED' });
    expect(await writes()).toEqual([{ generation: '1', state: 'unknown' }]);
  });

  it('lets the erasure witness accept a requalified active source only once it is closed and fully purged (finding 1)', async () => {
    expect(await requalifyRawRestoreActiveSource(app.db, a.bucket, a.service, a.sourceId)).toEqual({
      state: 'requalified',
      observed: 'present',
    });
    // Active: never erasable.
    expect(await witness(a)).toBe(false);
    writerRows = (
      await control.query<{ row: string }>(
        `select row_to_json(x)::text as row from knowledge.object_writers x where x.organization_id=$1 and x.source_id=$2`,
        [a.organizationId, a.sourceId],
      )
    ).rows.map((row) => row.row);
    expect(writerRows).toHaveLength(1);
    // Settled: restored later, it is a header 0205's purge proof (no active writer) admits, so that
    // only 0551's completion predicate can refuse it.
    expect(JSON.parse(writerRows[0]!)).toMatchObject({ state: 'settled' });
    const { purgeJobId } = await revoke(a);
    expect(await inventory(a)).toMatchObject({
      state: 'restore_debt',
      sealed: false,
      job: purgeJobId,
    });
    // Closed, but not purged: its object is not proven deleted and its headers remain.
    expect(a.bucket.objects.has(a.key)).toBe(true);
    expect(await claims(a)).toEqual([]);
    expect(await closureComplete(a)).toBe(false);
    expect(await witness(a)).toBe(false);
    expect(await purge(a)).toMatchObject({ state: 'completed' });
    expect(a.bucket.objects.has(a.key)).toBe(false);
    expect(await headers(a)).toEqual({ documents: 0, chunks: 0, writers: 0 });
    expect(await claims(a)).toMatchObject([{ state: 'proven', current: true }]);
    expect(await inventory(a)).toMatchObject({ state: 'restore_debt', sealed: false });
    // Closed and fully purged: the one predicate, the witness and the sweep all accept it.
    expect(await closureComplete(a)).toBe(true);
    expect(await materialComplete(a)).toBe(true);
    expect(await witness(a)).toBe(true);
    expect(await sweep(a)).toBe(0);
    expect(await job(a)).toMatchObject({ state: 'completed' });
  });

  it('accepts the observed closure of a source with a missing object the same way (finding 1)', async () => {
    o.bucket.objects.delete(o.key);
    expect(
      await recordRawRestoreActiveSourceClosure(app.db, o.bucket, o.service, o.sourceId),
    ).toEqual({ state: 'recorded', absentDocumentIds: [o.documentId] });
    await revoke(o);
    expect(await closureComplete(o)).toBe(false);
    expect(await witness(o)).toBe(false);
    expect(await purge(o)).toMatchObject({ state: 'completed' });
    expect(await headers(o)).toEqual({ documents: 0, chunks: 0, writers: 0 });
    expect(await closureComplete(o)).toBe(true);
    expect(await witness(o)).toBe(true);
    expect(await sweep(o)).toBe(0);
    expect(await job(o)).toMatchObject({ state: 'completed' });
  });

  it("routes a claim on never-sealed debt to 0516's raw branch, and a sealed survivor's to 0547's (finding 6)", async () => {
    // A's purge claim: a raw_source claim of this generation on a restore-debt inventory, which 0547
    // alone would have routed to its survivor branch, whose readiness needs the inventory sealed.
    const [claim] = await claims(a);
    expect(claim).toMatchObject({ state: 'proven', current: true });
    expect(await survivorClaim(a, claim!.id)).toBe(false);
    // 0516's raw branch proves it (the survivor branch could not: the inventory was never sealed).
    expect(await absent(a, claim!.id)).toBe(true);
    // S: a sealed inventory a restore left in debt, whose object survived. Its claim is the survivor's.
    expect(
      await deleteRawRestoreSurvivor(app.db, s.bucket, s.service, {
        sourceId: s.sourceId,
        documentId: s.documentId,
      }),
    ).toEqual({ state: 'deleted', source: { state: 'requalified', observed: 'absent' } });
    expect(s.bucket.objects.has(s.key)).toBe(false);
    const survivor = (await claims(s)).filter((row) => row.current);
    expect(survivor).toMatchObject([{ state: 'proven', current: true }]);
    expect(await survivorClaim(s, survivor[0]!.id)).toBe(true);
    // 0516's raw branch could not prove it (its inventory is not sealed in this generation, nor
    // never-sealed active-source debt), so this answer is 0547's survivor branch.
    expect(await absent(s, survivor[0]!.id)).toBe(true);
    // Each routing is per claim: A's claim, asked in S's tenant, is no claim at all.
    expect(await survivorClaim(s, claim!.id)).toBe(false);
  });

  it('refuses the witness and demotes the completion while a deletion claim is unresolved (finding 1)', async () => {
    // The state the witness test above left: completed, and complete in this generation.
    expect(await job(a)).toMatchObject({ state: 'completed' });
    const where = [a.organizationId, a.sourceId];
    const reopened = await asRestored<{ id: string }>(
      `update lifecycle.object_deletion_claims set state='unknown' where organization_id=$1 and kind='raw_source'
        and raw_source_id=$2 and state='proven' returning id`,
      where,
    );
    expect(reopened.rows).toHaveLength(1);
    try {
      expect(await closureComplete(a)).toBe(false);
      expect(await materialComplete(a)).toBe(false);
      expect(await witness(a)).toBe(false);
      expect(await sweep(a)).toBe(1);
      expect(await job(a)).toEqual({ state: 'failed', last_error_code: 'RAW_SOURCE_UNCONFIRMED' });
      // knowledge.purge_jobs' BEFORE triggers fire in name order: model_job_source_purge_guard (0216),
      // purge_jobs_0508_delete_proof (0508), purge_jobs_0515_generation (0515), purge_jobs_proof
      // (0205), then 0516's purge_jobs_raw_completion (0532's purge_jobs_absent_count, between them,
      // fires only on UPDATE OF blobs_absent). 0508's lifecycle.source_purge_delete_proof
      // (0508:327-337) refuses any completion while lifecycle.object_delete_counts (0508:312-324)
      // counts a claim of the tenant whose state is not 'proven'. What makes 0516's guard refuse an
      // unresolved claim is a claim of the same tenant whose state is not 'proven' too
      // (raw_active_closure_complete, 0551:279-281, and raw_document_material_complete, 0516:530-536),
      // so every claim that makes 0516 refuse here is one 0508 already counts: with every trigger in
      // place 0508 is always the first refuser of this scenario, and 0516 is unreachable. The error's
      // context names 0508's trigger function; materialComplete above is 0516's predicate, false.
      expect(await attributed(completeJob(a))).toEqual({
        code: 'EN850',
        reason: 'OBJECT_DELETE_UNCONFIRMED',
        raisedIn: 'source_purge_delete_proof',
      });
      // 0516's own trigger, asked with 0508's trigger alone turned off in a rolled-back transaction:
      // 0216's model-payload guard admits, 0515's does (the job's transcript and delegated-work proofs
      // are of this generation), 0205's does (no writer header is active), and
      // purge_jobs_raw_completion refuses the completion itself.
      expect(await completeAtTrigger(a, without0508)).toEqual({
        code: 'EN850',
        reason: 'RAW_SOURCE_UNCONFIRMED',
        raisedIn: 'guard_raw_purge_completion',
      });
      expect(await job(a)).toEqual({ state: 'failed', last_error_code: 'RAW_SOURCE_UNCONFIRMED' });
    } finally {
      await asRestored(
        `update lifecycle.object_deletion_claims set state='proven' where organization_id=$1 and id=any($2::uuid[])`,
        [a.organizationId, reopened.rows.map((row) => row.id)],
      );
    }
    expect(await closureComplete(a)).toBe(true);
    expect(await materialComplete(a)).toBe(true);
    expect(await witness(a)).toBe(true);
    // The same rolled-back transaction, 0508's trigger still off, once the claim is proven again:
    // 0516 admits the completion, so what it refused above was the unresolved claim, not the harness.
    expect(await completeAtTrigger(a, without0508)).toEqual({ completed: 1 });
    expect(await job(a)).toEqual({ state: 'failed', last_error_code: 'RAW_SOURCE_UNCONFIRMED' });
    expect(await complete(a)).toBeNull();
    expect(await sweep(a)).toBe(0);
    expect(await job(a)).toMatchObject({ state: 'completed' });
  });

  it('refuses the witness and demotes the completion while a writer header reappears (finding 1)', async () => {
    // The previous test completed it again. A demotion it left behind would carry next_retry_at,
    // which the sweep never selects again (0516:929), so this precondition is what makes the sweep
    // count below exact rather than an echo of an earlier failure.
    expect(await job(a)).toMatchObject({ state: 'completed' });
    expect(writerRows).toHaveLength(1);
    // Restored without triggers (session_replication_role=replica fires no user or FK trigger), so
    // nothing reacts to the insert itself: what demotes below is the sweep alone.
    await asRestored(
      `insert into knowledge.object_writers select * from json_populate_record(null::knowledge.object_writers,$1::json)`,
      [writerRows[0]],
    );
    try {
      expect(await headers(a)).toMatchObject({ writers: 1 });
      expect(await job(a)).toMatchObject({ state: 'completed' });
      expect(await closureComplete(a)).toBe(false);
      expect(await materialComplete(a)).toBe(false);
      expect(await witness(a)).toBe(false);
      expect(await sweep(a)).toBe(1);
      expect(await job(a)).toEqual({ state: 'failed', last_error_code: 'RAW_SOURCE_UNCONFIRMED' });
      // Every claim is proven, so 0508's purge_jobs_0508_delete_proof admits it; the job's transcript
      // proof is of this generation, so 0515's purge_jobs_0515_generation does; the header is
      // settled, so 0205's purge_jobs_proof does. 0516's purge_jobs_raw_completion, next in name
      // order, is what refuses it.
      expect(await complete(a)).toEqual({ code: 'EN850', reason: 'RAW_SOURCE_UNCONFIRMED' });
    } finally {
      await asRestored(
        'delete from knowledge.object_writers where organization_id=$1 and source_id=$2',
        [a.organizationId, a.sourceId],
      );
    }
    expect(await headers(a)).toEqual({ documents: 0, chunks: 0, writers: 0 });
    expect(await closureComplete(a)).toBe(true);
    expect(await materialComplete(a)).toBe(true);
    expect(await witness(a)).toBe(true);
    expect(await complete(a)).toBeNull();
    expect(await sweep(a)).toBe(0);
    expect(await job(a)).toMatchObject({ state: 'completed' });
  });

  it('stops accepting the completion once a later restore reopens the generation (finding 1)', async () => {
    // Immediately before the rotation: completed, complete in this generation, and never demoted by
    // a restore (the sweep's demotions above write no prior_completed_at, 0527).
    expect(await job(a)).toMatchObject({ state: 'completed' });
    expect(await witness(a)).toBe(true);
    expect(await materialComplete(a)).toBe(true);
    const certified = (await completion(a))!;
    expect(certified.completed).not.toBeNull();
    expect(certified.prior).toBeNull();
    await rotate();
    // The rotation demotes the completion itself, deterministically: 0515's
    // sovereign.rotate_material_restore_generation updates the generation and, in its next statement
    // (0515:36-37), fails every completed job of the tenant with
    // RESTORE_MATERIAL_REQUALIFICATION_REQUIRED, keeping the certificate's time as
    // prior_completed_at. 0516's proof-loss trigger on the generation runs only at commit (0542 made
    // it deferred precisely so that 0515's demotion wins) and then finds no completed job.
    const demoted = {
      state: 'failed',
      last_error_code: 'RESTORE_MATERIAL_REQUALIFICATION_REQUIRED',
    };
    expect(await job(a)).toEqual(demoted);
    expect(await completion(a)).toEqual({ completed: null, prior: certified.completed });
    // The organization marker requalified again for the new generation, so that what refuses below
    // is the closure itself: its proof and its deletion claims are of the previous generation.
    expect(await requalifyRawRestoreOrganization(app.db, a.service)).toEqual({
      state: 'requalified',
    });
    expect(await closureComplete(a)).toBe(false);
    expect(await materialComplete(a)).toBe(false);
    expect(await witness(a)).toBe(false);
    expect(await claims(a)).toMatchObject([{ state: 'proven', current: false }]);
    // The sweep demotes only a completion, or retries its own RAW_SOURCE_UNCONFIRMED failure (0516:928-929,
    // as 0543 and 0551 narrowed it): the rotation left neither, so it changes nothing and never
    // restores the completion.
    expect(await sweep(a)).toBe(0);
    expect(await job(a)).toEqual(demoted);
    // It cannot be completed again. In name order 0508's delete proof admits it (every claim is
    // proven, of the previous generation), and 0515's purge_jobs_0515_generation (0515:112-115) refuses
    // it first: its transcript proof is of the previous generation. The error's context names 0515's
    // trigger function.
    expect(await attributed(completeJob(a))).toEqual({
      code: 'EN119',
      reason: 'PURGE_RESTORE_REQUALIFICATION_REQUIRED',
      raisedIn: 'guard_purge_restore_generation',
    });
    // 0515 stops refusing once the purge's agent re-proves the job's transcripts and delegated work in
    // the new generation (0515:86-111), and 0516's guard must still refuse then: the raw material
    // proof is of the previous generation. The rolled-back transaction stamps exactly 0515's two
    // generation columns with the current generation, without triggers, in place of that re-proof;
    // every trigger is then back on, so 0216's model-payload guard, 0508's delete proof and 0515's
    // generation guard each run and admit, as does 0205's purge proof, and purge_jobs_raw_completion
    // refuses the completion itself. Nothing else of the job changes.
    const reproved = async (client: pg.Client) => {
      await client.query(`set local session_replication_role='replica'`);
      const stamped = await client.query(
        `update knowledge.purge_jobs j set transcript_restore_generation=o.material_restore_generation,
           delegated_work_restore_generation=o.material_restore_generation
         from org.organizations o where o.id=j.organization_id and j.organization_id=$1 and j.source_id=$2
          and j.transcript_restore_generation is distinct from o.material_restore_generation
          and j.delegated_work_restore_generation is distinct from o.material_restore_generation`,
        [a.organizationId, a.sourceId],
      );
      // Both proofs were of the previous generation: what 0515 refused above.
      expect(stamped.rowCount).toBe(1);
      await client.query(`set local session_replication_role='origin'`);
    };
    expect(await completeAtTrigger(a, reproved)).toEqual({
      code: 'EN850',
      reason: 'RAW_SOURCE_UNCONFIRMED',
      raisedIn: 'guard_raw_purge_completion',
    });
    // Positive control: the same fixture, the same rolled-back transaction, the same re-proof and the
    // same service UPDATE through completeAtTrigger, with the one thing 0516's guard found missing
    // carried into the new generation as well: A's raw material proof. 0551's
    // raw_active_closure_complete (0551:269-284) needs, in the current generation, the 0550 re-proof
    // that pins the closed debt (raw_active_source_closed through raw_active_source_proof_pinned,
    // 0551:164-219: a requalification of this generation over the inventory's prior one, the same
    // catalogue and write count) and a proven deletion claim of this generation for each catalogued
    // object (0516's raw_document_material_complete, 0516:522-537). Both rows are stamped with the
    // organization's current generation without triggers, as the re-proof above is; nothing else
    // changes. The guard then admits the completion, so what it refused above is the previous
    // generation's raw proof, not the fixture, the stamping harness or the ensemus_app service role.
    const reprovedWithRawProof = async (client: pg.Client) => {
      await reproved(client);
      await client.query(`set local session_replication_role='replica'`);
      const requalification = await client.query(
        `update lifecycle.raw_active_source_requalifications q set material_restore_generation=o.material_restore_generation
         from org.organizations o where o.id=q.organization_id and q.organization_id=$1 and q.source_id=$2
          and q.material_restore_generation is distinct from o.material_restore_generation`,
        [a.organizationId, a.sourceId],
      );
      // A's one re-proof, of the previous generation (requalifyRawRestoreActiveSource above).
      expect(requalification.rowCount).toBe(1);
      const deletion = await client.query(
        `update lifecycle.object_deletion_claims c set material_restore_generation=o.material_restore_generation
         from org.organizations o where o.id=c.organization_id and c.organization_id=$1 and c.kind='raw_source'
          and c.raw_source_id=$2 and c.state='proven' and c.material_restore_generation is distinct from o.material_restore_generation`,
        [a.organizationId, a.sourceId],
      );
      // A's one purge claim, proven in the previous generation (claims(a) above: current false).
      expect(deletion.rowCount).toBe(1);
      await client.query(`set local session_replication_role='origin'`);
    };
    expect(await completeAtTrigger(a, reprovedWithRawProof)).toEqual({ completed: 1 });
    // Both transactions were rolled back: the job is still the rotation's demotion, its claim still of
    // the previous generation.
    expect(await claims(a)).toMatchObject([{ state: 'proven', current: false }]);
    expect(await job(a)).toEqual(demoted);
    expect(await completion(a)).toEqual({ completed: null, prior: certified.completed });
    expect(await sweep(a)).toBe(0);
    expect(await job(a)).toEqual(demoted);
  });
});
