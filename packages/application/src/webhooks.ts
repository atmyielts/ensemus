// Owned by the webhooks slice (CONNECT-02). See docs/06-delivery/m3-slices.md and ADR-027 D4.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type {
  SignatureScheme,
  WebhookDeliveryState,
  WebhookEffect,
  WebhookIngressOutcome,
  WebhookRejectCode,
} from '@ensemus/domain/webhook';
import type { StoredDelivery, WebhookEffectHandlers } from './integration-ports';

export type IngestWebhookInput = {
  /** The opaque part of the URL. Only its hash is looked up. */
  token: string;
  body: Uint8Array;
  /** Request headers, lower case. Only those on the scheme's allowlist are kept. */
  headers: Readonly<Record<string, string>>;
};

/**
 * What the web tier does, with no session and no secret: finds the endpoint by the token's hash, admits
 * the bytes against its limits, stores them with an outbox event, and answers. It believes nothing it
 * was sent. An exact repeat stores nothing and answers the same. Uses withWebhookEndpointTx.
 */
export function ingestWebhookDelivery(
  _database: AppDatabase,
  _input: IngestWebhookInput,
  _options?: {
    /** Refuses while this tenant is being restored. */
    assertServing?: (context: TenantContext) => Promise<void>;
  },
): Promise<WebhookIngressOutcome> {
  throw new Error('NOT_IMPLEMENTED');
}

export type CreatedWebhookEndpoint = {
  endpointId: string;
  /** Goes in the URL. Shown once, and only its hash is kept. */
  token: string;
};

/** Needs connection.manage. Generates the token here, and takes a secret the caller already sealed. */
export function createWebhookEndpoint(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { connectionId: string; signingSecretId: string; signatureScheme: SignatureScheme },
): Promise<CreatedWebhookEndpoint> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Needs connection.manage. Takes effect at once: the address answers as if it never existed. */
export function disableWebhookEndpoint(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { endpointId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Reads a delivery for the worker. Null if it is not waiting any more, so a retry does nothing. */
export function loadStoredDelivery(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { deliveryId: string },
): Promise<StoredDelivery | null> {
  throw new Error('NOT_IMPLEMENTED');
}

export type DeliveryStep = Extract<WebhookDeliveryState, 'applied' | 'duplicate' | 'rejected'>;

/**
 * Records a rejection and drops the bytes. A valid old payload ends here, with its body gone and no
 * effect, and one audit row an hour per code.
 */
export function rejectDelivery(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { deliveryId: string; code: WebhookRejectCode },
): Promise<DeliveryStep> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The signature passed. In one transaction: writes platform.inbox_events first, and if that row already
 * exists marks this `duplicate` with no effect. Otherwise applies the effects and marks it `applied`. The
 * bytes go either way.
 */
export function applyVerifiedDelivery(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    deliveryId: string;
    providerEventId: string;
    effects: readonly WebhookEffect[];
  },
  _handlers: WebhookEffectHandlers,
): Promise<DeliveryStep> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Upkeep, run from the tenant's periodic Activity. Drops bodies nobody processed within the retention
 * period, gives their bytes back, and removes old rows. Filled in by the webhooks slice.
 */
export async function purgeExpiredWebhookDeliveries(
  _database: AppDatabase,
  _context: TenantContext,
  _now: Date,
): Promise<number> {
  return 0;
}
