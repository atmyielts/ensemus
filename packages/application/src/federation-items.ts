// Owned by the items slice (EXP-07). See docs/06-delivery/m11c-slices.md and ADR-035 D3 and D4. What is sent,
// from a tenant's own rows, and what arrived, as that tenant sees it. Nothing here crosses anything: the
// bridge worker carries a queued item later. Sending takes federation.share, and reading takes federation.view.
import type { PublishItemBody } from '@ensemus/contracts/federation';
import {
  domainEvents,
  federationGrants,
  federationInboundItems,
  federationOutboundItems,
  memberships,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  AGGREGATE_FEDERATION_ITEM,
  AUDIT_FEDERATION_ITEM_RECEIVED,
  FEDERATION_ITEM_RECEIVED,
  federationItemTargetRef,
  NOTIFY_FEDERATION_ITEM_RECEIVED,
} from '@ensemus/domain/federation-events';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { AppError } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { auditAction, notify } from './work';
import type {
  FederationCrossingOutcome,
  FederationDisposition,
  FederationItemKind,
  FederationItemState,
} from '@ensemus/domain/federation';
import type { ObjectStore } from './artifacts';

export type OutboundItemView = {
  id: string;
  grantId: string;
  kind: FederationItemKind;
  title: string;
  body: unknown;
  classification: string;
  state: FederationItemState;
  refuseCode: string | null;
  hasFile: boolean;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  withdrawnAt: Date | null;
  version: number;
};

export type InboundItemView = {
  id: string;
  grantId: string;
  kind: FederationItemKind;
  title: string;
  body: unknown;
  classification: string;
  senderName: string;
  senderFingerprint: string;
  hasFile: boolean;
  fileSizeBytes: number | null;
  fileMimeType: string | null;
  disposition: FederationDisposition;
  linkedWorkUnitId: string | null;
  receivedAt: Date;
  version: number;
};

export type CrossingView = {
  id: string;
  grantId: string;
  itemId: string | null;
  direction: 'sent' | 'received';
  kind: FederationItemKind | null;
  outcome: FederationCrossingOutcome;
  code: string | null;
  contentSha256: string | null;
  crossedAt: Date;
};

/**
 * Makes a copy from the sender's own row, holding only the contract's fields, and queues it. Classification
 * always comes from the source row, or from the request for a status update, which has none. A person who
 * cannot read the source gets not found. For a file, the bytes go to the derived outbound key first and the
 * row second, as artifacts do. Emits federation.item_published. A repeat with the same `requestKey` returns
 * the first. Uses the idempotency service.
 */
export function publishItem(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _input: { grantId: string; item: PublishItemBody; requestKey: string },
): Promise<OutboundItemView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Takes one item back, before or after it arrived. Emits federation.item_withdrawn, and the purge removes
 * the receiver's copy. The receiver may already have read it, and the page says so.
 */
export function withdrawItem(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { itemId: string; expectedVersion: number },
): Promise<OutboundItemView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Withdraws everything sent from one source record, in the caller's transaction, because the record is being
 * deleted. Returns how many. The final merge calls this from the tombstone paths in work and artifacts.
 */
export function withdrawItemsForSourceInTx(
  _tx: Tx,
  _context: TenantContext,
  _source: { sourceType: 'work_unit' | 'artifact'; sourceId: string },
): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listOutboundItems(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { grantId: string },
): Promise<readonly OutboundItemView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Only while the grant is open, because of the policy on the table. There is no other answer to give. */
export function listInboundItems(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { disposition?: FederationDisposition },
): Promise<readonly InboundItemView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getInboundItem(
  _database: AppDatabase,
  _context: TenantContext,
  _itemId: string,
): Promise<InboundItemView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The bytes of an arrived file, with an audit row in this tenant. Checks the grant again after reading, so a
 * revocation during the read cannot be answered with bytes, and checks the hash it was sent with.
 */
