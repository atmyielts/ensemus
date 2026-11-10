//0415 source-authored real-role/driver tests. No live provider claim: storage is an explicit private
// test double; PostgreSQL, native identity, encrypted parser, receipts and SQL fences are actual.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createOrganization,
  openAppDatabase,
  withTenantTx,
  artifacts,
  workArtifacts,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { openAgentDatabase } from '@ensemus/database/agent';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import {
  requestOrganizationImport,
  runOrganizationImport,
  SOURCE_PORTABILITY_SECTIONS,
  listImportedArchiveFiles,
  readImportedArchiveFile,
  createImportedArchivePurge,
  createArchiveQuarantineRecovery,
  createWorkUnit,
  addArtifact,
  type ArchiveQuarantineLifecycle,
} from '@ensemus/application';
import {
  addUploadedSource,
  setSourceGrants,
  raiseSourceClassification,
} from '@ensemus/application/knowledge/sources';
import {
  deleteSource,
  failSourcePurge,
  purgeRunTranscriptsForSource,
  runSourcePurge,
} from '@ensemus/application/knowledge/purge';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import {
  confirmDelegatedWorkPurgeInTx,
  createDelegatedWorkPurge,
} from '@ensemus/application/knowledge/delegated-work-purge';
import { withRawKnowledgeObjects } from '@ensemus/application/knowledge/raw-objects';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { createObjectDeletionLifecycle } from '@ensemus/application/saas/object-deletion';
import { makePerson, nativePersonContext, proveSecondFactor } from '../helpers/product';
import { testRecipient } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { buildArchive } from './fixtures/archive-builder';
import {
  PORTABILITY_INVENTORY,
  PORTABILITY_INVENTORY_VERSION,
  PORTABILITY_INVENTORY_V1,
  LEGACY_PORTABILITY_INVENTORY_VERSION,
  PORTABILITY_INVENTORY_V2,
  PORTABILITY_INVENTORY_V2_VERSION,
} from '@ensemus/domain/portability';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
class PrivateStore {
  objects = new Map<string, Buffer>();
  puts = 0;
  failPut = false;
  failReadback = false;
  beforeGet: (() => Promise<void>) | undefined;
  async put(key: string, body: Buffer) {
    this.puts++;
    if (this.failPut) throw new Error('GENERATED_UNKNOWN_PUT');
    this.objects.set(key, Buffer.from(body));
  }
  async get(key: string, max?: number) {
    const hook = this.beforeGet;
    this.beforeGet = undefined;
    await hook?.();
    if (this.failReadback) throw new Error('GENERATED_GET_FAILED');
    const bytes = this.objects.get(key);
    if (!bytes || (max !== undefined && bytes.length > max))
      throw new Error('GENERATED_BYTES_UNAVAILABLE');
    return bytes;
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  // Test-only single-attempt memory transports for the native raw-Knowledge and admitted-deletion
  // protocols, as in saas-lifecycle-fixture. They prove orchestration and SQL, never S3 capability.
  async putSingleAttempt(key: string, body: Buffer): Promise<{ transport: 'written' }> {
    this.objects.set(key, Buffer.from(body));
    return { transport: 'written' };
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
describe('inert archive file custody', () => {
  let app: ReturnType<typeof openAppDatabase>,
    agent: ReturnType<typeof openAgentDatabase>,
    control: pg.Client,
    auth: pg.Client;
  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 4 });
    agent = openAgentDatabase(urls.agent(), { max: 1 });
    control = new pg.Client({ connectionString: urls.superuser() });
    auth = new pg.Client({ connectionString: urls.auth() });
    await control.connect();
    await auth.connect();
  });
  afterAll(async () => {
    await app.close();
    await agent.close();
    await control.end();
    await auth.end();
  });
  const owner = async () => {
    const person = await makePerson('archive-custodian'),
      created = await createOrganization(app.db, {
        userId: person.userId,
        name: 'Generated archive custody',
        commercialMode: 'sovereign',
      });
    return {
      ...person,
      context: await nativePersonContext(app.db, person, created.organizationId),
    };
  };
  const fixture = async (profile: string | null = null) => {
    const person = await owner(),
      view = await requestOrganizationImport(app.db, person.context),
      // Composed as the worker composes its store: raw Knowledge bytes only through the native port.
      store = withRawKnowledgeObjects({ database: app.db, store: new PrivateStore() }),
      recipient = testRecipient();
    const sourceId = randomUUID(),
      bytes = Buffer.from('GENERATED archive bytes, with no assertion of trusted original inputs.'),
      record = {
        kind: 'artifact',
        id: sourceId,
        name: 'Generated review.txt',
        mime_type: 'text/plain',
        size_bytes: bytes.length,
        sha256: digest(bytes),
        classification: 'internal',
        created_by_membership_id: randomUUID(),
        created_at: '2026-11-07T00:00:00.000Z',
      };
    const archive = buildArchive(
      recipient,
      {
        pages: [{ section: 'artifacts', recordKind: 'artifact', records: [record] }],
        files: { [sourceId]: bytes },
      },
      profile
        ? ({ manifest }) => ({
            manifest: {
              ...manifest,
              schema_version: 2,
              inventory_version: profile,
              inventory:
                profile === PORTABILITY_INVENTORY_VERSION
                  ? PORTABILITY_INVENTORY
                  : profile === PORTABILITY_INVENTORY_V2_VERSION
                    ? PORTABILITY_INVENTORY_V2
                    : PORTABILITY_INVENTORY_V1,
              generated_bodies_excluded: 0,
              ...(profile === PORTABILITY_INVENTORY_VERSION ? { record_max_bytes: 4194304 } : {}),
            },
          })
        : undefined,
    );
    const service = createServiceContext(person.context.organizationId);
    const run = (database: AppDatabase = app.db) =>
      runOrganizationImport(
        database,
        service,
        {
          importId: view.id,
          archive: archive.reader,
          recipientPrivateKeyPem: recipient.privateKeyPem,
        },
        { sections: SOURCE_PORTABILITY_SECTIONS, store, ledger: store },
      );
    const read = () =>
      readImportedArchiveFile(app.db, store, person.context, {
        importId: view.id,
        sourceArtifactId: sourceId,
      });
    const headers = async () =>
      (
        await control.query<{
          object_key: string;
          write_token: string;
          state: string;
          write_state: string;
          physical_purged_at: Date | null;
        }>(
          'select object_key,write_token,state,write_state,physical_purged_at from sovereign.imported_archive_files where organization_id=$1 and import_id=$2',
          [person.context.organizationId, view.id],
        )
      ).rows;
    return { person, view, store, sourceId, bytes, record, archive, service, run, read, headers };
  };
  const source = async (input: Awaited<ReturnType<typeof fixture>>) =>
    addUploadedSource(app.db, input.store, input.person.context, {
      title: 'Generated source',
      mediaType: 'text/plain',
      body: Buffer.from('Generated source content'),
      classification: 'internal',
      grants: [{ kind: 'membership', membershipId: input.person.context.membershipId }],
    });
  // The production archive lifecycle: SQL deletion admission, legal-hold check, one DELETE and an
  // independent absence check, which together leave the retained proof the purge receipt requires.
  const lifecycle = (store: PrivateStore): ArchiveQuarantineLifecycle =>
    createObjectDeletionLifecycle({ database: app.db, store }).archive;
  const closedSource = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const added = await source(f);
    await deleteSource(app.db, f.person.context, {
      sourceId: added.sourceId,
      expectedVersion: 1,
      reason: 'Generated source closure',
    });
    // The actual agent role and actual ledger adapter prove the real (empty) source-run inventory.
    await purgeRunTranscriptsForSource(
      agent.db,
      f.service,
      {
        transcripts: createRunTranscriptPurge(),
      },
      { sourceId: added.sourceId },
    );
    // The actual agent-role delegated-Work purge records its current-generation proof, as the
    // knowledge worker does before the source purge. Nothing here is seeded or stubbed.
    expect(
      await createDelegatedWorkPurge({
        database: agent.db,
        accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
      }).purgeSource(f.service, { sourceId: added.sourceId, limit: 25 }),
    ).toMatchObject({ confirmed: true, remaining: 0, controlsRemaining: 0 });
    // Deliberately optimistic older-runtime double: it knows nothing about the new private archive
    // table. These tests require SQL to refuse its false zero, never accept it as lifecycle evidence.
    const oldArtifactPort = {
      purgeSource: async () => ({ removed: 0, remaining: 0, held: 0, confirmed: true }),
      confirmInTx: async () => ({ remaining: 0 }),
    };
    const purge = () =>
      runSourcePurge(
        app.db,
        f.store,
        f.service,
        {
          sourceId: added.sourceId,
        },
        {
          derivedArtifacts: oldArtifactPort,
          delegatedWorks: { confirmInTx: confirmDelegatedWorkPurgeInTx },
        },
      );
    const job = async () =>
      (
        await control.query<{
          state: string;
          completed_at: Date | null;
          last_error_code: string | null;
        }>(
          'select state,completed_at,last_error_code from knowledge.purge_jobs where organization_id=$1 and source_id=$2',
          [f.person.context.organizationId, added.sourceId],
        )
      ).rows[0]!;
    return { ...added, purge, job };
  };
  it.each([
    null,
    LEGACY_PORTABILITY_INVENTORY_VERSION,
    PORTABILITY_INVENTORY_V2_VERSION,
    PORTABILITY_INVENTORY_VERSION,
  ])('keeps verified files inert for profile %s', async (profile) => {
    const f = await fixture(profile);
    expect(await f.run()).toMatchObject({
      status: 'completed_with_warnings',
      warningCounts: { FILES_AWAIT_REVIEW: 1 },
    });
    expect((await f.read()).bytes).toEqual(f.bytes);
    expect(
      await withTenantTx(app.db, f.person.context, (tx) => tx.select().from(artifacts)),
    ).toEqual([]);
    expect(
      await withTenantTx(app.db, f.person.context, (tx) => tx.select().from(workArtifacts)),
    ).toEqual([]);
    expect(await f.headers()).toEqual([
      expect.objectContaining({
        state: 'quarantined',
        write_state: 'settled',
        physical_purged_at: null,
      }),
    ]);
    expect([...f.store.objects.keys()][0]).toMatch(
      new RegExp(
        `^${f.person.context.organizationId}/archive-quarantine/${f.view.id}/${f.sourceId}/[0-9a-f-]{36}$`,
      ),
    );
  });
  it('requires an actual human reupload to create a new ordinary artifact and Work link', async () => {
    const f = await fixture();
    await f.run();
    const reviewed = await f.read(),
      work = await createWorkUnit(app.db, f.person.context, {
        title: 'Generated reviewed attachment',
      });
    const uploaded = await addArtifact(app.db, f.store, f.person.context, {
      workUnitId: work.id,
      name: reviewed.name,
      mimeType: reviewed.mimeType,
      body: reviewed.bytes,
    });
    expect(uploaded.id).not.toBe(f.sourceId);
    expect(
      await withTenantTx(app.db, f.person.context, (tx) => tx.select().from(workArtifacts)),
    ).toEqual([expect.objectContaining({ workUnitId: work.id, artifactId: uploaded.id })]);
  });
  it('denies direct table access and foreign-tenant reads', async () => {
    const f = await fixture();
    await f.run();
    const other = await owner();
    await expect(
      withTenantTx(app.db, f.person.context, (tx) =>
        tx.execute(sql`select object_key,write_token from sovereign.imported_archive_files`),
      ),
    ).rejects.toThrow();
    await expect(
      readImportedArchiveFile(app.db, f.store, other.context, {
        importId: f.view.id,
        sourceArtifactId: f.sourceId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listImportedArchiveFiles(app.db, other.context, { importId: f.view.id })).toEqual(
      [],
    );
  });
  it('refuses changed bytes at native download and reports restore corruption', async () => {
    const f = await fixture();
    await f.run();
    const [header] = await f.headers();
    f.store.objects.set(header!.object_key, Buffer.alloc(f.bytes.length, 0));
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const report = await createArchiveQuarantineRecovery(f.store).reconcile(app.db, f.service);
    expect(report.needsAttention).toBeGreaterThan(0);
    expect((await f.headers())[0]).toMatchObject({
      state: 'closing',
      write_state: 'settled',
      physical_purged_at: null,
    });
  });
  it('does not resend an unknown put even when storage currently reports no object', async () => {
    const f = await fixture();
    f.store.failPut = true;
    expect(await f.run()).toMatchObject({ status: 'failed', failureCode: 'STORE_UNAVAILABLE' });
    f.store.failPut = false;
    expect(await f.run()).toMatchObject({ status: 'failed', failureCode: 'RECORD_REFUSED' });
    expect(f.store.puts).toBe(1);
    const purge = createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: lifecycle(f.store),
    });
    expect(await purge.purgeTenant(f.service, { limit: 25 })).toMatchObject({
      remaining: 1,
      confirmed: false,
    });
    expect((await f.headers())[0]).toMatchObject({
      state: 'closing',
      write_state: 'active',
      physical_purged_at: null,
    });
    const token = (await f.headers())[0]!.write_token;
    const nullProof = await withTenantTx(app.db, f.service, (tx) =>
      tx.execute<{ confirmed: boolean }>(
        sql`select sovereign.archive_file_cleanup_receipt(${f.view.id}::uuid,${f.sourceId}::uuid,${token}::uuid,NULL,NULL,false) as confirmed`,
      ),
    );
    expect(nullProof.rows[0]?.confirmed).toBe(false);
    expect((await f.headers())[0]?.physical_purged_at).toBeNull();
  });
  it('records a genuinely finished put as closed/quiescent when read-back fails', async () => {
    const f = await fixture();
    f.store.failReadback = true;
    expect(await f.run()).toMatchObject({ status: 'failed', failureCode: 'STORE_UNAVAILABLE' });
    expect((await f.headers())[0]).toMatchObject({ state: 'closing', write_state: 'settled' });
    f.store.failReadback = false;
    expect(
      await createImportedArchivePurge({
        database: app.db,
        store: f.store,
        lifecycle: lifecycle(f.store),
      }).purgeTenant(f.service, { limit: 25 }),
    ).toMatchObject({ remaining: 0, removed: 1, confirmed: true });
  });
  it('does not turn absent storage or a missing lifecycle adapter into a completed purge', async () => {
    const f = await fixture();
    await f.run();
    await f.store.delete((await f.headers())[0]!.object_key);
    expect(
      await createImportedArchivePurge({ database: app.db, store: f.store }).purgeTenant(
        f.service,
        { limit: 25 },
      ),
    ).toMatchObject({ remaining: 1, confirmed: false });
  });
  it('honors a hold and requires independent absence before retaining positive deletion proof', async () => {
    const f = await fixture();
    await f.run();
    // A real tenant-wide legal hold, placed and released by the owner after MFA step-up.
    await proveSecondFactor(f.person);
    const hold = await placeLegalHold(app.db, f.person.context, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    const purge = createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: lifecycle(f.store),
    });
    expect(await purge.purgeTenant(f.service, { limit: 25 })).toMatchObject({
      held: 1,
      remaining: 1,
      confirmed: false,
    });
    expect(f.store.objects.has((await f.headers())[0]!.object_key)).toBe(true);
    await releaseLegalHold(app.db, f.person.context, {
      holdId: hold.holdId,
      expectedVersion: 1,
      reasonCode: 'GENERATED_TEST_RELEASE',
    });
    expect(await purge.purgeTenant(f.service, { limit: 25 })).toMatchObject({
      held: 0,
      remaining: 0,
      removed: 1,
      confirmed: true,
    });
    expect((await f.headers())[0]).toMatchObject({
      state: 'purged',
      write_state: 'settled',
      physical_purged_at: expect.any(Date),
    });
    expect(await purge.purgeTenant(f.service, { limit: 25 })).toMatchObject({
      removed: 1,
      remaining: 0,
      confirmed: true,
    });
  });
  it('rejects a claimed cleanup when bytes still exist', async () => {
    const f = await fixture();
    await f.run();
    const purge = createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: { erase: async () => ({ state: 'purged', quiescent: true }) },
    });
    expect(await purge.purgeTenant(f.service, { limit: 25 })).toMatchObject({
      remaining: 1,
      confirmed: false,
    });
    expect((await f.headers())[0]?.physical_purged_at).toBeNull();
  });
  it('reopens a historical purge receipt when restored storage contains the old bytes', async () => {
    const f = await fixture();
    await f.run();
    const key = (await f.headers())[0]!.object_key;
    await createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: lifecycle(f.store),
    }).purgeTenant(f.service, { limit: 25 });
    f.store.objects.set(key, f.bytes);
    expect(
      (await createArchiveQuarantineRecovery(f.store).reconcile(app.db, f.service)).needsAttention,
    ).toBeGreaterThan(0);
    expect((await f.headers())[0]).toMatchObject({ state: 'closing', physical_purged_at: null });
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('counts orphan quarantine objects after a database restore instead of certifying zero', async () => {
    const f = await fixture();
    const key = `${f.person.context.organizationId}/archive-quarantine/${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    f.store.objects.set(key, f.bytes);
    expect(
      (await createArchiveQuarantineRecovery(f.store).reconcile(app.db, f.service)).needsAttention,
    ).toBeGreaterThan(0);
    expect(f.store.objects.has(key)).toBe(true);
  });
  it('does not retain a live session FK and refuses the old native session after logout', async () => {
    const f = await fixture();
    await f.run();
    await auth.query('delete from identity.sessions where id=$1', [f.person.sessionId]);
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await f.headers())[0]?.state).toBe('quarantined');
  });
  it('rechecks the actual native session after object I/O', async () => {
    const f = await fixture();
    await f.run();
    f.store.beforeGet = () =>
      auth
        .query('delete from identity.sessions where id=$1', [f.person.sessionId])
        .then(() => undefined);
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('does not turn service cleanup authority into custodian download authority', async () => {
    const f = await fixture();
    await f.run();
    await expect(
      readImportedArchiveFile(app.db, f.store, f.service, {
        importId: f.view.id,
        sourceArtifactId: f.sourceId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const direct = await withTenantTx(app.db, f.service, (tx) =>
      tx.execute(
        sql`select * from sovereign.archive_file_read(${f.view.id}::uuid,${f.sourceId}::uuid)`,
      ),
    );
    expect(direct.rows).toEqual([]);
  });
  it('rechecks an active source grant before and after object I/O', async () => {
    const f = await fixture();
    await f.run();
    const added = await source(f);
    const grants = await control.query<{ id: string }>(
      'select id from knowledge.source_grants where organization_id=$1 and source_id=$2',
      [f.person.context.organizationId, added.sourceId],
    );
    expect((await f.read()).bytes).toEqual(f.bytes);
    f.store.beforeGet = () =>
      setSourceGrants(app.db, f.person.context, {
        sourceId: added.sourceId,
        expectedVersion: 1,
        add: [],
        removeGrantIds: grants.rows.map((row) => row.id),
      }).then(() => undefined);
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('blocks an archive copy after a current source classification rises', async () => {
    const f = await fixture();
    await f.run();
    const added = await source(f);
    await raiseSourceClassification(app.db, f.person.context, {
      sourceId: added.sourceId,
      expectedVersion: 1,
      classification: 'confidential',
    });
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('closes all unknown-input files on source deletion and participates in its physical final proof', async () => {
    const f = await fixture();
    await f.run();
    const added = await source(f);
    await deleteSource(app.db, f.person.context, {
      sourceId: added.sourceId,
      expectedVersion: 1,
      reason: 'Generated source deletion',
    });
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const purge = createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: lifecycle(f.store),
    });
    expect(
      await withTenantTx(app.db, f.service, (tx) =>
        purge.confirmInTx(tx, f.service, { sourceId: added.sourceId }),
      ),
    ).toEqual({ remaining: 1 });
    expect(
      await purge.purgeSource(f.service, { sourceId: added.sourceId, limit: 25 }),
    ).toMatchObject({ remaining: 0, confirmed: true });
  });
  it('serializes a concurrent source birth and closure behind the actual uncommitted archive header', async () => {
    const f = await fixture(),
      driver = new pg.Client({ connectionString: urls.app() }),
      sourceId = randomUUID();
    await driver.connect();
    let holderPid = 0,
      release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // This test-only delegate pauses an actual transaction before commit. It neither manufactures a
    // native identity nor prepares/stamps any import or storage receipt. The real encrypted importer
    // has already registered all bytes and executed begin_archive_file when the pause is reached.
    const paused = {
      transaction: <T>(bindings: Record<string, string>, run: (tx: Tx) => Promise<T>) =>
        app.db.transaction(bindings, async (tx) => {
          const result = await run(tx),
            first = Array.isArray(result)
              ? (result[0] as { claimed?: boolean; state?: string } | undefined)
              : undefined;
          if (first?.claimed === true && first.state === 'writing' && holderPid === 0) {
            holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))
              .rows[0]!.pid;
            await held;
          }
          return result;
        }),
    } as unknown as AppDatabase;
    const importing = f.run(paused);
    let closing: Promise<number> | undefined;
    try {
      await expect.poll(() => holderPid, { timeout: 5000, interval: 20 }).toBeGreaterThan(0);
      // The pending header is genuinely invisible in another transaction at this point.
      expect(await f.headers()).toEqual([]);
      const driverPid = (await driver.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]!.pid;
      closing = (async () => {
        await driver.query('begin');
        await driver.query(
          "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('app.user_id','',true),set_config('app.membership_id','',true),set_config('app.interactive_session_id','',true)",
          [f.person.context.organizationId],
        );
        // Actual worker metadata admission only: no document, fake body, grant or trusted-origin claim.
        await driver.query(
          "insert into knowledge.sources(organization_id,id,kind,classification,owner_membership_id) values($1,$2,'upload','internal',$3)",
          [f.person.context.organizationId, sourceId, f.person.context.membershipId],
        );
        await driver.query(
          "update knowledge.sources set state='deleted',revoked_at=clock_timestamp(),version=version+1 where organization_id=$1 and id=$2",
          [f.person.context.organizationId, sourceId],
        );
        const result = await driver.query<{ remaining: number }>(
          'select remaining from sovereign.archive_file_counts()',
        );
        await driver.query('commit');
        return result.rows[0]!.remaining;
      })();
      await expect
        .poll(
          async () => {
            const result = await control.query<{ blocked: boolean }>(
              'select $1=any(pg_blocking_pids($2)) as blocked',
              [holderPid, driverPid],
            );
            return result.rows[0]?.blocked;
          },
          { timeout: 5000, interval: 20 },
        )
        .toBe(true);
      release();
      // The closure cannot certify zero while that real writer exists, even before any object put.
      expect(await closing).toBe(1);
      expect(await importing).toMatchObject({ status: 'failed', failureCode: 'RECORD_REFUSED' });
      expect((await f.headers())[0]).toMatchObject({
        state: 'closing',
        write_state: 'settled',
        physical_purged_at: null,
      });
      await expect(f.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      release();
      await closing?.catch(() => driver.query('rollback'));
      await importing.catch(() => undefined);
      await driver.end();
    }
  });
  it('blocks unknown archive bytes on structured-record closure and counts them in record cleanup', async () => {
    const f = await fixture();
    await f.run();
    const work = await createWorkUnit(app.db, f.person.context, {
      title: 'Generated possible input',
    });
    expect((await f.read()).bytes).toEqual(f.bytes);
    // A real retained tombstone is authoritative even when the original structured row still exists.
    await withTenantTx(app.db, f.service, (tx) =>
      tx.execute(sql`insert into platform.tombstones(organization_id,target_type,target_id,reason_code,created_at)
   values(${f.person.context.organizationId}::uuid,'work_unit',${work.id}::uuid,'GENERATED_REVIEW_DELETION',clock_timestamp())`),
    );
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const files = await listImportedArchiveFiles(app.db, f.person.context, { importId: f.view.id });
    expect(files).toEqual([
      expect.objectContaining({
        sourceArtifactId: f.sourceId,
        name: null,
        mimeType: null,
        state: 'closing',
        reviewable: false,
      }),
    ]);
    const purge = createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: lifecycle(f.store),
    });
    expect(
      await withTenantTx(app.db, f.service, (tx) =>
        purge.confirmRecordInTx(tx, f.service, { kind: 'work_unit', id: work.id }),
      ),
    ).toEqual({ remaining: 1 });
    expect(
      await purge.purgeRecord(f.service, { kind: 'work_unit', id: work.id, limit: 25 }),
    ).toMatchObject({ remaining: 0, removed: 1, confirmed: true });
  });
  it('does not allow ordinary application or custodian deletion of the retained physical ledger', async () => {
    const f = await fixture();
    await f.run();
    await expect(
      withTenantTx(app.db, f.person.context, (tx) =>
        tx.execute(sql`delete from sovereign.imported_archive_files`),
      ),
    ).rejects.toThrow();
  });
  it('blocks a positive source-purge certificate when an older runtime falsely reports zero archive files', async () => {
    const f = await fixture();
    await f.run();
    const s = await closedSource(f);
    expect(await s.purge()).toMatchObject({ state: 'failed' });
    expect(await s.job()).toMatchObject({ state: 'failed', completed_at: null });
    for (const forgedScope of ['', 'v1'])
      await expect(
        withTenantTx(app.db, f.service, async (tx) => {
          // A custom GUC is not a physical proof, including the private metadata selector's spelling.
          await tx.execute(
            sql`select set_config('sovereign.archive_source_proof',${forgedScope},true)`,
          );
          await tx.execute(sql`
        update knowledge.purge_jobs set state='completed',completed_at=clock_timestamp(),artifacts_checked_at=clock_timestamp()
        where organization_id=${f.person.context.organizationId}::uuid and source_id=${s.sourceId}::uuid
      `);
        }),
      ).rejects.toMatchObject({ cause: { code: 'EN415' } });
    expect((await f.headers())[0]).toMatchObject({ state: 'closing', physical_purged_at: null });
    expect(
      await createImportedArchivePurge({
        database: app.db,
        store: f.store,
        lifecycle: lifecycle(f.store),
      }).purgeSource(f.service, { sourceId: s.sourceId, limit: 25 }),
    ).toMatchObject({ remaining: 0, confirmed: true });
    // Only the separate actual archive lifecycle receipt permits the same old SQL completion path.
    expect(await s.purge()).toMatchObject({ state: 'completed' });
  });
  it('invalidates an old completed source proof when historically purged archive bytes reappear', async () => {
    const f = await fixture();
    await f.run();
    const s = await closedSource(f);
    const key = (await f.headers())[0]!.object_key;
    await createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: lifecycle(f.store),
    }).purgeSource(f.service, { sourceId: s.sourceId, limit: 25 });
    expect(await s.purge()).toMatchObject({ state: 'completed' });
    f.store.objects.set(key, f.bytes);
    expect(
      (await createArchiveQuarantineRecovery(f.store).reconcile(app.db, f.service)).needsAttention,
    ).toBeGreaterThan(0);
    expect(await s.job()).toMatchObject({
      state: 'failed',
      completed_at: null,
      last_error_code: 'ARTIFACT_PURGE_UNCONFIRMED',
    });
    expect(await s.purge()).toMatchObject({ state: 'failed' });
  });
  it('keeps explicit source-proof recovery service-only and restores its private selector', async () => {
    const f = await fixture();
    await f.run();
    const s = await closedSource(f);
    await expect(
      withTenantTx(app.db, f.person.context, (tx) =>
        tx.execute(sql`
      select sovereign.reconcile_archive_source_proofs()
    `),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN415' } });
    await withTenantTx(app.db, f.service, async (tx) => {
      await tx.execute(
        sql`select set_config('sovereign.archive_source_proof','generated-outer',true)`,
      );
      await tx.execute(sql`select sovereign.reconcile_archive_source_proofs()`);
      const current = await tx.execute<{ value: string }>(
        sql`select current_setting('sovereign.archive_source_proof',true) as value`,
      );
      expect(current.rows[0]?.value).toBe('generated-outer');
    });
    expect(await s.job()).toMatchObject({ state: 'pending', completed_at: null });
  });
  it('serializes restored-byte invalidation with a source completion that is still uncommitted', async () => {
    const f = await fixture();
    await f.run();
    const s = await closedSource(f);
    const key = (await f.headers())[0]!.object_key;
    await createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: lifecycle(f.store),
    }).purgeSource(f.service, { sourceId: s.sourceId, limit: 25 });
    expect(await s.purge()).toMatchObject({ state: 'completed' });
    await failSourcePurge(app.db, f.service, { sourceId: s.sourceId, reason: 'PURGE_FAILED' });
    f.store.objects.set(key, f.bytes);
    const driver = new pg.Client({ connectionString: urls.app() });
    await driver.connect();
    let open = false,
      recovery:
        ReturnType<ReturnType<typeof createArchiveQuarantineRecovery>['reconcile']> | undefined;
    try {
      await driver.query('begin');
      open = true;
      await driver.query(
        "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('app.user_id','',true),set_config('app.membership_id','',true)",
        [f.person.context.organizationId],
      );
      const pid = (await driver.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!
        .pid;
      await driver.query(
        "update knowledge.purge_jobs set state='completed',completed_at=clock_timestamp() where organization_id=$1 and source_id=$2",
        [f.person.context.organizationId, s.sourceId],
      );
      recovery = createArchiveQuarantineRecovery(f.store).reconcile(app.db, f.service);
      // A scan that only UPDATEs already-completed rows would skip this transaction's old failed
      // version. The fixed trigger must lock the real job and invalidate its later completion.
      await expect
        .poll(
          async () =>
            (
              await control.query<{ blocked: boolean }>(
                "select exists(select 1 from pg_stat_activity where usename='ensemus_app' and $1=any(pg_blocking_pids(pid))) as blocked",
                [pid],
              )
            ).rows[0]?.blocked,
          { timeout: 5000, interval: 20 },
        )
        .toBe(true);
      await driver.query('commit');
      open = false;
      expect((await recovery).needsAttention).toBeGreaterThan(0);
      expect(await s.job()).toMatchObject({
        state: 'failed',
        completed_at: null,
        last_error_code: 'ARTIFACT_PURGE_UNCONFIRMED',
      });
    } finally {
      if (open) await driver.query('rollback');
      await recovery;
      await driver.end();
    }
  });
  const jobDates = async (f: Awaited<ReturnType<typeof fixture>>, sourceId: string) =>
    (
      await control.query<{
        state: string;
        completed_at: Date | null;
        prior_completed_at: Date | null;
        last_error_code: string | null;
      }>(
        'select state,completed_at,prior_completed_at,last_error_code from knowledge.purge_jobs where organization_id=$1 and source_id=$2',
        [f.person.context.organizationId, sourceId],
      )
    ).rows[0]!;
  const restoreDebts = async (f: Awaited<ReturnType<typeof fixture>>) =>
    (
      await control.query<{ kind: string; object_key: string }>(
        'select kind,object_key from lifecycle.object_restore_debts where organization_id=$1',
        [f.person.context.organizationId],
      )
    ).rows;
  // 0527: 0516 copied completed_at into prior_completed_at on every completed->failed demotion,
  // which 0419's guard refuses to any runtime session (PURGE_PRIOR_COMPLETION_IMMUTABLE), so a
  // runtime demotion of a first completion could not happen at all. That date is the migrator
  // requalifications' record of an earlier certificate (0419, 0515); a runtime demotion must neither
  // be refused for it nor write it, and the runtime still cannot write it directly.
  it('demotes a first completion at runtime, leaving its prior completion date to the requalifications', async () => {
    const f = await fixture();
    await f.run();
    const s = await closedSource(f);
    const key = (await f.headers())[0]!.object_key;
    await createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: lifecycle(f.store),
    }).purgeSource(f.service, { sourceId: s.sourceId, limit: 25 });
    expect(await s.purge()).toMatchObject({ state: 'completed' });
    const completed = await jobDates(f, s.sourceId);
    expect(completed).toMatchObject({ state: 'completed', prior_completed_at: null });
    expect(completed.completed_at).toBeInstanceOf(Date);
    // Restored storage still holds the bytes the header records as purged: the 0508 and 0415
    // triggers demote the certificate from the app role's own session.
    f.store.objects.set(key, f.bytes);
    expect(
      (await createArchiveQuarantineRecovery(f.store).reconcile(app.db, f.service)).needsAttention,
    ).toBeGreaterThan(0);
    expect(await jobDates(f, s.sourceId)).toEqual({
      state: 'failed',
      completed_at: null,
      prior_completed_at: null,
      last_error_code: 'ARTIFACT_PURGE_UNCONFIRMED',
    });
    expect((await f.headers())[0]).toMatchObject({ state: 'closing', physical_purged_at: null });
    expect(await restoreDebts(f)).toEqual([{ kind: 'archive', object_key: key }]);
    // The runtime worker cannot write that date itself, by the same update or a later one.
    for (const write of [
      sql`update knowledge.purge_jobs set prior_completed_at=${completed.completed_at}
        where organization_id=${f.person.context.organizationId}::uuid and source_id=${s.sourceId}::uuid`,
      sql`update knowledge.purge_jobs set prior_completed_at=clock_timestamp(),last_error_code='ARTIFACT_PURGE_UNCONFIRMED'
        where organization_id=${f.person.context.organizationId}::uuid and source_id=${s.sourceId}::uuid`,
    ])
      await expect(
        withTenantTx(app.db, f.service, (tx) => tx.execute(write)),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    expect((await jobDates(f, s.sourceId)).prior_completed_at).toBeNull();
  });
  // 0528: the archive restore debt (0508) now waits for the purge jobs in 0415's header->job order
  // instead of failing NOWAIT, so a reopening that meets an uncommitted source completion is
  // serialized behind it and then invalidates it, rather than rolling back and losing the reopen.
  it('serializes an archive header reopen behind an uncommitted completion, without deadlock', async () => {
    const f = await fixture();
    await f.run();
    const s = await closedSource(f);
    const key = (await f.headers())[0]!.object_key;
    await createImportedArchivePurge({
      database: app.db,
      store: f.store,
      lifecycle: lifecycle(f.store),
    }).purgeSource(f.service, { sourceId: s.sourceId, limit: 25 });
    expect(await s.purge()).toMatchObject({ state: 'completed' });
    await failSourcePurge(app.db, f.service, { sourceId: s.sourceId, reason: 'PURGE_FAILED' });
    expect(await restoreDebts(f)).toEqual([]);
    f.store.objects.set(key, f.bytes);
    const completer = new pg.Client({ connectionString: urls.app() });
    await completer.connect();
    type Settled = { ok: true; needsAttention: number } | { ok: false; error: unknown };
    let open = false,
      reopening: Promise<Settled> | undefined;
    try {
      await completer.query('begin');
      open = true;
      await completer.query(
        "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('app.user_id','',true),set_config('app.membership_id','',true),set_config('app.interactive_session_id','',true)",
        [f.person.context.organizationId],
      );
      const pid = (await completer.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]!.pid;
      // The completion holds the job row, uncommitted. It read the archive header as purged.
      await completer.query(
        "update knowledge.purge_jobs set state='completed',completed_at=clock_timestamp() where organization_id=$1 and source_id=$2",
        [f.person.context.organizationId, s.sourceId],
      );
      reopening = createArchiveQuarantineRecovery(f.store)
        .reconcile(app.db, f.service)
        .then(
          (report): Settled => ({ ok: true, needsAttention: report.needsAttention }),
          (error: unknown): Settled => ({ ok: false, error }),
        );
      // The reopening waits on a lock that the completion holds, rather than failing NOWAIT (55P03).
      await expect
        .poll(
          async () =>
            (
              await control.query<{ waiting: boolean }>(
                "select exists(select 1 from pg_stat_activity where usename='ensemus_app' and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))) as waiting",
                [pid],
              )
            ).rows[0]?.waiting,
          { timeout: 5000, interval: 20 },
        )
        .toBe(true);
      // While it waits, the completion still reads archive metadata, which takes no row lock: the
      // header->job order has no inverse, so nothing here can deadlock. It still sees the committed
      // header, since the reopen is not committed.
      const counts = await completer.query<{ remaining: number }>(
        'select remaining from sovereign.archive_file_counts()',
      );
      expect(counts.rows[0]?.remaining).toBe(0);
      await completer.query('commit');
      open = false;
      const settled = await reopening;
      expect(settled).toMatchObject({ ok: true });
      if (settled.ok) expect(settled.needsAttention).toBeGreaterThan(0);
      // The reopen committed after the completion, and invalidated it.
      expect((await f.headers())[0]).toMatchObject({ state: 'closing', physical_purged_at: null });
      expect(await restoreDebts(f)).toEqual([{ kind: 'archive', object_key: key }]);
      expect(await jobDates(f, s.sourceId)).toMatchObject({
        state: 'failed',
        completed_at: null,
        last_error_code: 'ARTIFACT_PURGE_UNCONFIRMED',
      });
      // And a later completion attempt cannot certify over the reopened header.
      await expect(s.purge()).resolves.toMatchObject({ state: 'failed' });
    } finally {
      if (open) await completer.query('rollback');
      await reopening;
      await completer.end();
    }
  });
});
