// Taking payment (BILL-01). No processor is chosen: that is the owner's decision (ADR-032 D4). This file
// is the contract any adapter has to meet, and the rules above it. It carries ADR-027 D2 over unchanged,
// because charging someone twice is the same failure as sending an email twice.
// The types and tables are fixed. The functions are owned by the payments slice.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@ensemus/domain/approval';
import type { PaymentEventKind, PaymentEventFact } from '@ensemus/domain/webhook';
import type { Micros } from './money';

export const PAYMENT_STATUSES = [
  'ready',
  'sending',
  'reconciling',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Matches `billing.check_payment_change` in migration 0501, and a test holds the two together. */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  ready: ['sending', 'failed', 'cancelled'],
  sending: ['succeeded', 'failed', 'ready', 'reconciling'],
  reconciling: ['succeeded', 'failed', 'ready', 'unknown'],
  unknown: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const PAYMENT_ATTEMPT_OUTCOMES = [
  'succeeded',
  'declined',
  'not_sent',
  'indeterminate',
] as const;
export type PaymentAttemptOutcome = (typeof PAYMENT_ATTEMPT_OUTCOMES)[number];

/** Stored reasons. Text from a processor never goes on a row, in a log or across Temporal. */
export const PAYMENT_CODES = [
  'CHARGED',
  'DECLINED',
  'AUTHENTICATION_REQUIRED',
  'CUSTOMER_NOT_FOUND',
  'NO_PAYMENT_METHOD',
  'CONNECTION_REFUSED',
  'TIMEOUT_BEFORE_SEND',
  'TIMEOUT_AFTER_SEND',
  'CONNECTION_LOST_AFTER_SEND',
  'RATE_LIMITED',
  'PROCESSOR_ERROR',
  'PROCESSOR_NOT_CONFIGURED',
  'ATTEMPTS_EXHAUSTED',
  'INVOICE_NOT_OPEN',
  'TENANT_NOT_BILLABLE',
  'FOUND_BY_LOOKUP',
  'REFUSED_BY_LOOKUP',
  'NOT_FOUND_BY_LOOKUP',
  'CANNOT_ANSWER',
  'CONFIRMED_BY_EVENT',
  'REFUSED_BY_EVENT',
  'CONFIRMED_BY_PERSON',
  'DENIED_BY_PERSON',
] as const;
export type PaymentCode = (typeof PAYMENT_CODES)[number];

export const MAX_PAYMENT_ATTEMPTS = 5;

/** Fixed by the payment, so the same key goes to the processor on every attempt. Required of an adapter. */
export const paymentIdempotencyKey = (organizationId: string, paymentId: string) =>
  `ensemus-payment:${organizationId}:${paymentId}`;

export type ChargeRequest = {
  paymentId: string;
  attemptNo: number;
  idempotencyKey: string;
  amountMicros: Micros;
  currency: string;
  /** An adapter converts micros to what its API takes, and refuses an amount that does not fit. */
  minorUnitExponent: number;
  customerRef: string;
};

/**
 * What a charge did. Only `not_sent` allows another attempt, and an adapter has to say so on purpose: any
 * other failure, and any error thrown, counts as `indeterminate`, so an adapter that forgot to think about
 * this cannot cause a second charge.
 */
export type ChargeResult =
  | { outcome: 'succeeded'; code: 'CHARGED'; processorPaymentRef: string }
  | { outcome: 'declined'; code: PaymentCode; processorPaymentRef: string | null }
  | { outcome: 'not_sent'; code: PaymentCode; retryable: boolean }
  | { outcome: 'indeterminate'; code: PaymentCode };

export type PaymentLookupResult =
  | { found: 'succeeded'; processorPaymentRef: string }
  | { found: 'declined'; processorPaymentRef: string | null }
  | { found: 'not_found' }
  | { found: 'cannot_answer' };

/** What an adapter gets, and it is all it gets: a lent credential, the gateway, and a deadline. */
export type ProcessorCallContext = {
  /** Lent for one call and wiped afterwards. There is no way to keep it. */
  withCredential<T>(use: (secret: Buffer) => Promise<T>): Promise<T>;
  /** Goes through the egress gateway. It takes no host, because the operator set the one target. */
  request(input: {
    method: 'GET' | 'POST';
    path: string;
    headers: Readonly<Record<string, string>>;
    body?: Uint8Array;
    timeoutMs: number;
      /** The gateway must bound the response before buffering it. */
      maxResponseBytes?: number;
    }): Promise<{ status: number; body: Uint8Array; transportReceipt?: unknown }>;
  signal: AbortSignal;
};

export type ProcessorManifest = {
  /** Stored on a payment and an account. Lower case. */
  processor: string;
  version: string;
  /** How far a lookup can be believed, the same as ADR-027 D2. */
  lookup: 'none' | 'best_effort' | 'authoritative';
  /** Must be true: a processor that cannot dedupe on our key is not acceptable for this. */
  nativeIdempotency: true;
  /** The `SIGNATURE_SCHEMES` entry its webhooks use, added with the adapter. */
  webhookScheme: string;
};

/** Derived by the native adapter from authenticated, read-only provider identity I/O, never a payload label. */
export type PaymentExecutionIdentity = {
  version: 'ensemus.payment-execution/v1';
  processor: string;
  adapterVersion: string;
  environment: string;
  merchantAccountSha256: string;
  apiOrigins: readonly string[];
};

export type PaymentConnectionAuthority = Readonly<{
  billingOrganizationId: string;
  connectionId: string;
  connectionVersion: string;
  credentialSecretId: string;
  processor: string;
  adapterVersion: string;
  apiOrigin: string;
  configSha256: string;
  authoritySha256: string;
}>;
export type PaymentGatewayBinding = Readonly<{
  organizationId: string;
  paymentId: string;
  authority: PaymentConnectionAuthority;
  phase: 'identity' | 'customer' | 'customer_lookup' | 'charge' | 'lookup';
  executionBinding?: Readonly<{ id: string; identitySha256: string; bindingSha256: string }>;
  identityProof?: unknown;
  attemptId?: string;
  customerToken?: string;
}>;

/** A bounded canonical public identity. Validation is not authentication; the native verifier supplies it. */
export function paymentExecutionIdentity(
  value: unknown,
  manifest: Pick<ProcessorManifest, 'processor' | 'version'>,
): { identity: PaymentExecutionIdentity; sha256: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'adapterVersion,apiOrigins,environment,merchantAccountSha256,processor,version'
    || v.version !== 'ensemus.payment-execution/v1' || v.processor !== manifest.processor
    || v.adapterVersion !== manifest.version || typeof v.environment !== 'string'
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(v.environment) || typeof v.merchantAccountSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(v.merchantAccountSha256) || !Array.isArray(v.apiOrigins)
    || v.apiOrigins.length < 1 || v.apiOrigins.length > 8 || new Set(v.apiOrigins).size !== v.apiOrigins.length) return null;
  for (const origin of v.apiOrigins) {
    try {
      if (typeof origin !== 'string' || origin.length > 2048) return null;
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return null;
    } catch { return null; }
  }
  const identity: PaymentExecutionIdentity = {
    version: 'ensemus.payment-execution/v1', processor: manifest.processor, adapterVersion: manifest.version,
    environment: v.environment, merchantAccountSha256: v.merchantAccountSha256,
    apiOrigins: [...v.apiOrigins as string[]].sort(),
  };
  return { identity, sha256: createHash('sha256').update(canonicalJson(identity)).digest('hex') };
}

