// External action intents (ADR-027 D1, D2). Pure rules: no framework, database or SDK here.
import { actionHash, type ProposedAction } from './approval';

export const EXTERNAL_ACTION_STATUSES = [
  'awaiting_approval',
  'ready',
  'sending',
  'reconciling',
  'sent',
  'failed',
  'unknown',
  'cancelled',
] as const;
export type ExternalActionStatus = (typeof EXTERNAL_ACTION_STATUSES)[number];

/**
 * The state machine. Migration 0013 holds the same table, and a test keeps the two equal. There is no
 * way out of `sent`, `failed` or `cancelled`: doing it again is a new intent with a new approval.
 */
export const EXTERNAL_ACTION_TRANSITIONS: Record<
  ExternalActionStatus,
  readonly ExternalActionStatus[]
> = {
  awaiting_approval: ['ready', 'cancelled'],
  ready: ['sending', 'failed', 'cancelled'],
  sending: ['sent', 'failed', 'ready', 'reconciling'],
  reconciling: ['sent', 'failed', 'ready', 'unknown'],
  unknown: ['sent', 'failed'],
  sent: [],
  failed: [],
  cancelled: [],
};

export function canTransitionExternalAction(
  from: ExternalActionStatus,
  to: ExternalActionStatus,
): boolean {
  return EXTERNAL_ACTION_TRANSITIONS[from].includes(to);
}

/** Finished for good. `unknown` is not one of these: it waits for a person. */
export function isSettledExternalAction(status: ExternalActionStatus): boolean {
  return EXTERNAL_ACTION_TRANSITIONS[status].length === 0;
}

/**
 * - `accepted`: the provider said it took it.
 * - `rejected`: the provider said it refused it, so nothing happened.
 * - `not_sent`: the attempt ended before the commit point, so nothing can have happened.
 * - `indeterminate`: past the commit point with no answer. It may have happened.
 */
export const ATTEMPT_OUTCOMES = ['accepted', 'rejected', 'not_sent', 'indeterminate'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const RECEIPT_OUTCOMES = ['sent', 'failed', 'unknown', 'cancelled'] as const;
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];

/** Whose word a receipt rests on. A person's word is shown as a person's word. */
export const RECEIPT_BASES = ['provider', 'reconciliation', 'person', 'system'] as const;
export type ReceiptBasis = (typeof RECEIPT_BASES)[number];

