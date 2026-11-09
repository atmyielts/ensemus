// Raw Knowledge objects that survived a restore (0547, ADR-026 D3a), against real RLS, the real
// object-deletion authority and the native raw object port. FLAGGED FOR HUMAN SECURITY REVIEW, not yet
// reviewed by a person. The material restore generation is rotated the way the native restore rotates
// it, which is global: this file runs serially, as the whole integration project does
// (fileParallelism: false). Storage is an explicit memory test double; nothing here qualifies a provider.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  AppError,
  deleteRawRestoreSurvivor,
  requalifyRawRestoreOrganization,
  requalifyRawRestoreSource,
  type LedgerReader,
  type ObjectStore,
} from '@ensemus/application';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import { addUploadedSource, getSource } from '@ensemus/application/knowledge/sources';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { openAppDatabase, withTenantTx, type TenantContext } from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import { pgCode } from '../../packages/application/src/errors';
import {
  readRequalifications,
  reapplyCommand,
  runRequalifications,
} from '../../workers/workflow/src/reapply-command';
import { seedAiTenant } from '../helpers/ai/fixtures';
import { nativeKnowledgeStore, runNativeKnowledgePurge } from '../helpers/knowledge-native';
import { urls } from '../helpers/stack';

/** A memory bucket with the single-attempt and physical-absence capabilities the runtime store has. */
class Bucket implements ObjectStore, LedgerReader {
  objects = new Map<string, Buffer>();
  /** A DELETE that went through but whose capability could not be verified: never a proof. */
  unverified = false;
  deletes = 0;
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
    return bytes;
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deleteForPurge(
    key: string,
  ): Promise<{ transport: 'deleted'; capabilityVerified: boolean }> {
    this.deletes += 1;
    this.objects.delete(key);
    return { transport: 'deleted', capabilityVerified: !this.unverified };
  }
  async isPhysicallyAbsent(key: string) {
    return !this.objects.has(key);
  }
  async *listPages(prefix: string) {
    yield [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }
}

type Survivor = {
  bucket: Bucket;
  owner: TenantContext;
  service: TenantContext;
  organizationId: string;
  sourceId: string;
  documentId: string;
  version: number;
  jobId: string;
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

describe('raw objects that survived a restore (0547)', () => {
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
  /** 0516's tenant raw inventory predicate, the erasure witness's own check, read and rolled back. */
  const witness = async (f: Survivor) => {
    await migrator.query('begin');
    try {
      await migrator.query(`select set_config('app.organization_id',$1,true)`, [f.organizationId]);
      const result = await migrator.query<{ complete: boolean }>(
        'select lifecycle.raw_tenant_inventory_complete() complete',
      );
      return result.rows[0]?.complete;
    } finally {
      await migrator.query('rollback');
    }
  };
  const sourceComplete = async (f: Survivor) =>
    (
      await withTenantTx(app.db, f.service, (tx) =>
        tx.execute<{ complete: boolean }>(sql`select lifecycle.raw_source_material_complete(
          ${f.sourceId}::uuid,${f.version}::bigint,${f.jobId}::uuid,ai.current_material_restore_generation()) complete`),
      )
    ).rows[0]?.complete;
  /** Every deletion claim on the object, oldest first, with whether it is of the current generation. */
  const claims = async (f: Survivor) =>
    (
      await control.query<{ state: string; current: boolean }>(
        `select c.state,c.material_restore_generation=o.material_restore_generation as current
          from lifecycle.object_deletion_claims c join org.organizations o on o.id=c.organization_id
          where c.organization_id=$1 and c.object_key=$2 order by c.admitted_at,c.id`,
        [f.organizationId, f.key],
      )
    ).rows;
  const targetOf = async (f: Survivor, context = f.service) =>
    (
      await withTenantTx(app.db, context, (tx) =>
        tx.execute<{ target: Record<string, unknown> | null }>(
          sql`select lifecycle.raw_restore_survivor_delete_target(${f.sourceId}::uuid,${f.documentId}::uuid) as target`,
        ),
      )
    ).rows[0]?.target;
  const begin = (f: Survivor, target: unknown) =>
    withTenantTx(app.db, f.service, (tx) =>
      tx.execute(
        sql`select * from lifecycle.begin_object_deletion(${JSON.stringify(target)}::jsonb)`,
      ),
    );
  const erase = (f: Survivor, context = f.service) =>
    deleteRawRestoreSurvivor(app.db, f.bucket, context, {
      sourceId: f.sourceId,
      documentId: f.documentId,
    });

  /** A closed source whose one raw object was purged natively and proven, before the restore. */
  const prepare = async (title: string): Promise<Survivor> => {
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
    const { purgeJobId } = await revokeSource(app.db, tenant.owner, {
      sourceId: source.sourceId,
      expectedVersion: (await getSource(app.db, tenant.owner, source.sourceId)).version,
      reason: 'Generated closure before a restore',
    });
    expect(
      await runNativeKnowledgePurge({
        app: app.db,
        agent: agent.db,
        store,
        organizationId: tenant.organizationId,
        sourceId: source.sourceId,
      }),
    ).toMatchObject({ state: 'completed' });
    expect(bucket.objects.has(key)).toBe(false);
    const version = Number(
      (
        await control.query<{ version: string }>(
          'select version::text from knowledge.sources where organization_id=$1 and id=$2',
          [tenant.organizationId, source.sourceId],
        )
      ).rows[0]!.version,
    );
    return {
      bucket,
      owner: tenant.owner,
      service: createServiceContext(tenant.organizationId),
      organizationId: tenant.organizationId,
      sourceId: source.sourceId,
      documentId: source.documentId,
      version,
      jobId: purgeJobId,
      key,
      bytes: bytes!,
    };
  };

  // P is deleted and proven, U's first deletion is not proven, H is held. Separate tenants: each one's
  // debt and hold block only itself, and one rotation restores all three.
  let p: Survivor, u: Survivor, h: Survivor;

  it('prepares three closed sources whose raw objects were purged before the restore', async () => {
    p = await prepare('survivor proven');
    u = await prepare('survivor unproven');
    h = await prepare('survivor held');
    for (const f of [p, u, h]) {
      expect(await sourceComplete(f)).toBe(true);
      expect(await claims(f)).toEqual([{ state: 'proven', current: true }]);
    }
  });

  it('restores bytes the purge had deleted, which the existing proof reports and cannot record', async () => {
    await rotate();
    for (const f of [p, u, h]) {
      // The restored store brought the purged bytes back.
      f.bucket.objects.set(f.key, f.bytes);
      expect(await requalifyRawRestoreOrganization(app.db, f.service)).toEqual({
        state: 'requalified',
      });
      expect(await requalifyRawRestoreSource(app.db, f.bucket, f.service, f.sourceId)).toEqual({
        state: 'present',
        documentIds: [f.documentId],
      });
      expect(await sourceComplete(f)).toBe(false);
      // The earlier proven claim is the previous generation's history, not a proof for this one.
      expect(await claims(f)).toEqual([{ state: 'proven', current: false }]);
    }
    expect(await witness(p)).toBe(false);
  });

  it('refuses a pattern, a source or a whole tenant: one object, named by its IDs', async () => {
    const none = {
      'requalify-artifact': [],
      'requalify-archive': [],
      'requalify-source': [],
      'requalify-organization': [],
    };
    for (const given of [
      u.organizationId,
      `${u.organizationId}/${u.sourceId}`,
      `${u.organizationId}/${u.sourceId}/*`,
      `${u.organizationId}/*/${u.documentId}`,
      `${u.organizationId}/${u.sourceId}/${u.documentId}/${randomUUID()}`,
      `${u.organizationId}/${u.sourceId}/${u.documentId}`.toUpperCase(),
      'all',
    ]) {
      expect(() => readRequalifications({ ...none, 'delete-raw-survivor': [given] })).toThrow(
        'NOT_A_RESTORE_OBJECT',
      );
      expect(
        await reapplyCommand(['--delete-raw-survivor', given], {
          database: app.db,
          store: u.bucket,
        }),
      ).toBe(2);
    }
    expect(u.bucket.deletes).toBe(0);
    expect(u.bucket.objects.has(u.key)).toBe(true);
    // SQL has no wider form either: a target without its object, or with any key added, is refused,
    // and the target function names nothing without both IDs.
    const target = await targetOf(u);
    expect(target).toMatchObject({
      kind: 'raw_restore_survivor',
      sourceId: u.sourceId,
      documentId: u.documentId,
    });
    const wholeSource = Object.fromEntries(
      Object.entries(target!).filter(([name]) => name !== 'documentId'),
    );
    expect(await refusal(begin(u, wholeSource))).toEqual({
      code: 'EN850',
      reason: 'RAW_RESTORE_SURVIVOR_TARGET_REQUIRED',
    });
    expect(await refusal(begin(u, { ...target, scope: 'organization' }))).toEqual({
      code: 'EN850',
      reason: 'RAW_RESTORE_SURVIVOR_TARGET_REQUIRED',
    });
    // Not an ID at all: the cast refuses before anything is read.
    expect((await refusal(begin(u, { ...target, documentId: '*' })))?.code).toBe('22P02');
    expect(
      await refusal(
        withTenantTx(app.db, u.service, (tx) =>
          tx.execute(
            sql`select lifecycle.raw_restore_survivor_delete_target(${u.sourceId}::uuid,null)`,
          ),
        ),
      ),
    ).toMatchObject({ code: '42501', reason: 'RAW_RESTORE_SURVIVOR_SERVICE_REQUIRED' });
    expect(await claims(u)).toEqual([{ state: 'proven', current: false }]);
  });

  it('refuses a person, and a target from a stale generation', async () => {
    await expect(erase(u, u.owner)).rejects.toEqual(new AppError('FORBIDDEN'));
    expect(await refusal(targetOf(u, u.owner))).toMatchObject({
      code: '42501',
      reason: 'RAW_RESTORE_SURVIVOR_SERVICE_REQUIRED',
    });
    // The agent login inherits EXECUTE through ensemus_app (0547's postcondition note), so the
    // function's own session_user check is what must refuse it, even with a service actor.
    expect(
      await refusal(
        withTenantTx(agent.db, u.service, (tx) =>
          tx.execute(
            sql`select lifecycle.raw_restore_survivor_delete_target(${u.sourceId}::uuid,${u.documentId}::uuid)`,
          ),
        ),
      ),
    ).toMatchObject({ code: '42501', reason: 'RAW_RESTORE_SURVIVOR_SERVICE_REQUIRED' });
    const target = (await targetOf(u))!;
    // The previous generation's target, and debt claimed to be from this same generation.
    for (const stale of [
      { ...target, materialRestoreGeneration: target.priorMaterialRestoreGeneration },
      { ...target, priorMaterialRestoreGeneration: target.materialRestoreGeneration },
      { ...target, authRestoreGeneration: randomUUID() },
    ])
      expect(await refusal(begin(u, stale))).toEqual({
        code: 'EN850',
        reason: 'RAW_RESTORE_UNCONFIRMED',
      });
    // Another writer or generation than the object's own is not its target.
    for (const other of [
      { ...target, writeId: randomUUID() },
      { ...target, generation: Number(target.generation) + 1 },
    ])
      expect(await refusal(begin(u, other))).toEqual({
        code: 'EN850',
        reason: 'RAW_RESTORE_SURVIVOR_TARGET_REQUIRED',
      });
    expect(u.bucket.objects.has(u.key)).toBe(true);
    expect(await claims(u)).toEqual([{ state: 'proven', current: false }]);
  });

  it('never requalifies the source on a deletion that is not proven', async () => {
    // The DELETE reached the store, but its capability was not verified: the claim records a known
    // terminal DELETE and nothing proves the object absent.
    u.bucket.unverified = true;
    expect(await erase(u)).toEqual({ state: 'unconfirmed' });
    expect(u.bucket.deletes).toBe(1);
    expect(u.bucket.objects.has(u.key)).toBe(false);
    expect(await claims(u)).toEqual([
      { state: 'proven', current: false },
      { state: 'deleted', current: true },
    ]);
    // Every object is now absent, and still nothing is recorded: the deletion claim is unresolved.
    expect(
      await refusal(requalifyRawRestoreSource(app.db, u.bucket, u.service, u.sourceId)),
    ).toEqual({ code: 'EN850', reason: 'RAW_RESTORE_REQUALIFICATION_UNCONFIRMED' });
    expect(await sourceComplete(u)).toBe(false);
    expect(await witness(u)).toBe(false);
    // The same claim is never admitted again, and a second DELETE is never sent: only the
    // independent absence check may be retried after a known terminal DELETE.
    u.bucket.unverified = false;
    expect(await erase(u)).toMatchObject({
      state: 'deleted',
      source: { state: 'requalified', observed: 'absent' },
    });
    expect(u.bucket.deletes).toBe(1);
    expect(await claims(u)).toEqual([
      { state: 'proven', current: false },
      { state: 'proven', current: true },
    ]);
    expect(await sourceComplete(u)).toBe(true);
  });

  it('refuses a held tenant and deletes nothing until the hold is released', async () => {
    const hold = await placeLegalHold(app.db, h.owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    expect(await erase(h)).toEqual({ state: 'held' });
    const [outcome] = await runRequalifications(
      app.db,
      h.bucket,
      readRequalifications({
        'requalify-artifact': [],
        'requalify-archive': [],
        'requalify-source': [],
        'requalify-organization': [],
        'delete-raw-survivor': [`${h.organizationId}/${h.sourceId}/${h.documentId}`],
      }),
    );
    expect(outcome).toMatchObject({ state: 'held' });
    expect(outcome?.deleted).toBeUndefined();
    expect(h.bucket.deletes).toBe(0);
    expect(h.bucket.objects.has(h.key)).toBe(true);
    expect(await claims(h)).toEqual([{ state: 'proven', current: false }]);
    expect(await sourceComplete(h)).toBe(false);
    await releaseLegalHold(app.db, h.owner, {
      holdId: hold.holdId,
      expectedVersion: 1,
      reasonCode: 'GENERATED_TEST_RELEASE',
    });
  });

  it('refuses a source that is not in restore debt', async () => {
    // Born after the restore, natively, and closed: its inventory is this generation's, not debt.
    const store = nativeKnowledgeStore(app.db, h.bucket);
    const fresh = await addUploadedSource(app.db, store, h.owner, {
      title: 'born after the restore',
      mediaType: 'text/plain',
      body: Buffer.from('Generated born after the restore.'),
      classification: 'internal',
      grants: [],
    });
    const { purgeJobId } = await revokeSource(app.db, h.owner, {
      sourceId: fresh.sourceId,
      expectedVersion: (await getSource(app.db, h.owner, fresh.sourceId)).version,
      reason: 'Generated closure after the restore',
    });
    const freshKey = knowledgeObjectKey(h.organizationId, fresh.documentId);
    expect(h.bucket.objects.has(freshKey)).toBe(true);
    const f: Survivor = {
      ...h,
      sourceId: fresh.sourceId,
      documentId: fresh.documentId,
      key: freshKey,
    };
    expect(await targetOf(f)).toBeNull();
    expect(await erase(f)).toEqual({ state: 'unconfirmed' });
    // Nor a source this tenant does not have.
    expect(await erase({ ...f, sourceId: randomUUID() })).toEqual({ state: 'unconfirmed' });
    // A target forged from the real survivor's generations, naming the fresh source exactly.
    const real = (await targetOf(h))!;
    const version = (
      await control.query<{ version: string }>(
        'select version::text from knowledge.sources where organization_id=$1 and id=$2',
        [h.organizationId, fresh.sourceId],
      )
    ).rows[0]!.version;
    expect(
      await refusal(
        begin(f, {
          ...real,
          sourceId: fresh.sourceId,
          sourceVersion: version,
          purgeJobId,
          documentId: fresh.documentId,
          writeId: randomUUID(),
        }),
      ),
    ).toEqual({ code: 'EN850', reason: 'RAW_RESTORE_DEBT_REQUIRED' });
    expect(h.bucket.deletes).toBe(0);
    expect(h.bucket.objects.has(freshKey)).toBe(true);
    expect(await claims(f)).toEqual([]);
  });

  it('deletes a present survivor, proves it, requalifies its source and lets the witness complete', async () => {
    expect(await witness(p)).toBe(false);
    const outcomes = await runRequalifications(
      app.db,
      p.bucket,
      readRequalifications({
        'requalify-artifact': [],
        'requalify-archive': [],
        'requalify-source': [],
        'requalify-organization': [],
        'delete-raw-survivor': [`${p.organizationId}/${p.sourceId}/${p.documentId}`],
      }),
    );
    expect(outcomes).toEqual([
      {
        request: {
          kind: 'survivor',
          organizationId: p.organizationId,
          sourceId: p.sourceId,
          documentId: p.documentId,
        },
        state: 'requalified',
        observed: 'absent',
        deleted: true,
      },
    ]);
    expect(p.bucket.deletes).toBe(1);
    expect(p.bucket.objects.has(p.key)).toBe(false);
    expect(await claims(p)).toEqual([
      { state: 'proven', current: false },
      { state: 'proven', current: true },
    ]);
    expect(await sourceComplete(p)).toBe(true);
    expect(await witness(p)).toBe(true);
    // Running it again proves the same claim again: no second claim and no second DELETE.
    expect(await erase(p)).toEqual({
      state: 'deleted',
      source: { state: 'requalified', observed: 'absent' },
    });
    expect(p.bucket.deletes).toBe(1);
    expect(await claims(p)).toHaveLength(2);
    expect(await witness(p)).toBe(true);
  });

  it('deletes the held survivor once the hold is gone, through the same path', async () => {
    expect(await erase(h)).toMatchObject({
      state: 'deleted',
      source: { state: 'requalified', observed: 'absent' },
    });
    expect(h.bucket.objects.has(h.key)).toBe(false);
    expect(await sourceComplete(h)).toBe(true);
  });
});
