import { createHash } from 'node:crypto';
import {
  federationGrants,
  federationOutboundItems,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  FEDERATION_MAX_FILE_BYTES,
  inboundObjectKey,
  outboundObjectKey,
} from '@ensemus/domain/federation';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ObjectStore } from './artifacts';
import { AppError } from './errors';
import { idSchema } from './ids';
import { verifyFederationSenderFile } from './federation-source-files';

type CopyTarget = { itemId: string; grantId: string; receiverOrganizationId: string };
type FileProof = { sha256: string; sizeBytes: number };
type Directory = 'inbound' | 'outbound';

function workerId(context: TenantContext, id: string) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  return idSchema.parse(id);
}
const itemIn = (organizationId: string, id: string) =>
  and(
    eq(federationOutboundItems.organizationId, organizationId),
    eq(federationOutboundItems.id, id),
  );

async function ownGrant(tx: Tx, organizationId: string, grantId: string) {
  const [grant] = await tx
    .select({
      sharing: federationGrants.sharingOrganizationId,
      receiving: federationGrants.receivingOrganizationId,
      status: federationGrants.status,
      open: sql<boolean>`federation.grant_is_open(${federationGrants.id})
      and ${federationGrants.expiresAt} > clock_timestamp()`,
    })
    .from(federationGrants)
    .where(eq(federationGrants.id, grantId));
  if (grant?.sharing === organizationId) return { ...grant, other: grant.receiving };
  if (grant?.receiving === organizationId) return { ...grant, other: grant.sharing };
  return null;
}

/** Retry metadata belongs to the sender and remains visible when the grant closes. */
export async function loadFederationCopyState(
  database: AppDatabase,
  context: TenantContext,
  target: CopyTarget,
) {
  const id = workerId(context, target.itemId);
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({
        receiver: federationOutboundItems.copyReceiverOrganizationId,
        verified: federationOutboundItems.copyVerified,
      })
      .from(federationOutboundItems)
      .where(
        and(
          itemIn(context.organizationId, id),
          eq(federationOutboundItems.grantId, idSchema.parse(target.grantId)),
        ),
      );
    if (!row) return 'closed' as const;
    if (!row.receiver) return 'unclaimed' as const;
    if (row.receiver !== target.receiverOrganizationId)
      throw new Error('FEDERATION_COPY_TARGET_MISMATCH');
    return row.verified ? ('verified' as const) : ('claimed' as const);
  });
}