export const RESOLUTIONS = ['confirmed_sent', 'confirmed_not_sent'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** Why an intent stopped or what an attempt ended with. Fixed codes, so no provider text is stored. */
export const EXTERNAL_ACTION_CODES = [
  // Stopped before any contact.
  'APPROVAL_DENIED',
  'APPROVAL_EXPIRED',
  'APPROVAL_NOT_VALID',
  'SUPERSEDED',
  'WORK_STOPPED',
  'CONNECTION_NOT_ACTIVE',
  'CONNECTOR_UNAVAILABLE',
  'CREDENTIAL_UNAVAILABLE',
  'PAYLOAD_CHANGED',
  'ATTEMPTS_EXHAUSTED',
  // Ended before the commit point.
  'CONNECT_FAILED',
  'TLS_REQUIRED',
  'AUTH_FAILED',
  'TIMEOUT_BEFORE_COMMIT',
  'RELAY_BUSY',
  // The provider answered.
  'ACCEPTED_BY_RELAY',
  'ACCEPTED_BY_PROVIDER',
  'REFUSED_BY_PROVIDER',
  'RECIPIENT_REFUSED',
  // Past the commit point with no answer.
  'TIMEOUT_AFTER_COMMIT',
  'CONNECTION_LOST_AFTER_COMMIT',
  'WORKER_INTERRUPTED',
  // Reconciliation.
  'PROVIDER_CANNOT_ANSWER',
  'PROVIDER_FOUND_IT',
  'PROVIDER_DID_NOT_FIND_IT',
  // A person.
  'PERSON_CONFIRMED_SENT',
  'PERSON_CONFIRMED_NOT_SENT',
] as const;
export type ExternalActionCode = (typeof EXTERNAL_ACTION_CODES)[number];

/** The one tool in M3. The version is part of what an approval binds. */
export const EMAIL_SEND_TOOL = 'email.send';
export const EMAIL_SEND_VERSION = '1';
export const EMAIL_CONNECTOR_TYPE = 'email_smtp';

/**
 * Connector types that can perform an action, and so can produce a receipt. Work may only ask for an
 * outside system's receipt if its tenant has an active connection of one of these (ADR-027 D6).
 */
export const ACTION_CONNECTOR_TYPES: readonly string[] = [EMAIL_CONNECTOR_TYPE];

/** How many tries an intent gets, and only while each one definitely did not send. */
export const MAX_SEND_ATTEMPTS = 5;

/** Reasons a person has to give, kept with the Work Unit's own access rules. */
export const MAX_RESOLUTION_REASON_LENGTH = 2000;

/** The one key for every attempt at one effect, handed to any provider that takes one. */
export const idempotencyKeyFor = (externalActionId: string) => `ensemus-${externalActionId}`;

export const connectionRef = (connectionId: string) => `connection:${connectionId}`;

export type ExternalActionProposal = {
  toolName: string;
  toolVersion: string;
  connectionId: string;
  payload: unknown;
};

/**
 * The action an approval binds and an intent's hash covers. Every field a reviewer relies on is in
 * here, recipients and text included, so changing any of them changes the hash (QA-007).
 */
export function proposedActionFor(proposal: ExternalActionProposal): ProposedAction {
  return {
    toolName: proposal.toolName,
    toolVersion: proposal.toolVersion,
    targetRef: connectionRef(proposal.connectionId),
    payload: proposal.payload,
  };
}

export const requestHashFor = (proposal: ExternalActionProposal): string =>
  actionHash(proposedActionFor(proposal));

/** What has to hold just before an attempt is recorded. All of it is read under the intent's lock. */
export type SendFacts = {
  status: ExternalActionStatus;
  requiresApproval: boolean;
  /** The hash stored on the intent. */
  requestHash: string;
  /** Recomputed from the stored payload just now. */
  recomputedHash: string;
  approval: { status: string; actionHash: string; expiresAt: Date } | null;
  workStatus: string;
  connectionState: string;
  /** How many attempts exist, all of which definitely did not send. */
  attemptsSoFar: number;
};

export type SendCheck =
  | { ok: true }
  | {
      ok: false;
      /** Where the intent goes from here. */
      to: 'cancelled' | 'failed';
      code: ExternalActionCode;
    }
  /** The intent is already past this point, so this call has nothing to do. */
  | { ok: false; to: null; code: null };

/**
 * ADR-027 D2's recheck, and the last thing before an attempt row. Reports the first reason it may not
 * go ahead. Implemented by the intents slice.
 */
export function checkBeforeSend(_facts: SendFacts, _now: Date): SendCheck {
  throw new Error('NOT_IMPLEMENTED');
}

/** What one try at the provider ended with, as a connector reports it. */
export type AttemptResult = {
  outcome: AttemptOutcome;
  code: ExternalActionCode;
  providerStatus?: number;
  externalId?: string;
  /** For `not_sent` only: trying again later could work. */
  retryable?: boolean;
};

export type AttemptDecision = {
  status: Extract<ExternalActionStatus, 'sent' | 'failed' | 'ready' | 'reconciling'>;
  receipt: ReceiptOutcome | null;
};

/**
 * Where an attempt's result takes its intent. `indeterminate` always goes to reconciling, and never
 * back to ready. Implemented by the intents slice.
 */
export function decideAfterAttempt(_result: AttemptResult, _attemptNo: number): AttemptDecision {
  throw new Error('NOT_IMPLEMENTED');
}

/** What a connector's reconcile can say. `cannot_answer` is the only result SMTP ever gives. */
export type ReconcileResult =
  | { answer: 'found'; externalId?: string; providerStatus?: number }
  | { answer: 'not_found' }
  | { answer: 'refused'; providerStatus?: number }
  | { answer: 'cannot_answer' };

export type ReconcileDecision = {
  status: Extract<ExternalActionStatus, 'sent' | 'failed' | 'ready' | 'unknown'>;
  attemptOutcome: AttemptOutcome;
  code: ExternalActionCode;
};

/**
 * Where a reconcile's answer takes an intent. `not_found` only counts from a connector that declares its
 * lookup authoritative, and anything else stays unknown for a person. Implemented by the intents slice.
 */
export function decideAfterReconcile(
  _result: ReconcileResult,
  _lookup: 'none' | 'best_effort' | 'authoritative',
): ReconcileDecision {
  throw new Error('NOT_IMPLEMENTED');
}
