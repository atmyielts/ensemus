// Owned by the sdk slice. See docs/06-delivery/m3-slices.md.
import type { SyncPage } from '@ensemus/domain/connector';
import type { Connector, ConnectorContext } from '../index';

export type SyncStreamState = {
  stream: string;
  cursor: string | null;
  generation: number;
  fullSync: boolean;
  fullSyncGeneration: number;
};

/** Where a pass keeps its state. The worker backs this on to the application service. */
export interface SyncStore {
  /** Takes the stream's lease, or returns null if another pass holds it. */
  lease(stream: string, leaseMs: number): Promise<SyncStreamState | null>;
  /**
   * Commits a page and the cursor it moves to in one transaction, if the generation still matches.
   * Returns the new state, or null if it lost the race, in which case this pass stops.
   */
  commitPage(state: SyncStreamState, page: SyncPage): Promise<SyncStreamState | null>;
  finish(stream: string, outcome: { ok: true } | { ok: false; code: string }): Promise<void>;
  markResyncRequired(stream: string): Promise<void>;
}

export type SyncPassDeps = {
  connector: Connector;
  context: Omit<ConnectorContext, 'signal'>;
  store: SyncStore;
  /** Pages per stream in one pass. The next pass carries on from the cursor. */
  maxPages: number;
};

export type SyncPassResult = { streams: number; pages: number; resources: number };

/** One pass over the connector's streams. Applying a page twice changes nothing. */
export function runSyncPass(_deps: SyncPassDeps): Promise<SyncPassResult> {
  throw new Error('NOT_IMPLEMENTED');
}