/** Only this first committed claim authorizes a single physical PUT. */
export async function claimFederationCopy(
  database: AppDatabase,
  context: TenantContext,
  target: CopyTarget,
) {
  const id = workerId(context, target.itemId);
  const grantId = idSchema.parse(target.grantId);
  const receiverOrganizationId = idSchema.parse(target.receiverOrganizationId);
  return withTenantTx(database, context, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(federation.grant_lock_key(${grantId}::uuid))`,
    );
    const itemScope = and(
      itemIn(context.organizationId, id),
      eq(federationOutboundItems.grantId, grantId),
    );
    const [item] = await tx
      .select()
      .from(federationOutboundItems)
      .where(itemScope)
      .for('no key update');
    if (!item?.fileObjectKey || item.state !== 'queued') return 'closed' as const;
    const grant = await ownGrant(tx, context.organizationId, grantId);
    if (!grant?.open || grant.other !== receiverOrganizationId) return 'closed' as const;
    if (item.copyReceiverOrganizationId !== null) {
      if (item.copyReceiverOrganizationId !== receiverOrganizationId)
        throw new Error('FEDERATION_COPY_TARGET_MISMATCH');
      return 'claimed' as const;
    }
    const [claim] = await tx
      .update(federationOutboundItems)
      .set({
        copyReceiverOrganizationId: receiverOrganizationId,
      })
      .where(itemScope)
      .returning({ id: federationOutboundItems.id });
    if (!claim) throw new Error('FEDERATION_COPY_CLAIM_LOST');
    return 'admitted' as const;
  });
}

/** A positive read of the exact one-use destination proves the admitted writer has finished. */
export async function observeFederationCopy(
  database: AppDatabase,
  context: TenantContext,
  target: CopyTarget,
  proof: FileProof,
): Promise<void> {
  const id = workerId(context, target.itemId);
  const itemScope = and(
    itemIn(context.organizationId, id),
    eq(federationOutboundItems.grantId, idSchema.parse(target.grantId)),
    eq(
      federationOutboundItems.copyReceiverOrganizationId,
      idSchema.parse(target.receiverOrganizationId),
    ),
    eq(federationOutboundItems.fileSha256, proof.sha256),
    eq(federationOutboundItems.fileSizeBytes, proof.sizeBytes),
  );
  await withTenantTx(database, context, async (tx) => {
    const [changed] = await tx
      .update(federationOutboundItems)
      .set({ copyVerified: true })
      .where(and(itemScope, eq(federationOutboundItems.copyVerified, false)))
      .returning({ id: federationOutboundItems.id });
    if (changed) return;
    const [existing] = await tx
      .select({ id: federationOutboundItems.id })
      .from(federationOutboundItems)
      .where(and(itemScope, eq(federationOutboundItems.copyVerified, true)));
    if (!existing) throw new Error('FEDERATION_COPY_VERIFICATION_REFUSED');
  });
}

async function verifyOutstandingCopy(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  item: typeof federationOutboundItems.$inferSelect,
  receiverOrganizationId: string,
): Promise<void> {
  if (!item.copyReceiverOrganizationId || item.copyVerified) return;
  if (item.copyReceiverOrganizationId !== receiverOrganizationId)
    throw new Error('FEDERATION_COPY_TARGET_MISMATCH');
  let bytes: Buffer;
  try {
    bytes = await store.get(
      inboundObjectKey(receiverOrganizationId, item.id),
      FEDERATION_MAX_FILE_BYTES,
    );
  } catch {
    // An absent key cannot settle an admitted request that might still arrive.
    throw new Error('FEDERATION_COPY_UNCONFIRMED');
  }
  const proof = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
  await observeFederationCopy(
    database,
    context,
    {
      itemId: item.id,
      grantId: item.grantId,
      receiverOrganizationId,
    },
    proof,
  );
}

function deletionColumn(directory: Directory) {
  return directory === 'inbound'
    ? federationOutboundItems.inboundDeleteState
    : federationOutboundItems.outboundDeleteState;
}

async function updateDeletion(
  database: AppDatabase,
  context: TenantContext,
  itemId: string,
  directory: Directory,
  from: 'pending' | 'admitted',
  to: 'admitted' | 'proved',
) {
  return withTenantTx(database, context, async (tx) => {
    const update =
      directory === 'inbound' ? { inboundDeleteState: to } : { outboundDeleteState: to };
    const [result] = await tx
      .update(federationOutboundItems)
      .set(update)
      .where(and(itemIn(context.organizationId, itemId), eq(deletionColumn(directory), from)))
      .returning({ id: federationOutboundItems.id });
    return !!result;
  });
}

/** After an uncertain DELETE only observe absence. The durable claim prevents duplicate DELETEs. */
async function proveObjectGone(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  itemId: string,
  directory: Directory,
  key: string,
) {
  const [item] = await withTenantTx(database, context, (tx) =>
    tx
      .select({ state: deletionColumn(directory) })
      .from(federationOutboundItems)
      .where(itemIn(context.organizationId, itemId)),
  );
  if (!item || item.state === 'proved') return;
  if (!store.isPhysicallyAbsent || !store.deleteForPurge || !store.assertPurgeCapability)
    throw new Error('FEDERATION_DELETE_CAPABILITY_REQUIRED');
  try {
    await store.assertPurgeCapability();
    if (await store.isPhysicallyAbsent(key)) {
      await updateDeletion(
        database,
        context,
        itemId,
        directory,
        item.state === 'admitted' ? 'admitted' : 'pending',
        'proved',
      );
      return;
    }
    if (item.state !== 'pending') throw new Error('FEDERATION_DELETE_UNCONFIRMED');
    if (!(await updateDeletion(database, context, itemId, directory, 'pending', 'admitted')))
      throw new Error('FEDERATION_DELETE_UNCONFIRMED');
    // No store request runs before the claim commits. Errors after this only allow a read on retry.
    await store.deleteForPurge(key);
    if (!(await store.isPhysicallyAbsent(key))) throw new Error('FEDERATION_DELETE_UNCONFIRMED');
    await updateDeletion(database, context, itemId, directory, 'admitted', 'proved');
  } catch {
    throw new Error('FEDERATION_DELETE_UNCONFIRMED');
  }
}

type Outbound = typeof federationOutboundItems.$inferSelect;
async function eraseOutbound(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  item: Outbound,
  receiverOrganizationId: string | null,
) {
  if (item.fileObjectKey) {
    if (!receiverOrganizationId) throw new Error('FEDERATION_COPY_TARGET_MISMATCH');
    await verifyFederationSenderFile(database, store, context, item);
    if (item.copyReceiverOrganizationId) {
      await verifyOutstandingCopy(database, store, context, item, receiverOrganizationId);
      await proveObjectGone(
        database,
        store,
        context,
        item.id,
        'inbound',
        inboundObjectKey(receiverOrganizationId, item.id),
      );
    } else {
      // This sender never acquired the destination. A different grant could own that key.
      if (item.deliveredAt) throw new Error('FEDERATION_LEGACY_COPY_UNPROVEN');
      await updateDeletion(database, context, item.id, 'inbound', 'pending', 'proved');
    }
    if (item.sourceUploadState === 'pending') {
      // No sender write was admitted for this generated key.
      await updateDeletion(database, context, item.id, 'outbound', 'pending', 'proved');
    } else {
      await proveObjectGone(
        database,
        store,
        context,
        item.id,
        'outbound',
        outboundObjectKey(context.organizationId, item.id),
      );
    }
  }
  await withTenantTx(database, context, (tx) =>
    tx
      .delete(federationOutboundItems)
      .where(
        and(
          itemIn(context.organizationId, item.id),
          eq(federationOutboundItems.grantId, item.grantId),
        ),
      ),
  );
}

/** The Activities remove inbound rows first. The sender's row pins both keys until deletion is proved. */
export async function removeWithdrawnItem(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  itemId: string,
): Promise<void> {
  const id = workerId(context, itemId);
  const prepared = await withTenantTx(database, context, async (tx) => {
    const [item] = await tx
      .select()
      .from(federationOutboundItems)
      .where(
        and(
          itemIn(context.organizationId, id),
          inArray(federationOutboundItems.state, ['withdrawn', 'refused']),
        ),
      );
    if (!item) return null;
    const grant = await ownGrant(tx, context.organizationId, item.grantId);
    if (!grant) throw new Error('FEDERATION_COPY_TARGET_MISMATCH');
    return { item, receiver: grant.other };
  });
  if (prepared) await eraseOutbound(database, store, context, prepared.item, prepared.receiver);
}

const settlementSize = 20;
export async function settleGrantEndForTenant(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { grantId: string; counterpartyOrganizationId: string },
): Promise<boolean> {
  const grantId = workerId(context, input.grantId);
  const items = await withTenantTx(database, context, async (tx) => {
    const grant = await ownGrant(tx, context.organizationId, grantId);
    if (grant?.status !== 'ended' || grant.other !== input.counterpartyOrganizationId) return [];
    const rows = await tx
      .select()
      .from(federationOutboundItems)
      .where(
        and(
          eq(federationOutboundItems.organizationId, context.organizationId),
          eq(federationOutboundItems.grantId, grantId),
        ),
      )
      .orderBy(asc(federationOutboundItems.id))
      .limit(settlementSize)
      .for('no key update');
    for (const item of rows) {
      if (item.state !== 'queued' && item.state !== 'delivered') continue;
      await tx
        .update(federationOutboundItems)
        .set({
          state: 'withdrawn',
          withdrawnAt: new Date(),
          version: item.version + 1,
        })
        .where(itemIn(context.organizationId, item.id));
    }
    return rows;
  });
  for (const item of items)
    await eraseOutbound(database, store, context, item, input.counterpartyOrganizationId);
  return items.length === settlementSize;
}
