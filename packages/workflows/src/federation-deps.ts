// What the federation worker hands its Activities (ADR-035 D2). Nothing here reaches the web tier (lint).
import type { ObjectStore, SenderFilePreparation } from '@ensemus/application';
import type { TenantContext } from '@ensemus/database';
import type { BridgeDatabase } from '@ensemus/database/federation';

/**
 * What each side does for itself, under its own tenant binding and the ordinary role. A port, so the bridge's
 * tests can run without the items slice. The worker wires these to the real services in @ensemus/application,
 * and a test's doubles stay with its tests.
 */
type CopyTarget = { itemId: string; grantId: string; receiverOrganizationId: string };

export interface FederationFollowUp {
  prepareSenderFile(
    context: TenantContext,
    input: { itemId: string; grantId: string },
  ): Promise<SenderFilePreparation>;
  loadFileCopy(
    context: TenantContext,
    target: CopyTarget,
  ): Promise<'closed' | 'unclaimed' | 'claimed' | 'verified'>;
  claimFileCopy(
    context: TenantContext,
    target: CopyTarget,
  ): Promise<'admitted' | 'claimed' | 'closed'>;
  observeFileCopy(
    context: TenantContext,
    target: CopyTarget,
    proof: {
      sha256: string;
      sizeBytes: number;
    },
  ): Promise<void>;
  /** Where a sender's item is. Finds only the sender's own. */
  loadItemGrant(
    context: TenantContext,
    itemId: string,
  ): Promise<{ grantId: string; state: 'queued' | 'delivered' | 'refused' | 'withdrawn' } | null>;
  /** Event, notification and audit row in the receiver's tenant. Keyed by the item. */
  recordItemReceived(context: TenantContext, itemId: string): Promise<void>;
  /** The two parties, read as one of them. The other side's own binding is made from this. */
  loadGrantParties(
    context: TenantContext,
    grantId: string,
  ): Promise<{ sharingOrganizationId: string; receivingOrganizationId: string | null } | null>;
  /** A party's own follow-up after a grant ended, once every inbound copy is gone. */
  settleGrantEnd(
    context: TenantContext,
    input: { grantId: string; counterpartyOrganizationId: string },
  ): Promise<boolean>;
  /** Deletes one withdrawn item's row and file, once its inbound copy is gone. */
  removeWithdrawnItem(context: TenantContext, itemId: string): Promise<void>;
}

export type FederationActivityDeps = {
  /** The one role that crosses. It sees one grant per transaction, and no business table. */
  bridge: BridgeDatabase;
  followUp: FederationFollowUp;
  /** The application's own credential, used for the authorized sender artifact and derived federation copies. */
  store: ObjectStore;
};
