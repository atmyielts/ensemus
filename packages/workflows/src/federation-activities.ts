// Owned by the bridge slice (EXP-07). See docs/06-delivery/m11c-slices.md and ADR-035 D3. Each takes IDs, works
// out its state from PostgreSQL, and is safe to retry. They all run on FEDERATION_TASK_QUEUE, which only the
// federation worker polls, so with no worker nothing crosses.
import type { FederationActivityDeps } from './federation-deps';
import type {
  FederationDeliveryOutcome,
  FederationGrantEndedInput,
  FederationItemInput,
  FederationPurgePass,
} from './schemas';

export function createFederationActivities(_deps: FederationActivityDeps) {
  return {
    /**
     * Carries one queued item across. Loads its grant under the sender's own binding, reads the item through
     * the bridge, copies the file to the receiver's derived key and checks its hash, then crosses in one
     * transaction. A missing or changed file is refused with a code. A closed grant answers `closed`.
     */
    async deliverFederationItem(input: FederationItemInput): Promise<FederationDeliveryOutcome> {
      void input;
      throw new Error('NOT_IMPLEMENTED');
    },
    /** The event, notification and audit row in the receiver's tenant. Keyed by the item. */
    async recordFederationItemReceived(input: FederationItemInput): Promise<void> {
      void input;
      throw new Error('NOT_IMPLEMENTED');
    },
    /** One bounded pass removing a whole grant's copies and their files. Repeated until `more` is false. */
    async purgeFederationGrantPass(input: FederationGrantEndedInput): Promise<FederationPurgePass> {
      void input;
      throw new Error('NOT_IMPLEMENTED');
    },
    /** The same for one withdrawn item. */
    async purgeFederationItem(input: FederationItemInput): Promise<FederationPurgePass> {
      void input;
      throw new Error('NOT_IMPLEMENTED');
    },
    /**
     * Each party's own follow-up once a grant has ended: queued items withdrawn, its owners told, its audit
     * row, and any file that may have been copied for a delivery that never finished.
     */
    async settleFederationGrantEnd(input: FederationGrantEndedInput): Promise<void> {
      void input;
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type FederationActivities = ReturnType<typeof createFederationActivities>;
