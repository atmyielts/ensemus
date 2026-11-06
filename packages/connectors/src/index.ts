// The Connector SDK's contract (ADR-027 D3). A connector is a typed object, not a service: it runs in
// the connector worker, reaches a credential only through a lease, opens a connection only through the
// egress gateway, and never sees the database, Temporal or a tenant other than the one it was given.
import type { Duplex } from 'node:stream';
import type { SyncPage } from '@ensemus/domain/connector';
import type {
  AttemptResult,
  ExternalActionCode,
  ReconcileResult,
} from '@ensemus/domain/external-action';
import type { SignatureScheme, WebhookEffect, WebhookRejectCode } from '@ensemus/domain/webhook';
import type { ConnectorManifest } from './manifest';

export type { ConnectorCapabilities, ConnectorManifest, ReconcileLookup } from './manifest';
export type { SyncPage, SyncedResource, SourceGrant } from '@ensemus/domain/connector';
export type { AttemptResult, ReconcileResult } from '@ensemus/domain/external-action';
export type { WebhookEffect } from '@ensemus/domain/webhook';

/**
 * The only way to a credential. It backs on to SecretBroker.withSecret, so the secret is lent for one
 * call and wiped afterwards. There is no method that returns it.
 */
export interface CredentialLease {
  withCredential<T>(use: (secret: Buffer) => Promise<T>): Promise<T>;
}

/** The only way out. The caller names no host: the gateway has one target, set by the operator. */
export interface ConnectorNetwork {
  openRelay(options: { timeoutMs: number; signal?: AbortSignal }): Promise<Duplex>;
}

export type ConnectorContext<TConfig = unknown> = {
  organizationId: string;
  connectionId: string;
  config: TConfig;
  credentials: CredentialLease;
  network: ConnectorNetwork;
  /** Aborted at the deadline. A connector has to stop, and to say what it knows. */
  signal: AbortSignal;
};

/**
 * Thrown to say, for certain, that nothing was accepted. It is the only way to get a `not_sent` from a
 * throw. Any other error, or the deadline passing, counts as `indeterminate`, because a connector that
 * forgot to think about this must not cause a second send (ADR-027 D2).
 */
export class NotSent extends Error {
  override name = 'NotSent';
  constructor(
    readonly code: ExternalActionCode,
    readonly retryable: boolean,
  ) {
    // A code, and no provider text, so this is safe to log and to cross Temporal.
    super(code);
  }
}

/** The provider says the cursor no longer works. The stream goes back to a full sync. */
export class CursorExpired extends Error {
  override name = 'CursorExpired';
  constructor() {
    super('CURSOR_EXPIRED');
  }
}

/**
 * Reading a stream failed, and trying the same page again later is safe. The code is shown to an
 * administrator only if it is on SYNC_ERROR_CODES, and reads as a plain failure otherwise.
 */
export class SyncUnavailable extends Error {
  override name = 'SyncUnavailable';
  constructor(readonly code: string) {
    super(code);
  }
}

export type ActionRequest<TPayload = unknown> = {
  externalActionId: string;
  attemptId: string;
  attemptNo: number;
  toolName: string;
  toolVersion: string;
  /** The same for every attempt at this effect. A provider that takes one is handed this. */
  idempotencyKey: string;
  requestHash: string;
  /** Exactly what was approved. A connector must not look anything up to change it. */
  payload: TPayload;
};

export interface ActionConnector<TConfig = unknown> {
  /**
   * One try. Returns what it knows, or throws NotSent. Must stop when `signal` aborts. It is never
   * called twice for an attempt, and never again at all once an attempt could have sent.
   */
  send(context: ConnectorContext<TConfig>, request: ActionRequest): Promise<AttemptResult>;
  /** Asks the provider what happened. Read-only, and safe to repeat. Never sends anything. */
  reconcile(context: ConnectorContext<TConfig>, request: ActionRequest): Promise<ReconcileResult>;
}

export type SyncRequest = {
  stream: string;
  /** Null starts from the beginning. */
  cursor: string | null;
  fullSync: boolean;
  pageSize: number;
};

export interface SyncConnector<TConfig = unknown> {
  /** Reads one page. Has no effect at the source, and repeating it with the same cursor is safe. */
  readPage(context: ConnectorContext<TConfig>, request: SyncRequest): Promise<SyncPage>;
}

export type VerifiedWebhook = {
  /** The sender's event ID, which the signature covers. */
  providerEventId: string;
  body: Uint8Array;
  signedAtSeconds: number;
};

export interface WebhookConnector<TConfig = unknown> {
  /**
   * Turns a delivery whose signature has already passed into what it asks for. Runs only after
   * verification, and throws MalformedWebhook for anything it does not recognize.
   */
  interpret(context: ConnectorContext<TConfig>, webhook: VerifiedWebhook): readonly WebhookEffect[];
}

export class MalformedWebhook extends Error {
  override name = 'MalformedWebhook';
  constructor() {
    super('MALFORMED_PAYLOAD');
  }
}

export type WebhookVerification =
  | { ok: true; providerEventId: string; signedAtSeconds: number }
  | { ok: false; code: WebhookRejectCode };

/** What verifying a signature takes, for a scheme this runtime knows. */
export type WebhookVerifyInput = {
  scheme: SignatureScheme;
  body: Uint8Array;
  headers: Readonly<Record<string, string>>;
  nowMs: number;
  toleranceSeconds: number;
};

export interface Connector<TConfig = unknown> {
  readonly manifest: ConnectorManifest;
  /** Checks a connection's stored settings. Throws for anything it does not accept. */
  parseConfig(raw: unknown): TConfig;
  readonly actions?: ActionConnector<TConfig>;
  readonly sync?: SyncConnector<TConfig>;
  readonly webhooks?: WebhookConnector<TConfig>;
}

export interface ConnectorRegistry {
  get(type: string): Connector | undefined;
  manifests(): readonly ConnectorManifest[];
}

/** Maps a source's principals to this tenant's people. A port, so the SDK needs no database. */
export interface PrincipalDirectory {
  /** Returns the membership or team, or null when nobody matches. Null grants nothing. */
  resolve(principal: {
    kind: 'user' | 'group' | 'domain' | 'anyone';
    externalId: string;
  }): Promise<{ membershipId: string } | { teamId: string } | null>;
}
