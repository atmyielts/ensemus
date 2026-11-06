// What a connector says it can do. Plain data with no I/O, so it is the one part of this package the web
// tier may import, to show which connectors exist and refuse what one cannot do (ADR-027 D3).
import type { SignatureScheme } from '@ensemus/domain/webhook';

export type ReconcileLookup =
  /** The provider has no way to ask. After a timeout the intent stays unknown for a person. */
  | 'none'
  /** It can find a sent action, but not finding one proves nothing. */
  | 'best_effort'
  /** Not finding it means it did not happen, so another try is safe. */
  | 'authoritative';

export type ConnectorCapabilities = {
  /** Tools this connector can perform, each by its name in the approval's action. */
  actions: readonly string[];
  /** Only meaningful with actions. */
  reconcile: ReconcileLookup;
  /** The provider dedupes on our key, so an accidental repeat cannot make a second effect. */
  nativeIdempotency: boolean;
  /** Named streams it can read incrementally, or null. */
  sync: { streams: readonly string[]; pageSize: number } | null;
  /** Whether it reports source permissions. Without this its resources stay unmapped, and denied. */
  aclMapping: boolean;
  /** How it signs callbacks, or null if it has none. */
  webhooks: { scheme: SignatureScheme } | null;
  /** `none` runs with no outside contact at all. Anything else goes only through the gateway. */
  network: 'none' | 'egress_gateway';
};

export type ConnectorManifest = {
  /** Stored on the connection. Lower case, and matches the check in migration 0012. */
  type: string;
  version: string;
  displayName: string;
  capabilities: ConnectorCapabilities;
  /** Whether a connection needs a sealed credential, and what the broker is told it is for. */
  credential: { required: boolean; purpose: string };
};