export function readInboundFile(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _itemId: string,
): Promise<{ body: Buffer; mimeType: string; title: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** A person's answer. Accepting starts nothing, and only records the Work Unit they made, if any. */
export function disposeInboundItem(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    itemId: string;
    disposition: 'accepted' | 'rejected';
    linkedWorkUnitId: string | null;
    expectedVersion: number;
  },
): Promise<InboundItemView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Everything that crossed either way for this tenant, for the people who answer for it. */
export function listCrossings(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { grantId?: string; cursor?: string; limit: number },
): Promise<{ items: readonly CrossingView[]; nextCursor: string | null }> {
  throw new Error('NOT_IMPLEMENTED');
}

export { removeWithdrawnItem, settleGrantEndForTenant } from './federation-file-lifecycle';

function workerReferenceId(context: TenantContext, id: string): string {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

/** The receiving tenant records a reference to the still-readable item once. */
export async function recordItemReceived(
  database: AppDatabase,
  context: TenantContext,
  input: { itemId: string },
): Promise<void> {
  const itemId = workerReferenceId(context, input.itemId);
  await withTenantTx(database, context, async (tx) => {
    const itemScope = and(
      eq(federationInboundItems.organizationId, context.organizationId),
      eq(federationInboundItems.id, itemId),
    );
    const [arrived] = await tx
      .select({ grantId: federationInboundItems.grantId })
      .from(federationInboundItems)
      .where(itemScope);
    if (!arrived) return;

    // Recheck visibility after the lock used by revocation, then serialize notice retries on the item.
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(federation.grant_lock_key(${arrived.grantId}::uuid))`,
    );
    const [item] = await tx
      .select({
        id: federationInboundItems.id,
        classification: federationInboundItems.classification,
      })
      .from(federationInboundItems)
      .where(and(itemScope, eq(federationInboundItems.grantId, arrived.grantId)))
      .for('no key update');
    if (!item) return;

    const [recorded] = await tx
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.organizationId, context.organizationId),
          eq(domainEvents.aggregateType, AGGREGATE_FEDERATION_ITEM),
          eq(domainEvents.aggregateId, item.id),
          eq(domainEvents.eventType, FEDERATION_ITEM_RECEIVED),
        ),
      )
      .limit(1);
    if (recorded) return;

    const targetRef = federationItemTargetRef(item.id);
    const recipients = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          inArray(memberships.role, ['owner', 'admin']),
        ),
      );
    await emit(tx, context, {
      eventType: FEDERATION_ITEM_RECEIVED,
      aggregateType: AGGREGATE_FEDERATION_ITEM,
      aggregateId: item.id,
      aggregateVersion: 1,
      classification: item.classification,
      payload: {},
    });
    await notify(
      tx,
      context,
      recipients.map(({ id }) => id),
      NOTIFY_FEDERATION_ITEM_RECEIVED,
      targetRef,
    );
    await auditAction(tx, context, AUDIT_FEDERATION_ITEM_RECEIVED, targetRef);
  });
}

/** The worker resolves the parties only while bound to one of them. */
export async function loadGrantPartiesForWorker(
  database: AppDatabase,
  context: TenantContext,
  grantId: string,
): Promise<{ sharingOrganizationId: string; receivingOrganizationId: string | null } | null> {
  const id = workerReferenceId(context, grantId);
  return withTenantTx(database, context, async (tx) => {
    const [grant] = await tx
      .select({
        sharingOrganizationId: federationGrants.sharingOrganizationId,
        receivingOrganizationId: federationGrants.receivingOrganizationId,
      })
      .from(federationGrants)
      .where(
        and(
          eq(federationGrants.id, id),
          or(
            eq(federationGrants.sharingOrganizationId, context.organizationId),
            eq(federationGrants.receivingOrganizationId, context.organizationId),
          ),
        ),
      );
    return grant ?? null;
  });
}

export async function loadItemGrantForWorker(
  database: AppDatabase,
  context: TenantContext,
  itemId: string,
): Promise<{ grantId: string; state: FederationItemState } | null> {
  const id = workerReferenceId(context, itemId);
  return withTenantTx(database, context, async (tx) => {
    const [item] = await tx
      .select({
        grantId: federationOutboundItems.grantId,
        state: federationOutboundItems.state,
      })
      .from(federationOutboundItems)
      .where(
        and(
          eq(federationOutboundItems.organizationId, context.organizationId),
          eq(federationOutboundItems.id, id),
        ),
      );
    return item ? { grantId: item.grantId, state: item.state as FederationItemState } : null;
  });
}
