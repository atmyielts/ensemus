// Authored actual-role acceptance, unrun at this source checkpoint. M6 creates/seals/finishes every
// archive; no seeded ready row, fabricated epoch or empty section registry can qualify this adapter.
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import {
  openAppDatabase,
  resolveTenantContext,
  interactiveSessionOf,
  withTenantTx,
  organizations,
  type AppDatabase,
  type Tx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  beginExport,
  exportNextBatch,
  finishExport,
  SOURCE_PORTABILITY_SECTIONS,
  setMemberRole,
  refusalFromDatabase,
  type ObjectStore,
} from '@ensemus/application';
import {
  requestAccountExport,
  listAccountExports,
  getAccountExport,
  openAccountExportArchive,
} from '@ensemus/application/saas/exports';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { exportManifestSchema } from '@ensemus/contracts/portability-records';
import { EXPORT_MANIFEST_PATH } from '@ensemus/domain/portability';
import { open } from '@ensemus/sovereign/sealed';
import { readTarEntries } from '@ensemus/sovereign/tar';
import { eq } from 'drizzle-orm';
import { makeTwoTenants, nativePersonContext } from '../helpers/product';
import { nativeSovereignContext, testRecipient } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
class Store implements ObjectStore {
  objects = new Map<string, Buffer>();
  gets: string[] = [];
  onGet: () => void = () => undefined;
  async put(key: string, body: Buffer) {
    this.objects.set(key, Buffer.from(body));
  }
  async get(key: string) {
    this.onGet();
    this.gets.push(key);
    const body = this.objects.get(key);
    if (!body) throw new Error('GENERATED_EXPORT_BYTES_MISSING');
    return Buffer.from(body);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
const collect = async (chunks: AsyncIterable<Buffer>) => {
  const output: Buffer[] = [];
  for await (const chunk of chunks) output.push(chunk);
  return Buffer.concat(output);
};
describe('account-only M6 exports while suspended', () => {
  const database = openAppDatabase(urls.app()),
    recipient = testRecipient(),
    store = new Store(),
    deps = {
      sections: SOURCE_PORTABILITY_SECTIONS,
      sourceRelease: 'generated-account-export',
      retentionHours: 24,
    };
  let world: Awaited<ReturnType<typeof makeTwoTenants>>, owner: TenantContext, exportId: string;
  const agents = {
    haltTenantAgents: async () => undefined,
    releaseTenantAgents: async () => undefined,
  }; // isolated tenants have no runs; no agent-lifecycle qualification is claimed.
  beforeAll(async () => {
    world = await makeTwoTenants(database.db);
    await setMemberRole(database.db, world.a.owner.context, {
      membershipId: world.a.admin.context.membershipId,
      role: 'owner',
    });
    await withTenantTx(database.db, createServiceContext(world.a.organizationId), (tx) =>
      setTenantStandingInTx(
        tx,
        createServiceContext(world.a.organizationId),
        {
          to: 'suspended',
          reasonCode: 'GENERATED_EXPORT_TEST',
          actor: { type: 'operator', ref: 'generated-export-test' },
        },
        agents,
      ),
    );
    owner = await nativePersonContext(database.db, world.a.owner, world.a.organizationId);
  });
  afterAll(() => database.close());
  it('requests and lists a real export in suspended standing without changing the original context', async () => {
    expect(owner.serving).toBe('suspended');
    const requested = await requestAccountExport(database.db, owner, {
      recipientPublicKey: recipient.publicKeyBase64,
      sourceRelease: deps.sourceRelease,
    });
    exportId = requested.id;
    expect(requested.status).toBe('requested');
    expect(owner.serving).toBe('suspended');
    expect((await listAccountExports(database.db, owner)).map((row) => row.id)).toContain(exportId);
    expect((await getAccountExport(database.db, owner, exportId)).status).toBe('requested');
    await expect(
      openAccountExportArchive(database.db, store, owner, exportId),
    ).rejects.toMatchObject({ code: 'EXPORT_NOT_READY' });
  });
  it('denies actual non-owners, non-user actors, unissued native context and a foreign export ID', async () => {
    for (const context of [
      world.a.member.context,
      world.b.admin.context,
      createServiceContext(world.a.organizationId),
      { ...owner, actorType: 'delegated' as const },
      { ...owner, actorType: 'agent' as const, agentRunId: exportId },
      await resolveTenantContext(database.db, owner.userId, owner.organizationId),
    ])
      await expect(listAccountExports(database.db, context)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    await expect(
      getAccountExport(database.db, world.b.owner.context, exportId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('keeps original public-key validation and never enables a core write', async () => {
    await expect(
      requestAccountExport(database.db, owner, {
        recipientPublicKey: recipient.privateKeyPem,
        sourceRelease: deps.sourceRelease,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const effect of [
      () =>
        withTenantTx(database.db, owner, (tx) =>
          tx
            .update(organizations)
            .set({ name: 'must-not-save' })
            .where(eq(organizations.id, owner.organizationId)),
        ),
    ]) {
      let failure: unknown;
      try {
        await effect();
      } catch (error) {
        failure = error;
      }
      expect(refusalFromDatabase(failure)).toMatchObject({ code: 'TENANT_READ_ONLY' });
    }
  });
  it('uses actual M6 section/manifest proof and downloads sealed bytes while still suspended', async () => {
    const worker = createServiceContext(owner.organizationId);
    let step = await beginExport(database.db, worker, { exportId }, deps),
      count = 0;
    while (step.state === 'continue' && count++ < 250)
      step = await exportNextBatch(database.db, store, worker, { exportId }, deps);
    expect(step.state).toBe('finished');
    step = await finishExport(database.db, store, worker, { exportId }, deps);
    while (step.state === 'continue' && count++ < 350)
      step = await finishExport(database.db, store, worker, { exportId }, deps);
    expect(step.state).toBe('finished');
    expect((await getAccountExport(database.db, owner, exportId)).status).toBe('ready');
    let transactions = 0;
    const transaction = <T>(bindings: Record<string, string>, effect: (tx: Tx) => Promise<T>) =>
      database.db.transaction(bindings, async (tx) => {
        transactions++;
        try {
          return await effect(tx);
        } finally {
          transactions--;
        }
      });
    const tracked = {
      transaction,
      run: <T>(effect: (tx: Tx) => Promise<T>) => transaction({}, effect),
    } as AppDatabase;
    store.onGet = () =>
      expect(transactions, 'No SQL transaction may remain open during object I/O').toBe(0);
    const archive = await openAccountExportArchive(tracked, store, owner, exportId),
      bytes = await collect(archive.chunks);
    expect(bytes.length).toBe(archive.totalBytes);
    const entries = [];
    for await (const entry of readTarEntries(
      async (offset, length) => bytes.subarray(offset, offset + length),
      bytes.length,
    ))
      entries.push(entry);
    const manifest = entries.find((entry) => entry.path === EXPORT_MANIFEST_PATH);
    if (!manifest) throw new Error('GENERATED_MANIFEST_MISSING');
    const decoded = exportManifestSchema.parse(
      JSON.parse(
        open(
          bytes.subarray(manifest.offset, manifest.offset + manifest.size),
          recipient.privateKey,
        ).toString('utf8'),
      ),
    );
    expect(decoded.export_id).toBe(exportId);
    expect(decoded.organization_id).toBe(owner.organizationId);
  });
  it('rechecks native session freshness before a delayed download reads storage', async () => {
    const temporary = await nativeSovereignContext(database.db, owner.userId, owner.organizationId),
      archive = await openAccountExportArchive(database.db, store, temporary, exportId),
      identity = interactiveSessionOf(temporary);
    if (!identity) throw new Error('GENERATED_SESSION_MISSING');
    const auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    try {
      await auth.query(
        "update identity.sessions set expires_at=clock_timestamp()-interval '1 second' where id=$1 and user_id=$2",
        [identity.sessionId, temporary.userId],
      );
    } finally {
      await auth.end();
    }
    const before = store.gets.length;
    await expect(collect(archive.chunks)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.gets).toHaveLength(before);
  });
  it('denies a stale owner at stream checkpoints after an actual role change', async () => {
    const archive = await openAccountExportArchive(database.db, store, owner, exportId),
      before = store.gets.length,
      service = createServiceContext(owner.organizationId);
    await withTenantTx(database.db, service, (tx) =>
      setTenantStandingInTx(
        tx,
        service,
        {
          to: 'active',
          reasonCode: 'GENERATED_EXPORT_TEST',
          actor: { type: 'operator', ref: 'generated-export-test' },
        },
        agents,
      ),
    );
    const other = await nativePersonContext(database.db, world.a.admin, owner.organizationId);
    await setMemberRole(database.db, other, { membershipId: owner.membershipId, role: 'member' });
    await expect(getAccountExport(database.db, owner, exportId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(collect(archive.chunks)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.gets).toHaveLength(before);
  });
});
