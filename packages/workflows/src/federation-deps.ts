// What the federation worker hands its Activities (ADR-035 D2). Nothing here reaches the web tier (lint).
import type { ObjectStore } from '@ensemus/application';
import type { TenantContext } from '@ensemus/database';
import type { BridgeDatabase } from '@ensemus/database/federation';

/**
 * What each side does for itself, under its own tenant binding and the ordinary role. A port, so the bridge's
 * tests can run without the items slice. The worker wires these to the real services in @ensemus/application,
 * and a test's doubles stay with its tests.
 */
export interface FederationFollowUp {
  /** Where a sender's item is. Finds only the sender's own. */
  loadItemGrant(
    context: TenantContext,
    itemId: string,
  ): Promise<{ grantId: string; state: 'queued' | 'delivered' | 'refused' | 'withdrawn' } | null>;
  /** Event, notification and audit row in the receiver's tenant. Keyed by the item. */
  recordItemReceived(context: TenantContext, itemId: string): Promise<void>;
  /** A party's own follow-up after a grant ended. Says which of its items had a file. */
  settleGrantEnd(
    context: TenantContext,
    grantId: string,
  ): Promise<{ outboundFileItemIds: readonly string[] }>;
}

export type FederationActivityDeps = {
  /** The one role that crosses. It sees one grant per transaction, and no business table. */
  bridge: BridgeDatabase;
  followUp: FederationFollowUp;
  /** The application's own credential, used only for the two derived prefixes under `federation/`. */
  store: ObjectStore;
};
