// Ports for connectors and external actions (ADR-027). Application services name what they need, and the
// connector worker supplies it, so nothing here depends on a connector, SMTP or Temporal.
import type { TenantContext, Tx } from '@ensemus/database';
import type { SyncPage } from '@ensemus/domain/connector';
import type { AttemptResult, ReconcileResult } from '@ensemus/domain/external-action';
import type { SignatureScheme, WebhookEffect, WebhookRejectCode } from '@ensemus/domain/webhook';

/** Lends a secret for one call. SecretBroker implements this. There is no way to keep what it lends. */
export interface SecretLease {
  withSecret<T>(
    binding: { organizationId: string; secretId: string; purpose: string },
    use: (secret: Buffer) => Promise<T>,
  ): Promise<T>;
  /** Stops a sealed value ever being opened again, for a revoked connection. */
  revoke(organizationId: string, secretId: string): Promise<unknown>;
}

/** Everything needed to contact a provider for one attempt. Lives only in the worker's memory. */
export type PreparedAttempt = {
  externalActionId: string;
  attemptId: string;
  attemptNo: number;
  toolName: string;
  toolVersion: string;
  idempotencyKey: string;
  requestHash: string;
  payload: unknown;
  connection: {
    id: string;
    connectorType: string;
    config: unknown;
    credentialSecretId: string | null;
  };
};

/** Performs effects. The connector worker implements this over the Connector SDK. */
export interface ExternalActionGateway {
  send(organizationId: string, attempt: PreparedAttempt): Promise<AttemptResult>;
  reconcile(organizationId: string, attempt: PreparedAttempt): Promise<ReconcileResult>;
  /** How far this connector's lookup can be believed. */
  lookupOf(connectorType: string): 'none' | 'best_effort' | 'authoritative';
}

/** What a stored delivery looks like to the worker that verifies it. */
export type StoredDelivery = {
  id: string;
  endpointId: string;
  connectionId: string;
  connectorType: string;
  scheme: SignatureScheme;
  body: Buffer;
  headers: Readonly<Record<string, string>>;
  sizeBytes: number;
  toleranceSeconds: number;
  signingSecretId: string;
  previousSigningSecretId: string | null;
};

export type DeliveryVerdict =
  | { ok: true; providerEventId: string; effects: readonly WebhookEffect[] }
  | { ok: false; code: WebhookRejectCode };

/** Checks a signature and interprets the body. The connector worker implements this. */
export interface WebhookVerifier {
  verify(organizationId: string, delivery: StoredDelivery, nowMs: number): Promise<DeliveryVerdict>;
}

/**
 * What a verified delivery's effects do, in the transaction that wrote its inbox row. A port, so webhooks
 * need not know how an intent or a sync starts. The connector worker wires these to the real services.
 */
export interface WebhookEffectHandlers {
  proposeAction(
    tx: Tx,
    context: TenantContext,
    effect: Extract<WebhookEffect, { kind: 'action_proposed' }>,
  ): Promise<void>;
  requestSync(tx: Tx, context: TenantContext, connectionId: string): Promise<void>;
  /**
   * M8 (ADR-032 D4). Holds a processor's verified event in this organization's table, which is the
   * deployment's own, with an outbox event to route it. `applyVerifiedDelivery` must call this for
   * `payment_event`, and on no account fall through to `requestSync`.
   */
  recordPaymentEvent(
    tx: Tx,
    context: TenantContext,
    effect: Extract<WebhookEffect, { kind: 'payment_event' }>,
    /** Actual stored endpoint/inbox identity, never a body's claimed routing fields. */
    source: Readonly<{ endpointId: string; connectionId: string; providerEventId: string }>,
  ): Promise<void>;
}

/** The state of one stream, as a sync pass sees it. */
export type SyncStreamLease = {
  stream: string;
  cursor: string | null;
  generation: number;
  fullSync: boolean;
  fullSyncGeneration: number;
};

export type { SyncPage };
