// Owned by the items slice (EXP-07). See docs/06-delivery/m11c-slices.md and ADR-035 D3 and D4. What is sent,
// from a tenant's own rows, and what arrived, as that tenant sees it. Nothing here crosses anything: the
// bridge worker carries a queued item later. Sending takes federation.share, and reading takes federation.view.
import type { PublishItemBody } from '@ensemus/contracts/federation';
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
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

/**
 * After a grant ended, as a worker with a service context, once for each party. Marks this tenant's queued
 * items withdrawn, tells this tenant's owners and writes its audit row. Repeating it changes nothing.
 */
export function settleGrantEndForTenant(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { grantId: string },
): Promise<{ outboundFileItemIds: readonly string[] }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * After a copy landed, as a worker with a service context for the receiver: the event, the notification to
 * its owners and admins, and the audit row. Keyed by the item, so a repeat writes nothing.
 */
export function recordItemReceived(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { itemId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Where a sender's item is, for the worker. Bound to the sender's tenant, so it finds only its own. */
export function loadItemGrantForWorker(
  _database: AppDatabase,
  _context: TenantContext,
  _itemId: string,
): Promise<{ grantId: string; state: FederationItemState } | null> {
  throw new Error('NOT_IMPLEMENTED');
}