/**
 * The adapter contract (BILL-01). An adapter is chosen by the owner, and goes through outside security
 * review before it holds a real credential. It holds no state and touches no database. `@ensemus/saas/testing`
 * has the only implementation in this repository, and it never ships.
 */
export interface PaymentProcessor {
  readonly manifest: ProcessorManifest;
  /** Missing or unverifiable is unavailable. Implementations must not substitute static configuration. */
  identifyExecution?(context: ProcessorCallContext): Promise<PaymentExecutionIdentity | null>;
  /** Registers a billing account and answers its reference. A repeat with the same key is the same one. */
  createCustomer(
    context: ProcessorCallContext,
    input: { idempotencyKey: string; billingEmail: string; billingName: string },
  ): Promise<{ customerRef: string }>;
  /** Exactly one charge attempt. It does not retry, and neither does anything calling it. */
  charge(context: ProcessorCallContext, request: ChargeRequest): Promise<ChargeResult>;
  /** Looks a charge up by our key. Called only for an attempt whose answer never came. */
  lookup(context: ProcessorCallContext, idempotencyKey: string): Promise<PaymentLookupResult>;
  /**
   * Reads a webhook body whose signature has already passed. Returns only IDs, enums and amounts, and throws
   * for anything it does not recognize. Unknown event types come back as null, which is not an error.
   */
  interpretWebhook(
    providerEventId: string,
    body: Uint8Array,
    signedAtSeconds: number,
  ): PaymentEventFact | null;
}

/** No processor is configured unless the deployment names one, so `get` answering null is the default. */
export interface PaymentProcessorRegistry {
  get(processor: string): PaymentProcessor | null;
}

export type { PaymentEventKind, PaymentEventFact };

/** What is stored and looked up. A processor's customer reference is not secret, and this keeps it exact. */
export const hashCustomerRef = (processor: string, customerRef: string) =>
  createHash('sha256')
    .update(JSON.stringify([processor, customerRef]))
    .digest('hex');

export type PaymentCheckFacts = {
  status: PaymentStatus;
  invoiceStatus: string;
  invoiceTotalMicros: Micros;
  amountMicros: Micros;
  lifecycle: string;
  processorConfigured: boolean;
  customerRef: string | null;
};
export type PaymentCheck = { ok: true } | { ok: false; code: PaymentCode };

