// Owned by the bridge slice (EXP-07). See docs/06-delivery/m11c-slices.md and ADR-035 D2 and D3. What the
// bridge role does with one grant. Everything here runs under BridgeDatabase.withGrant, and the triggers in
// migration 0703 refuse anything but an exact copy of a queued item going to the other party.
import type { BridgeDatabase } from './federation';

/**
 * What a delivery found. `delivered` also answers a repeat of a delivery that already went, since an
 * Activity can run twice. `closed` means the grant does not admit it, which is said the same way whether
 * it ended, expired, or the role was never allowed to see it.
 */
export type CrossingOutcome = 'delivered' | 'closed' | 'refused' | 'withdrawn';

export type ItemToCross = {
  itemId: string;
  kind: string;
  senderOrganizationId: string;
  receiverOrganizationId: string;
  /** The sender's key for the file, derived from the sender and the item, or null. */
  fileObjectKey: string | null;
  fileSha256: string | null;
  fileSizeBytes: number | null;
  fileMimeType: string | null;
};

/** What a queued item needs moved before it can cross. Null when the grant is closed, or it has gone. */
export function readItemToCross(
  _database: BridgeDatabase,
  _input: { grantId: string; senderOrganizationId: string; itemId: string },
): Promise<ItemToCross | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * One transaction: lock the outbound row, write the inbound copy, write a `delivered` crossing and mark it
 * delivered. A repeat finds it delivered and writes nothing. The file, if any, is already at the receiver's
 * key by now, and this is what makes it readable.
 */
export function crossItem(
  _database: BridgeDatabase,
  _input: { grantId: string; senderOrganizationId: string; itemId: string },
): Promise<CrossingOutcome> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Marks one item refused with a code from FEDERATION_REFUSE_CODES, with a `refused` crossing. */
export function refuseItem(
  _database: BridgeDatabase,
  _input: { grantId: string; senderOrganizationId: string; itemId: string; code: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export type PurgedItem = {
  itemId: string;
  receiverOrganizationId: string;
  fileObjectKey: string | null;
};

/**
 * Deletes the inbound copies of one grant, or one item of it, with a `purged` crossing for each, and says
 * which files are now to be deleted. Works on a closed grant, because that is when it is needed. Doing it
 * twice finds nothing the second time. The file's bytes go after this commits, and the caller repeats until
 * they have, so a crash leaves a file nobody can reach rather than a row pointing at nothing.
 */
export function purgeInboundCopies(
  _database: BridgeDatabase,
  _input: { grantId: string; itemId?: string; limit: number },
): Promise<readonly PurgedItem[]> {
  throw new Error('NOT_IMPLEMENTED');
}
