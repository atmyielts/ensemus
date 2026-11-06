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

// Literals rather than the domain's constants, so a page importing this pulls in nothing that uses
// Node's crypto. A test holds them equal, and the conformance suite holds each connector to its entry.
export const EMAIL_CONNECTOR_MANIFEST: ConnectorManifest = {
  type: 'email_smtp',
  version: '1',
  displayName: 'Email (SMTP)',
  capabilities: {
    actions: ['email.send'],
    reconcile: 'none',
    nativeIdempotency: false,
    sync: null,
    aclMapping: false,
    webhooks: null,
    network: 'egress_gateway',
  },
  credential: { required: true, purpose: 'connector_credential' },
};

export const INBOUND_CONNECTOR_MANIFEST: ConnectorManifest = {
  type: 'inbound_webhook',
  version: '1',
  displayName: 'Signed webhook',
  capabilities: {
    actions: [],
    reconcile: 'none',
    nativeIdempotency: false,
    sync: null,
    aclMapping: false,
    webhooks: { scheme: 'ensemus_hmac_sha256_v1' },
    network: 'none',
  },
  // A connection of this type holds no credential. Its secret is the endpoint's signing secret.
  credential: { required: false, purpose: 'webhook_signing' },
};

/** Every connector this product ships, for pages that show what can be connected. */
export const CONNECTOR_MANIFESTS: readonly ConnectorManifest[] = [
  EMAIL_CONNECTOR_MANIFEST,
  INBOUND_CONNECTOR_MANIFEST,
];

export const manifestFor = (type: string): ConnectorManifest | undefined =>
  CONNECTOR_MANIFESTS.find((manifest) => manifest.type === type);
