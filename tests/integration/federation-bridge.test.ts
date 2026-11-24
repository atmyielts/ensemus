import { createFederationActivities } from '@ensemus/workflows/federation-activities';
import { inboundObjectKey, itemContentHash, outboundObjectKey } from '@ensemus/domain/federation';
import {
  federationGrants,
  federationInboundItems,
  federationOutboundItems,
  openAppDatabase,
  withTenantTx,
} from '@ensemus/database';
import {
  claimFederationCopy,
  createWorkUnit,
  disposeInboundItem,
  getInboundItem,
  listCrossings,
  listInboundItems,
  listOutboundItems,
  publishItem,
  readInboundFile,
  withdrawItem,
  endGrant,
  loadFederationCopyState,
  observeFederationCopy,
  removeWithdrawnItem,
  settleGrantEndForTenant,
  type ObjectStore,
  loadGrantPartiesForWorker,
  loadItemGrantForWorker,
  recordItemReceived,
} from '@ensemus/application';
import { createServiceContext } from '@ensemus/database/service';
import { federationItemTargetRef } from '@ensemus/domain/federation-events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  crossItem,
  openBridgeDatabase,
  purgeInboundCopies,
  readItemToCross,
  refuseItem,
} from '../../packages/database/src/federation';
import {
  clearDeploymentProfile,
  client,
  enableFederation,
  ensureBridgeRole,
  seedGrant,
  seedOutboundItem,
  setDeploymentProfile,
} from '../helpers/federation';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('collaboration bridge transactions', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let worker: ReturnType<typeof openAppDatabase>;
  let bridge: ReturnType<typeof openBridgeDatabase>;
  let sql: Awaited<ReturnType<typeof client>>;
  let owners: Awaited<ReturnType<typeof makeTwoTenants>>;
  const sharing = () => owners.a.owner.context;
  const receiving = () => owners.b.owner.context;
  const input = (grantId: string, itemId: string) => ({
    grantId,
    itemId,
    senderOrganizationId: sharing().organizationId,
  });

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
    bridge = openBridgeDatabase(await ensureBridgeRole());
    sql = await client(urls.superuser());
    owners = await makeTwoTenants(app.db);
    await proveSecondFactor(owners.a.owner);
    await setDeploymentProfile({ crossOrgEnabled: true });
    await enableFederation(app.db, sharing());
    await enableFederation(app.db, receiving());
  });
  afterAll(async () => {
    await clearDeploymentProfile();
    await Promise.all([app?.close(), worker?.close(), bridge?.close(), sql?.end()]);
  });

  it('delivers an exact copy once when two workers retry concurrently', async () => {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const otherGrant = await seedGrant(app.db, sharing(), receiving());
    const item = await seedOutboundItem(app.db, sharing(), grant.id, {
      title: 'Generated handover',
      body: { objective: 'Generated acceptance check' },
    });
    const request = input(grant.id, item.id);
    expect(await readItemToCross(bridge.db, request)).toEqual({
      itemId: item.id,
      kind: 'work_summary',
      senderOrganizationId: sharing().organizationId,
      receiverOrganizationId: receiving().organizationId,
      fileObjectKey: null,
      fileSha256: null,
      fileSizeBytes: null,
      fileMimeType: null,
    });
    await expect(crossItem(bridge.db, { ...request, grantId: otherGrant.id })).resolves.toBe(
      'closed',
    );
    expect(
      await Promise.all([crossItem(bridge.db, request), crossItem(bridge.db, request)]),
    ).toEqual(['delivered', 'delivered']);
    await expect(readItemToCross(bridge.db, request)).resolves.toBeNull();
    const [copy] = await withTenantTx(app.db, receiving(), (tx) =>
      tx.select().from(federationInboundItems).where(eq(federationInboundItems.id, item.id)),
    );
    expect(copy).toMatchObject({
      title: item.title,
      body: item.body,
      contentSha256: item.contentSha256,
      organizationId: receiving().organizationId,
      disposition: 'pending',
    });
    const { rows } = await sql.query(
      'select outcome from federation.crossings where grant_id=$1 and item_id=$2',
      [grant.id, item.id],
    );
    expect(rows).toEqual([{ outcome: 'delivered' }]);
  });

  it('records one receipt for the actual receiver and exposes no content through worker lookups', async () => {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const item = await seedOutboundItem(app.db, sharing(), grant.id, {
      body: { objective: 'Generated receipt example' },
    });
    const sender = createServiceContext(sharing().organizationId);
    const receiver = createServiceContext(receiving().organizationId);
    const outsider = createServiceContext(randomUUID());
    await expect(loadItemGrantForWorker(worker.db, sender, item.id)).resolves.toEqual({
      grantId: grant.id,
      state: 'queued',
    });
    await expect(loadItemGrantForWorker(worker.db, receiver, item.id)).resolves.toBeNull();
    await expect(loadGrantPartiesForWorker(worker.db, outsider, grant.id)).resolves.toBeNull();
    await expect(loadGrantPartiesForWorker(worker.db, sender, grant.id)).resolves.toEqual({
      sharingOrganizationId: sender.organizationId,
      receivingOrganizationId: receiver.organizationId,
    });
    await expect(
      recordItemReceived(worker.db, receiving(), { itemId: item.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await crossItem(bridge.db, input(grant.id, item.id));
    await Promise.all([
      recordItemReceived(worker.db, receiver, { itemId: item.id }),
      recordItemReceived(worker.db, receiver, { itemId: item.id }),
      recordItemReceived(worker.db, sender, { itemId: item.id }),
    ]);
    const { rows } = await sql.query(
      "select organization_id, payload from platform.domain_events where aggregate_id=$1 and event_type='federation.item_received'",
      [item.id],
    );
    expect(rows).toEqual([{ organization_id: receiver.organizationId, payload: {} }]);
    const notices = await sql.query(
      'select recipient_membership_id from platform.notifications where target_ref=$1 order by recipient_membership_id',
      [federationItemTargetRef(item.id)],
    );
    expect(notices.rows.map((row) => row.recipient_membership_id)).toEqual(
      [owners.b.owner.context.membershipId, owners.b.admin.context.membershipId].sort(),
    );
  });

  it('records one typed refusal without delivering content even if it is retried', async () => {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const item = await seedOutboundItem(app.db, sharing(), grant.id);
    const request = { ...input(grant.id, item.id), code: 'FILE_HASH_MISMATCH' };
    await expect(refuseItem(bridge.db, { ...request, code: 'UNLISTED' })).rejects.toThrow();
    await Promise.all([refuseItem(bridge.db, request), refuseItem(bridge.db, request)]);
    await expect(crossItem(bridge.db, request)).resolves.toBe('refused');
    const { rows } = await sql.query(
      'select outcome,code from federation.crossings where grant_id=$1 and item_id=$2',
      [grant.id, item.id],
    );
    expect(rows).toEqual([{ outcome: 'refused', code: 'FILE_HASH_MISMATCH' }]);
  });

  it('refuses to commit an artifact without matching verified bytes', async () => {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const itemId = randomUUID();
    const sha256 = 'a'.repeat(64);
    const fileSizeBytes = 17;
    const title = 'Generated attachment';
    const body = {};
    await withTenantTx(app.db, sharing(), (tx) =>
      tx.insert(federationOutboundItems).values({
        id: itemId,
        organizationId: sharing().organizationId,
        grantId: grant.id,
        kind: 'artifact',
        classification: 'internal',
        title,
        body,
        fileSizeBytes,
        contentSha256: itemContentHash({
          kind: 'artifact',
          title,
          body,
          classification: 'internal',
          fileSha256: sha256,
        }),
        fileObjectKey: outboundObjectKey(sharing().organizationId, itemId),
        fileSha256: sha256,
        fileMimeType: 'text/plain',
        createdByMembershipId: sharing().membershipId,
      }),
    );
    const request = input(grant.id, itemId);
    await expect(crossItem(bridge.db, request)).rejects.toThrow('FEDERATION_FILE_PROOF_REQUIRED');
    await expect(
      crossItem(bridge.db, { ...request, verifiedFile: { sha256, sizeBytes: fileSizeBytes - 1 } }),
    ).rejects.toThrow('FEDERATION_FILE_PROOF_REQUIRED');
    await expect(
      crossItem(bridge.db, { ...request, verifiedFile: { sha256, sizeBytes: fileSizeBytes } }),
    ).rejects.toThrow('FEDERATION_FILE_PROOF_REQUIRED');
    const senderContext = createServiceContext(sharing().organizationId);
    const target = {
      itemId,
      grantId: grant.id,
      receiverOrganizationId: receiving().organizationId,
    };
    await expect(claimFederationCopy(app.db, senderContext, target)).rejects.toThrow();
    await expect(claimFederationCopy(worker.db, senderContext, target)).resolves.toBe('admitted');
    await expect(claimFederationCopy(worker.db, senderContext, target)).resolves.toBe('claimed');
    await observeFederationCopy(worker.db, senderContext, target, {
      sha256,
      sizeBytes: fileSizeBytes,
    });
    await expect(
      crossItem(bridge.db, { ...request, verifiedFile: { sha256, sizeBytes: fileSizeBytes } }),
    ).resolves.toBe('delivered');
    await endGrant(app.db, sharing(), {
      grantId: grant.id,
      reason: 'revoked',
      expectedVersion: grant.version,
    });
    const purge = { grantId: grant.id, limit: 1 };
    await expect(purgeInboundCopies(bridge.db, purge)).resolves.toEqual([
      {
        itemId,
        receiverOrganizationId: receiving().organizationId,
        fileObjectKey: inboundObjectKey(receiving().organizationId, itemId),
      },
    ]);
    await expect(purgeInboundCopies(bridge.db, purge)).resolves.toEqual([]);
    // The sender row remains available to derive both storage keys if object deletion needs a retry.
    const [sender] = await withTenantTx(app.db, sharing(), (tx) =>
      tx
        .select({ id: federationOutboundItems.id })
        .from(federationOutboundItems)
        .where(eq(federationOutboundItems.id, itemId)),
    );
    expect(sender?.id).toBe(itemId);
  });

  it('purges withdrawn copies by direction and leaves open copies untouched', async () => {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const item = await seedOutboundItem(app.db, sharing(), grant.id);
    const request = input(grant.id, item.id);
    await crossItem(bridge.db, request);
    await expect(purgeInboundCopies(bridge.db, { grantId: grant.id, limit: 1 })).resolves.toEqual(
      [],
    );
    await expect(purgeInboundCopies(bridge.db, { ...request, limit: 1 })).resolves.toEqual([]);
    await withTenantTx(app.db, sharing(), (tx) =>
      tx
        .update(federationOutboundItems)
        .set({ state: 'withdrawn', withdrawnAt: new Date(), version: 3 })
        .where(eq(federationOutboundItems.id, item.id)),
    );
    await expect(
      purgeInboundCopies(bridge.db, {
        ...request,
        senderOrganizationId: receiving().organizationId,
        limit: 1,
      }),
    ).resolves.toEqual([]);
    await expect(purgeInboundCopies(bridge.db, { ...request, limit: 1 })).resolves.toEqual([
      {
        itemId: item.id,
        receiverOrganizationId: receiving().organizationId,
        fileObjectKey: null,
      },
    ]);
    await expect(purgeInboundCopies(bridge.db, { ...request, limit: 1 })).resolves.toEqual([]);
  });

  it('rechecks authority after waiting for an in-flight revocation to commit', async () => {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const item = await seedOutboundItem(app.db, sharing(), grant.id);
    let didWrite!: () => void;
    let failedWrite!: (error: unknown) => void;
    const written = new Promise<void>((resolve, reject) => {
      didWrite = resolve;
      failedWrite = reject;
    });
    let allowCommit!: () => void;
    const canCommit = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const revocation = withTenantTx(app.db, sharing(), async (tx) => {
      const now = new Date();
      await tx
        .update(federationGrants)
        .set({
          status: 'ended',
          endedByOrganizationId: sharing().organizationId,
          endedByMembershipId: sharing().membershipId,
          endReason: 'revoked',
          endedAt: now,
          version: grant.version + 1,
        })
        .where(eq(federationGrants.id, grant.id));
      didWrite();
      await canCommit;
    });
    void revocation.catch(failedWrite);
    await written;
    const crossing = crossItem(bridge.db, input(grant.id, item.id));
    try {
      await vi.waitFor(
        async () => {
          const { rows } = await sql.query(
            `select exists (
             select 1 from pg_locks
              where locktype='advisory' and mode='ShareLock' and not granted and objsubid=1
                and classid=((federation.grant_lock_key($1) >> 32) & 4294967295)::oid
                and objid=(federation.grant_lock_key($1) & 4294967295)::oid
           ) as waiting`,
            [grant.id],
          );
          expect(rows[0].waiting).toBe(true);
        },
        { timeout: 5_000 },
      );
    } finally {
      allowCommit();
      await revocation;
      await expect(crossing).resolves.toBe('closed');
    }
    const { rows } = await sql.query(
      'select id from federation.inbound_items where grant_id=$1 and id=$2',
      [grant.id, item.id],
    );
    expect(rows).toEqual([]);
  });

  it('orders deliveries against revocation and prevents any subsequent inbound read', async () => {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const queued = await seedOutboundItem(app.db, sharing(), grant.id);
    const pending = await seedOutboundItem(app.db, sharing(), grant.id);
    const request = input(grant.id, queued.id);
    const [outcome, ended] = await Promise.all([
      crossItem(bridge.db, request),
      endGrant(app.db, sharing(), {
        grantId: grant.id,
        reason: 'revoked',
        expectedVersion: grant.version,
      }),
    ]);
    expect(['closed', 'delivered']).toContain(outcome);
    expect(ended.status).toBe('ended');
    await expect(crossItem(bridge.db, input(grant.id, pending.id))).resolves.toBe('closed');
    expect(
      await withTenantTx(app.db, receiving(), (tx) =>
        tx
          .select()
          .from(federationInboundItems)
          .where(eq(federationInboundItems.grantId, grant.id)),
      ),
    ).toEqual([]);
    const { rows } = await sql.query(
      'select item_id,outcome from federation.crossings where grant_id=$1',
      [grant.id],
    );
    expect(rows).toEqual(
      outcome === 'delivered' ? [{ item_id: queued.id, outcome: 'delivered' }] : [],
    );
    expect(await purgeInboundCopies(bridge.db, { grantId: grant.id, limit: 1 })).toHaveLength(
      rows.length,
    );
  });

  function transferStore() {
    const objects = new Map<string, Buffer>();
    const store = {
      get: vi.fn(async (key: string, limit?: number) => {
        const bytes = objects.get(key);
        if (!bytes) {
          const error = new Error('Generated missing object');
          error.name = 'NoSuchKey';
          throw error;
        }
        if (limit !== undefined && bytes.length > limit) throw new Error('OBJECT_TOO_LARGE');
        return Buffer.from(bytes);
      }),
      put: vi.fn(async (key: string, bytes: Buffer) => {
        objects.set(key, Buffer.from(bytes));
      }),
      putSingleAttempt: vi.fn(async (key: string, bytes: Buffer) => {
        objects.set(key, Buffer.from(bytes));
        return { transport: 'written' as const };
      }),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
      exists: vi.fn(async (key: string) => objects.has(key)),
      assertPurgeCapability: vi.fn(async () => {}),
      isPhysicallyAbsent: vi.fn(async (key: string) => !objects.has(key)),
      deleteForPurge: vi.fn(async (key: string) => {
        objects.delete(key);
        return { transport: 'deleted' as const, capabilityVerified: true };
      }),
    } satisfies ObjectStore;
    return { store, objects };
  }

  async function queuedFile() {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const itemId = randomUUID();
    const bytes = Buffer.from('Generated collaboration file');
    const fileSha256 = createHash('sha256').update(bytes).digest('hex');
    const classification = 'internal';
    const title = 'Generated collaboration file';
    const source = outboundObjectKey(sharing().organizationId, itemId);
    const destination = inboundObjectKey(receiving().organizationId, itemId);
    await withTenantTx(app.db, sharing(), (tx) =>
      tx.insert(federationOutboundItems).values({
        id: itemId,
        organizationId: sharing().organizationId,
        grantId: grant.id,
        kind: 'artifact',
        classification,
        title,
        body: {},
        contentSha256: itemContentHash({
          kind: 'artifact',
          title,
          body: {},
          classification,
          fileSha256,
        }),
        fileObjectKey: source,
        fileSha256,
        fileSizeBytes: bytes.length,
        fileMimeType: 'text/plain',
        createdByMembershipId: sharing().membershipId,
      }),
    );
    return { grant, itemId, bytes, source, destination };
  }

  function transport(store: ObjectStore) {
    return createFederationActivities({
      bridge: bridge.db,
      store,
      followUp: {
        loadFileCopy: (context, target) => loadFederationCopyState(worker.db, context, target),
        claimFileCopy: (context, target) => claimFederationCopy(worker.db, context, target),
        observeFileCopy: (context, target, proof) =>
          observeFederationCopy(worker.db, context, target, proof),
        loadItemGrant: (context, id) => loadItemGrantForWorker(worker.db, context, id),
        loadGrantParties: (context, id) => loadGrantPartiesForWorker(worker.db, context, id),
        recordItemReceived: (context, itemId) => recordItemReceived(worker.db, context, { itemId }),
        settleGrantEnd: (context, claim) =>
          settleGrantEndForTenant(worker.db, store, context, claim),
        removeWithdrawnItem: (context, itemId) =>
          removeWithdrawnItem(worker.db, store, context, itemId),
      },
    });
  }

  it('publishes a Work Summary once, records a decision and withdraws through the real worker', async () => {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const { store } = transferStore();
    const source = await createWorkUnit(app.db, sharing(), {
      title: 'Private local title',
      objective: 'Local objective that does not travel',
      classification: 'internal',
    });
    const request = {
      grantId: grant.id,
      item: {
        kind: 'work_summary' as const,
        work_unit_id: source.id,
        title: 'Generated shared title',
        body: { objective: 'Generated chosen summary' },
      },
      requestKey: randomUUID(),
    };
    const [first, second] = await Promise.all([
      publishItem(app.db, store, sharing(), request),
      publishItem(app.db, store, sharing(), request),
    ]);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({
      state: 'queued',
      sourceId: source.id,
      classification: 'internal',
      body: { objective: 'Generated chosen summary' },
    });
    await expect(
      publishItem(app.db, store, sharing(), {
        ...request,
        item: { ...request.item, title: 'Different request' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(listOutboundItems(app.db, receiving(), { grantId: grant.id })).resolves.toEqual(
      [],
    );
    await expect(getInboundItem(app.db, receiving(), first.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const activities = transport(store);
    const reference = { organizationId: sharing().organizationId, itemId: first.id };
    await expect(activities.deliverFederationItem(reference)).resolves.toBe('delivered');
    await activities.recordFederationItemReceived(reference);
    const inbox = await listInboundItems(app.db, receiving(), { disposition: 'pending' });
    expect(inbox.find((item) => item.id === first.id)).toMatchObject({
      title: 'Generated shared title',
      body: { objective: 'Generated chosen summary' },
    });
    expect(inbox.find((item) => item.id === first.id)).not.toHaveProperty('sourceId');

    const decision = { itemId: first.id, expectedVersion: 1, disposition: 'accepted' as const };
    await expect(
      disposeInboundItem(app.db, receiving(), { ...decision, linkedWorkUnitId: source.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      disposeInboundItem(app.db, receiving(), { ...decision, linkedWorkUnitId: null }),
    ).resolves.toMatchObject({ disposition: 'accepted', version: 2, linkedWorkUnitId: null });
    await expect(
      disposeInboundItem(app.db, receiving(), { ...decision, linkedWorkUnitId: null }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    await expect(
      withdrawItem(app.db, sharing(), { itemId: first.id, expectedVersion: 2 }),
    ).resolves.toMatchObject({ state: 'withdrawn', version: 3 });
    await expect(
      withdrawItem(app.db, sharing(), { itemId: first.id, expectedVersion: 2 }),
    ).resolves.toMatchObject({ state: 'withdrawn', version: 3 });
    await expect(activities.purgeFederationItem(reference)).resolves.toEqual({
      purged: 1,
      more: false,
    });
    await expect(getInboundItem(app.db, receiving(), first.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const newest = await listCrossings(app.db, sharing(), { grantId: grant.id, limit: 1 });
    expect(newest.items).toMatchObject([{ outcome: 'purged', direction: 'sent' }]);
    expect(newest.nextCursor).toBeTruthy();
    const earlier = await listCrossings(app.db, receiving(), {
      grantId: grant.id,
      cursor: newest.nextCursor!,
      limit: 1,
    });
    expect(earlier.items).toMatchObject([{ outcome: 'delivered', direction: 'received' }]);
    expect(earlier.nextCursor).toBeNull();
  });

  it('enforces each side, classification and readable source when publishing', async () => {
    const grant = await seedGrant(app.db, sharing(), receiving());
    const { store } = transferStore();
    const restricted = await createWorkUnit(app.db, sharing(), {
      title: 'Generated restricted source',
      classification: 'restricted',
    });
    const sendStatus = (context: ReturnType<typeof sharing>) =>
      publishItem(app.db, store, context, {
        grantId: grant.id,
        item: {
          kind: 'status_update',
          title: 'Generated update',
          body: { state: 'received' },
          classification: 'public',
        },
        requestKey: randomUUID(),
      });
    await expect(sendStatus(sharing())).rejects.toMatchObject({
      code: 'FEDERATION_KIND_NOT_ALLOWED',
    });
    await expect(sendStatus(receiving())).resolves.toMatchObject({
      kind: 'status_update',
      state: 'queued',
    });
    const sendSummary = (sourceId: string) =>
      publishItem(app.db, store, sharing(), {
        grantId: grant.id,
        item: {
          kind: 'work_summary',
          work_unit_id: sourceId,
          title: 'Generated shared title',
          body: {},
        },
        requestKey: randomUUID(),
      });
    await expect(sendSummary(restricted.id)).rejects.toMatchObject({
      code: 'FEDERATION_CLASSIFICATION_TOO_HIGH',
    });
    await expect(sendSummary(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('recovers after a completed PUT and DELETE with lost responses, without repeating either mutation', async () => {
    const { grant, itemId, bytes, source, destination } = await queuedFile();
    const { store, objects } = transferStore();
    objects.set(source, bytes);
    const flow = transport(store);
    const job = { organizationId: sharing().organizationId, itemId };
    const ending = { organizationId: job.organizationId, grantId: grant.id };
    const read = store.get.getMockImplementation()!;
    store.get.mockImplementationOnce(read).mockRejectedValueOnce(new Error('Generated restart'));
    store.putSingleAttempt.mockImplementationOnce(async (key, buffer) => {
      objects.set(key, Buffer.from(buffer));
      throw new Error('Generated dropped PUT response');
    });
    await expect(flow.deliverFederationItem(job)).rejects.toThrow('FEDERATION_COPY_UNCONFIRMED');
    await expect(flow.deliverFederationItem(job)).resolves.toBe('delivered');
    expect(store.putSingleAttempt).toHaveBeenCalledExactlyOnceWith(
      destination,
      bytes,
      'text/plain',
    );
    await flow.recordFederationItemReceived(job);
    expect(objects.get(destination)).toEqual(bytes);

    await expect(readInboundFile(app.db, store, receiving(), itemId)).resolves.toMatchObject({
      body: bytes,
      mimeType: 'text/plain',
    });
    await expect(readInboundFile(app.db, store, sharing(), itemId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    store.get.mockResolvedValueOnce(Buffer.from('Different generated content'));
    await expect(readInboundFile(app.db, store, receiving(), itemId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    store.get.mockImplementationOnce(async (key) => {
      await endGrant(app.db, sharing(), {
        grantId: grant.id,
        reason: 'revoked',
        expectedVersion: grant.version,
      });
      return read(key);
    });
    await expect(readInboundFile(app.db, store, receiving(), itemId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(flow.purgeFederationGrantPass(ending)).resolves.toEqual({
      purged: 1,
      more: false,
    });
    store.deleteForPurge.mockImplementationOnce(async (key) => {
      objects.delete(key);
      throw new Error('Generated dropped DELETE response');
    });
    await expect(flow.settleFederationGrantEnd(ending)).rejects.toThrow(
      'FEDERATION_DELETE_UNCONFIRMED',
    );
    await expect(
      loadItemGrantForWorker(worker.db, createServiceContext(job.organizationId), itemId),
    ).resolves.toMatchObject({ state: 'withdrawn' });
    await expect(flow.settleFederationGrantEnd(ending)).resolves.toBe(false);
    await expect(flow.settleFederationGrantEnd(ending)).resolves.toBe(false);
    expect(store.deleteForPurge.mock.calls).toEqual([[destination], [source]]);
    expect(objects.size).toBe(0);
    await expect(
      loadItemGrantForWorker(worker.db, createServiceContext(job.organizationId), itemId),
    ).resolves.toBeNull();
  });

  it('holds cleanup until an admitted PUT that outlasts revocation is positively observed', async () => {
    const { grant, itemId, bytes, source, destination } = await queuedFile();
    const { store, objects } = transferStore();
    objects.set(source, bytes);
    const flow = transport(store);
    const job = { organizationId: sharing().organizationId, itemId };
    const ending = { organizationId: job.organizationId, grantId: grant.id };
    let started!: () => void;
    const startedPut = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const finishPut = new Promise<void>((resolve) => {
      finish = resolve;
    });
    store.putSingleAttempt.mockImplementationOnce(async (key, buffer) => {
      started();
      await finishPut;
      objects.set(key, Buffer.from(buffer));
      return { transport: 'written' };
    });
    const delivery = flow.deliverFederationItem(job);
    try {
      await Promise.race([
        startedPut,
        delivery.then(() => {
          throw new Error('Delivery ended before the expected PUT');
        }),
      ]);
      await endGrant(app.db, sharing(), {
        grantId: grant.id,
        reason: 'revoked',
        expectedVersion: grant.version,
      });
      await expect(flow.purgeFederationGrantPass(ending)).resolves.toEqual({
        purged: 0,
        more: false,
      });
      await expect(flow.settleFederationGrantEnd(ending)).rejects.toThrow(
        'FEDERATION_COPY_UNCONFIRMED',
      );
      expect(store.deleteForPurge).not.toHaveBeenCalled();
      expect(objects.get(source)).toEqual(bytes);
    } finally {
      finish();
    }
    await expect(delivery).resolves.toBe('closed');
    await expect(flow.settleFederationGrantEnd(ending)).resolves.toBe(false);
    expect(store.deleteForPurge.mock.calls).toEqual([[destination], [source]]);
    expect(objects.size).toBe(0);
    expect(
      (await sql.query('select id from federation.inbound_items where grant_id=$1', [grant.id]))
        .rows,
    ).toEqual([]);
  });

  it('only removes the sender file for a withdrawn sender that never claimed the destination', async () => {
    const { grant, itemId, bytes, source, destination } = await queuedFile();
    const { store, objects } = transferStore();
    objects.set(source, bytes);
    objects.set(destination, Buffer.from('Generated copy owned elsewhere'));
    await withTenantTx(app.db, sharing(), (tx) =>
      tx
        .update(federationOutboundItems)
        .set({ state: 'withdrawn', withdrawnAt: new Date(), version: 2 })
        .where(eq(federationOutboundItems.id, itemId)),
    );
    const flow = transport(store);
    await expect(
      flow.purgeFederationItem({ organizationId: sharing().organizationId, itemId }),
    ).resolves.toEqual({ purged: 0, more: false });
    expect(store.deleteForPurge.mock.calls).toEqual([[source]]);
    expect(objects.get(destination)?.toString()).toBe('Generated copy owned elsewhere');
    expect(
      (await sql.query('select id from federation.outbound_items where grant_id=$1', [grant.id]))
        .rows,
    ).toEqual([]);
  });
});
