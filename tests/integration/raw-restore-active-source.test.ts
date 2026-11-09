// An ACTIVE Knowledge source a restore left in raw debt (check finding 6, 0550), against real RLS, the
// real raw object authority and the native raw object port. FLAGGED FOR HUMAN SECURITY REVIEW, not yet
// reviewed by a person. The material restore generation is rotated the way the native restore rotates
// it, which is global: this file runs serially, as the whole integration project does
// (fileParallelism: false). Storage is an explicit memory test double; nothing here qualifies a provider.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  AppError,
  requalifyRawRestoreActiveSource,
  requalifyRawRestoreOrganization,
  type ObjectStore,
} from '@ensemus/application';
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
import { pgCode } from '../../packages/application/src/errors';
import {
  readRequalifications,
  runRequalifications,
} from '../../workers/workflow/src/reapply-command';
import { seedAiTenant } from '../helpers/ai/fixtures';
import { nativeKnowledgeStore, runNativeKnowledgePurge } from '../helpers/knowledge-native';
import { repoRoot, urls } from '../helpers/stack';

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

type Active = {
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
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const SECOND_VERSION = Buffer.from('Generated second version, written after the restore.');

describe('an active source a restore left in raw debt (0550)', () => {
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

  /** The native restore's material rotation, exactly as raw-restore-survivors.test.ts drives it. */
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
  /** The source's raw inventory, read as the superuser. */
  const inventory = async (f: Active) =>
    (
      await control.query<{ state: string; sealed: boolean; job: string | null; current: boolean }>(
        `select i.state,i.sealed_at is not null sealed,i.purge_job_id::text job,
          i.material_restore_generation=o.material_restore_generation current
         from lifecycle.raw_source_inventories i join org.organizations o on o.id=i.organization_id
         where i.organization_id=$1 and i.scope_kind='source' and i.source_id=$2`,
        [f.organizationId, f.sourceId],
      )
    ).rows[0];
  const proofs = async (f: Active) =>
    (
      await control.query<{ documents: string[]; current: boolean }>(
        `select q.document_ids::text[] documents,q.material_restore_generation=o.material_restore_generation current
         from lifecycle.raw_active_source_requalifications q join org.organizations o on o.id=q.organization_id
         where q.organization_id=$1 and q.source_id=$2`,
        [f.organizationId, f.sourceId],
      )
    ).rows;
  const version = async (f: Active) => (await getSource(app.db, f.owner, f.sourceId)).version;
  const revoke = async (f: Active) =>
    revokeSource(app.db, f.owner, {
      sourceId: f.sourceId,
      expectedVersion: await version(f),
      reason: 'Generated closure after a restore',
    });
  const newVersion = async (f: Active) =>
    addDocumentVersion(app.db, nativeKnowledgeStore(app.db, f.bucket), f.owner, {
      sourceId: f.sourceId,
      expectedVersion: await version(f),
      title: 'Generated second version',
      mediaType: 'text/plain',
      body: SECOND_VERSION,
    });
  const observe = (f: Active, documents: string[], hashes: string[], sizes: number[]) =>
    withTenantTx(app.db, f.service, (tx) =>
      tx.execute(sql`select lifecycle.requalify_raw_restore_active_source(${f.sourceId}::uuid,
        ${`{${documents.join(',')}}`}::uuid[],${`{${hashes.join(',')}}`}::text[],${`{${sizes.join(',')}}`}::bigint[])`),
    );

  /** An open source with one raw object, uploaded natively before the restore. */
  const prepare = async (title: string): Promise<Active> => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const bucket = new Bucket();
    const source = await addUploadedSource(
      app.db,
      nativeKnowledgeStore(app.db, bucket),
      tenant.owner,
      {
        title,
        mediaType: 'text/plain',
        body: Buffer.from(`Generated ${title}.`),
        classification: 'internal',
        grants: [],
      },
    );
    const key = knowledgeObjectKey(tenant.organizationId, source.documentId);
    const bytes = bucket.objects.get(key);
    expect(bytes).toBeDefined();
    return {
      bucket,
      owner: tenant.owner,
      service: createServiceContext(tenant.organizationId),
      organizationId: tenant.organizationId,
      sourceId: source.sourceId,
      documentId: source.documentId,
      key,
      bytes: bytes!,
    };
  };

  // A is requalified and then closed; B's tenant marker is never requalified.
  let a: Active, b: Active;

  it('prepares two open sources before the restore', async () => {
    a = await prepare('active source requalified');
    b = await prepare('active source unrequalified');
    for (const f of [a, b])
      expect(await inventory(f)).toMatchObject({ state: 'open', sealed: false, current: true });
  });

  it('reproduces finding 6: after a restore the open source can neither be closed nor written to', async () => {
    await rotate();
    for (const f of [a, b]) {
      expect(await inventory(f)).toMatchObject({ state: 'restore_debt', current: false });
      expect(await requalifyRawRestoreOrganization(app.db, f.service)).toEqual({
        state: 'requalified',
      });
    }
    // 0516: the closure's purge job moves a non-native inventory to 'legacy', which the guard refuses,
    // so the whole closure rolls back and the source stays open.
    expect(await refusal(revoke(a))).toEqual({ code: '42501', reason: 'RAW_INVENTORY_IMMUTABLE' });
    expect((await getSource(app.db, a.owner, a.sourceId)).state).toBe('active');
    // A new version's writer needs the inventory open in this generation.
    expect(await refusal(newVersion(a))).toEqual({
      code: 'EN850',
      reason: 'RAW_LEGACY_WRITER_UNCONFIRMED',
    });
    // A source born after the restore is not in debt: 0545's marker re-proof admits it natively.
    const fresh = await addUploadedSource(app.db, nativeKnowledgeStore(app.db, a.bucket), a.owner, {
      title: 'born after the restore',
      mediaType: 'text/plain',
      body: Buffer.from('Generated born after the restore.'),
      classification: 'internal',
      grants: [],
    });
    expect(a.bucket.objects.has(knowledgeObjectKey(a.organizationId, fresh.documentId))).toBe(true);
    // Not in debt, so this path names nothing for it and records nothing.
    expect(
      await requalifyRawRestoreActiveSource(app.db, a.bucket, a.service, fresh.sourceId),
    ).toEqual({ state: 'unconfirmed' });
    expect(
      await refusal(
        withTenantTx(app.db, a.service, (tx) =>
          tx.execute(
            sql`select lifecycle.requalify_raw_restore_active_source(${fresh.sourceId}::uuid,'{}'::uuid[],'{}'::text[],'{}'::bigint[])`,
          ),
        ),
      ),
    ).toEqual({ code: 'EN850', reason: 'RAW_RESTORE_DEBT_REQUIRED' });
  });

  it('refuses a person and the agent login before reading anything', async () => {
    await expect(
      requalifyRawRestoreActiveSource(app.db, a.bucket, a.owner, a.sourceId),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    expect(
      await refusal(
        withTenantTx(app.db, a.owner, (tx) =>
          tx.execute(
            sql`select lifecycle.raw_active_restore_requalification_documents(${a.sourceId}::uuid)`,
          ),
        ),
      ),
    ).toEqual({ code: '42501', reason: 'RAW_ACTIVE_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' });
    // The agent login inherits EXECUTE through ensemus_app, so each function's opening session_user
    // check is what refuses it, even with a service actor.
    for (const statement of [
      sql`select lifecycle.raw_active_restore_requalification_documents(${a.sourceId}::uuid)`,
      sql`select lifecycle.requalify_raw_restore_active_source(${a.sourceId}::uuid,${`{${a.documentId}}`}::uuid[],${`{${sha256(a.bytes)}}`}::text[],${`{${a.bytes.length}}`}::bigint[])`,
    ])
      expect(
        await refusal(withTenantTx(agent.db, a.service, (tx) => tx.execute(statement))),
      ).toEqual({ code: '42501', reason: 'RAW_ACTIVE_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' });
    expect(await proofs(a)).toEqual([]);
  });

  it('records nothing for a missing, changed, extra or partial observation', async () => {
    // Missing: the store itself reports the object physically absent.
    a.bucket.objects.delete(a.key);
    expect(await requalifyRawRestoreActiveSource(app.db, a.bucket, a.service, a.sourceId)).toEqual({
      state: 'missing',
      documentIds: [a.documentId],
    });
    // Changed: present, with other bytes.
    a.bucket.objects.set(a.key, Buffer.from('Generated other bytes.'));
    expect(
      await refusal(requalifyRawRestoreActiveSource(app.db, a.bucket, a.service, a.sourceId)),
    ).toEqual({ code: 'EN850', reason: 'RAW_ACTIVE_RESTORE_REQUALIFICATION_UNCONFIRMED' });
    a.bucket.objects.set(a.key, a.bytes);
    const hash = sha256(a.bytes);
    for (const [documents, hashes, sizes] of [
      [[], [], []],
      [[a.documentId], [hash], [a.bytes.length + 1]],
      [[a.documentId], ['0'.repeat(64)], [a.bytes.length]],
      [
        [a.documentId, a.documentId],
        [hash, hash],
        [a.bytes.length, a.bytes.length],
      ],
      [
        [a.documentId, randomUUID()],
        [hash, hash],
        [a.bytes.length, a.bytes.length],
      ],
    ] as [string[], string[], number[]][])
      expect(await refusal(observe(a, documents, hashes, sizes))).toEqual({
        code: 'EN850',
        reason: 'RAW_ACTIVE_RESTORE_REQUALIFICATION_UNCONFIRMED',
      });
    expect(await proofs(a)).toEqual([]);
    expect(await refusal(revoke(a))).toEqual({ code: '42501', reason: 'RAW_INVENTORY_IMMUTABLE' });
  });

  it('records the proof once every catalogued object is present, the same proof on a re-run', async () => {
    const outcomes = await runRequalifications(
      app.db,
      a.bucket,
      readRequalifications({
        'requalify-artifact': [],
        'requalify-archive': [],
        'requalify-source': [],
        'requalify-organization': [],
        'requalify-active-source': [`${a.organizationId}/${a.sourceId}`],
      }),
    );
    expect(outcomes).toEqual([
      {
        request: { kind: 'active_source', organizationId: a.organizationId, sourceId: a.sourceId },
        state: 'requalified',
        observed: 'present',
      },
    ]);
    expect(await requalifyRawRestoreActiveSource(app.db, a.bucket, a.service, a.sourceId)).toEqual({
      state: 'requalified',
      observed: 'present',
    });
    expect(await proofs(a)).toEqual([{ documents: [a.documentId], current: true }]);
    // The inventory row itself is unchanged: its generation is immutable.
    expect(await inventory(a)).toMatchObject({ state: 'restore_debt', current: false, job: null });
  });

  it('writes a new version natively once requalified, and never an older object again', async () => {
    // The version the refused attempt left behind is resumed by the same upload.
    const second = await newVersion(a);
    expect(second.unchanged).toBe(true);
    const secondKey = knowledgeObjectKey(a.organizationId, second.documentId);
    expect(a.bucket.objects.get(secondKey)).toEqual(SECOND_VERSION);
    expect(a.bucket.objects.get(a.key)).toEqual(a.bytes);
    // The proof still matches: nothing of an earlier generation was added.
    expect(await proofs(a)).toEqual([{ documents: [a.documentId], current: true }]);
  });

  it('closes the requalified source, keeping its raw debt owed and unsealed', async () => {
    const { purgeJobId } = await revoke(a);
    expect((await getSource(app.db, a.owner, a.sourceId)).state).toBe('revoked');
    expect(await inventory(a)).toMatchObject({
      state: 'restore_debt',
      sealed: false,
      job: purgeJobId,
      current: false,
    });
    // Its older bytes are restore debt no 0516, 0543 or 0547 proof accepts while unsealed, so the
    // purge does not complete and they stay (0550's header: a separately reviewed path is owed).
    expect(
      await runNativeKnowledgePurge({
        app: app.db,
        agent: agent.db,
        store: nativeKnowledgeStore(app.db, a.bucket),
        organizationId: a.organizationId,
        sourceId: a.sourceId,
      }),
    ).toMatchObject({ state: 'failed' });
    expect(a.bucket.objects.has(a.key)).toBe(true);
    // A closed source is not re-proven as active again.
    expect(await refusal(observe(a, [a.documentId], [sha256(a.bytes)], [a.bytes.length]))).toEqual({
      code: 'EN850',
      reason: 'RAW_ACTIVE_SOURCE_REQUIRED',
    });
  });

  it('still refuses to close a debt source whose re-proof was never recorded', async () => {
    expect(await proofs(b)).toEqual([]);
    expect(await refusal(revoke(b))).toEqual({ code: '42501', reason: 'RAW_INVENTORY_IMMUTABLE' });
    expect(await refusal(newVersion(b))).toEqual({
      code: 'EN850',
      reason: 'RAW_LEGACY_WRITER_UNCONFIRMED',
    });
  });

  it("refuses a tenant whose marker was not re-proven, and 0550's postcondition its own redefinition", async () => {
    // A new rotation makes every earlier proof stale, B's marker included. Without re-proving the
    // marker in this generation, the source cannot be re-proven.
    await rotate();
    expect(await refusal(observe(b, [b.documentId], [sha256(b.bytes)], [b.bytes.length]))).toEqual({
      code: 'EN850',
      reason: 'RAW_ORG_RESTORE_REQUALIFICATION_REQUIRED',
    });
    expect(await proofs(b)).toEqual([]);
    // 0550's own postcondition refuses an entry point that does anything before its refusal.
    const statements = readFileSync(
      join(repoRoot, 'packages/database/migrations/0550_raw_restore_active_source_r8restore.sql'),
      'utf8',
    ).split('--> statement-breakpoint');
    const postcondition = statements.at(-1)!;
    await migrator.query('begin');
    try {
      await migrator.query(postcondition);
      const { rows } = await migrator.query<{ definition: string }>(
        `select pg_get_functiondef('lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[])'::regprocedure) definition`,
      );
      await migrator.query(
        rows[0]!.definition.replace(/\r?\nBEGIN\r?\n/, '\nBEGIN\n PERFORM 1;\n'),
      );
      await expect(migrator.query(postcondition)).rejects.toMatchObject({
        code: 'EN850',
        message: 'RAW_ACTIVE_RESTORE_POSTCONDITION',
      });
    } finally {
      await migrator.query('rollback');
    }
  });
});