/** Everything checked under the payment's lock, just before an attempt. Pure, and refuses by default. */
export function checkBeforeCharge(facts: PaymentCheckFacts): PaymentCheck {
  if (!['active', 'read_only', 'suspended', 'offboarding'].includes(facts.lifecycle))
    return { ok: false, code: 'TENANT_NOT_BILLABLE' };
  if (
    facts.status !== 'ready' ||
    facts.invoiceStatus !== 'open' ||
    facts.amountMicros <= 0n ||
    facts.amountMicros !== facts.invoiceTotalMicros
  )
    return { ok: false, code: 'INVOICE_NOT_OPEN' };
  if (!facts.processorConfigured) return { ok: false, code: 'PROCESSOR_NOT_CONFIGURED' };
  if (!facts.customerRef) return { ok: false, code: 'CUSTOMER_NOT_FOUND' };
  return { ok: true };
}

export type PaymentAttemptDecision =
  | { status: 'succeeded' | 'failed'; code: PaymentCode }
  | { status: 'ready'; afterMs: number; code: PaymentCode }
  | { status: 'failed'; code: 'ATTEMPTS_EXHAUSTED' }
  | { status: 'reconciling'; code: PaymentCode };

/** Where a result leads. Retrying `not_sent` waits on a durable timer, up to MAX_PAYMENT_ATTEMPTS. */
export function decideAfterCharge(result: ChargeResult, attemptNo: number): PaymentAttemptDecision {
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || attemptNo > MAX_PAYMENT_ATTEMPTS)
    throw new RangeError('INVALID_ATTEMPT');
  switch (result.outcome) {
    case 'succeeded':
      return { status: 'succeeded', code: result.code };
    case 'declined':
      return { status: 'failed', code: result.code };
    case 'indeterminate':
      return { status: 'reconciling', code: result.code };
    case 'not_sent':
      if (!result.retryable) return { status: 'failed', code: result.code };
      if (attemptNo >= MAX_PAYMENT_ATTEMPTS)
        return { status: 'failed', code: 'ATTEMPTS_EXHAUSTED' };
      // Operational retry pacing follows ADR-027's effect boundary, not a commercial term.
      return {
        status: 'ready',
        afterMs: Math.min(30_000 * 2 ** (attemptNo - 1), 5 * 60_000),
        code: result.code,
      };
  }
}

export type PaymentLookupDecision =
  | { status: 'succeeded' | 'failed'; code: PaymentCode }
  | { status: 'ready'; code: PaymentCode }
  | { status: 'unknown'; code: PaymentCode };

/** `not_found` is `ready` only from a lookup declared `authoritative`. Anything else stays unknown. */
export function decideAfterLookup(
  result: PaymentLookupResult,
  lookup: ProcessorManifest['lookup'],
): PaymentLookupDecision {
  switch (result.found) {
    case 'succeeded':
      return { status: 'succeeded', code: 'FOUND_BY_LOOKUP' };
    case 'declined':
      return { status: 'failed', code: 'REFUSED_BY_LOOKUP' };
    case 'not_found':
      return {
        status: lookup === 'authoritative' ? 'ready' : 'unknown',
        code: 'NOT_FOUND_BY_LOOKUP',
      };
    case 'cannot_answer':
      return { status: 'unknown', code: 'CANNOT_ANSWER' };
  }
}

// --- The published rules for failed payments (ADR-032 D5). Numbers are the operator's data.

export const COLLECTION_ACTIONS = ['notify', 'retry', 'read_only', 'suspend'] as const;
export type CollectionAction = (typeof COLLECTION_ACTIONS)[number];
export type CollectionStep = { afterDays: number; action: CollectionAction };

export type CollectionDecision =
  | { kind: 'wait'; until: Date }
  | { kind: 'act'; stepNo: number; action: CollectionAction; next: Date | null }
  | { kind: 'done' };

/**
 * The next thing the published policy says to do, counted from when the invoice fell due. With no policy
 * there is nothing to do, and the case waits for a person. Nothing here deletes anything, ever.
 */
export function nextCollectionStep(
  steps: readonly CollectionStep[],
  dueAt: Date,
  stepNo: number,
  now: Date,
): CollectionDecision {
  if (
    !Number.isSafeInteger(stepNo) ||
    stepNo < 0 ||
    !Number.isFinite(dueAt.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    steps.some((s) => !Number.isSafeInteger(s.afterDays) || s.afterDays < 0)
  )
    throw new RangeError('INVALID_COLLECTION_STEP');
  const step = steps[stepNo];
  if (!step) return { kind: 'done' };
  const dateFor = (days: number) => {
    const at = new Date(dueAt);
    at.setUTCDate(at.getUTCDate() + days);
    return at;
  };
  const at = dateFor(step.afterDays);
  if (now < at) return { kind: 'wait', until: at };
  const next = steps[stepNo + 1];
  return {
    kind: 'act',
    stepNo: stepNo + 1,
    action: step.action,
    next: next ? dateFor(next.afterDays) : null,
  };
}
