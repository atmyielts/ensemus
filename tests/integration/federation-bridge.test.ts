import { inboundObjectKey, itemContentHash, outboundObjectKey } from '@ensemus/domain/federation';
import {
  federationGrants,
  federationInboundItems,
  federationOutboundItems,
  openAppDatabase,
  withTenantTx,
} from '@ensemus/database';
import {
  endGrant,
  loadGrantPartiesForWorker,
  loadItemGrantForWorker,
  recordItemReceived,
} from '@ensemus/application';
import { createServiceContext } from '@ensemus/database/service';
import { federationItemTargetRef } from '@ensemus/domain/federation-events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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
});
