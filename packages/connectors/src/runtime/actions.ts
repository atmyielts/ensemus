// Runs a connector's one try, and turns whatever it does into what is known (ADR-027 D2). A connector
// has to say on purpose that nothing happened. Every other way of ending counts as "it may have gone",
// so one that forgot to think about this cannot cause a second send.
import {
  ATTEMPT_OUTCOMES,
  EXTERNAL_ACTION_CODES,
  type ExternalActionCode,
} from '@ensemus/domain/external-action';
import {
  NotSent,
  type ActionRequest,
  type AttemptResult,
  type Connector,
  type ConnectorContext,
  type ReconcileResult,
} from '../index';

/** How long one send may run. Well inside its Activity's limit, so the answer gets recorded. */
export const SEND_DEADLINE_MS = 60_000;

export type ConnectorCall = {
  connector: Connector;
  context: Omit<ConnectorContext, 'signal'>;
  request: ActionRequest;
  deadlineMs?: number;
};

const DEADLINE = Symbol('deadline');
const MAX_EXTERNAL_ID_LENGTH = 998;

/** Runs `work`, and reports the deadline if it comes first. A failure after that goes nowhere. */
async function underDeadline<T>(
  deadlineMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof DEADLINE> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(DEADLINE);
    }, deadlineMs);
  });
  // Started through an async wrapper, so a synchronous throw is a rejection like any other.
  const running = (async () => work(controller.signal))();
  running.catch(() => undefined);
  try {
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const isCode = (code: unknown): code is ExternalActionCode =>
  (EXTERNAL_ACTION_CODES as readonly unknown[]).includes(code);

const isStatus = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999;

const isExternalId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_EXTERNAL_ID_LENGTH;

const mayHaveGone = (code: ExternalActionCode): AttemptResult => ({
  outcome: 'indeterminate',
  code,
});

/** Passes on only the fields we recognize, so nothing a provider said can ride along in another. */
function readAttempt(answer: unknown): AttemptResult {
  const raw = (answer ?? {}) as Partial<AttemptResult>;
  if (!ATTEMPT_OUTCOMES.includes(raw.outcome as never) || !isCode(raw.code)) {
    return mayHaveGone('CONNECTION_LOST_AFTER_COMMIT');
  }
  return {
    outcome: raw.outcome as AttemptResult['outcome'],
    code: raw.code,
    ...(isStatus(raw.providerStatus) ? { providerStatus: raw.providerStatus } : {}),
    ...(isExternalId(raw.externalId) ? { externalId: raw.externalId } : {}),
    ...(raw.outcome === 'not_sent' ? { retryable: raw.retryable === true } : {}),
  };
}

/**
 * Runs one send under a deadline and reports what is known. NotSent becomes `not_sent`. Any other error,
 * and the deadline passing, become `indeterminate`. A connector's error text never comes out of this.
 *
 * The one failure that is ours and not the connector's: a credential that would not open before any
 * connection was made. Nothing can have left, and saying so spares a person a false `unknown`.
 */
export async function runSend(call: ConnectorCall): Promise<AttemptResult> {
  const send = call.connector.actions;
  if (!send) return { outcome: 'not_sent', code: 'CONNECTOR_UNAVAILABLE', retryable: false };

  let opened = false;
  let leaseRefused = false;
  const context: Omit<ConnectorContext, 'signal'> = {
    ...call.context,
    network: {
      openRelay: (options) => {
        opened = true;
        return call.context.network.openRelay(options);
      },
    },
    credentials: {
      withCredential: async (use) => {
        let lent = false;
        try {
          return await call.context.credentials.withCredential((secret) => {
            lent = true;
            return use(secret);
          });
        } catch (error) {
          if (!lent) leaseRefused = true;
          throw error;
        }
      },
    },
  };

  try {
    const answer = await underDeadline(call.deadlineMs ?? SEND_DEADLINE_MS, (signal) =>
      send.send({ ...context, signal }, call.request),
    );
    if (answer === DEADLINE) return mayHaveGone('TIMEOUT_AFTER_COMMIT');
    return readAttempt(answer);
  } catch (error) {
    if (error instanceof NotSent && isCode(error.code)) {
      return { outcome: 'not_sent', code: error.code, retryable: error.retryable };
    }
    if (leaseRefused && !opened) {
      return { outcome: 'not_sent', code: 'CREDENTIAL_UNAVAILABLE', retryable: false };
    }
    return mayHaveGone('CONNECTION_LOST_AFTER_COMMIT');
  }
}

function readReconcile(answer: unknown): ReconcileResult {
  const raw = (answer ?? {}) as {
    answer?: unknown;
    externalId?: unknown;
    providerStatus?: unknown;
  };
  const status = isStatus(raw.providerStatus) ? { providerStatus: raw.providerStatus } : {};
  switch (raw.answer) {
    case 'found':
      return {
        answer: 'found',
        ...(isExternalId(raw.externalId) ? { externalId: raw.externalId } : {}),
        ...status,
      };
    case 'refused':
      return { answer: 'refused', ...status };
    case 'not_found':
      return { answer: 'not_found' };
    default:
      return { answer: 'cannot_answer' };
  }
}

/** Runs one reconcile under a deadline. If it throws or times out, the answer is `cannot_answer`. */
export async function runReconcile(call: ConnectorCall): Promise<ReconcileResult> {
  const actions = call.connector.actions;
  if (!actions) return { answer: 'cannot_answer' };
  try {
    const answer = await underDeadline(call.deadlineMs ?? SEND_DEADLINE_MS, (signal) =>
      actions.reconcile({ ...call.context, signal }, call.request),
    );
    return answer === DEADLINE ? { answer: 'cannot_answer' } : readReconcile(answer);
  } catch {
    return { answer: 'cannot_answer' };
  }
}
