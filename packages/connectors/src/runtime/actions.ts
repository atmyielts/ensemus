// Owned by the sdk slice. See docs/06-delivery/m3-slices.md.
import type {
  ActionRequest,
  AttemptResult,
  Connector,
  ConnectorContext,
  ReconcileResult,
} from '../index';

/** How long one send may run. Well inside its Activity's limit, so the answer gets recorded. */
export const SEND_DEADLINE_MS = 60_000;

export type ConnectorCall = {
  connector: Connector;
  context: Omit<ConnectorContext, 'signal'>;
  request: ActionRequest;
  deadlineMs?: number;
};

/**
 * Runs one send under a deadline and reports what is known. NotSent becomes `not_sent`. Any other error,
 * and the deadline passing, become `indeterminate`. A connector's error text never comes out of this.
 */
export function runSend(_call: ConnectorCall): Promise<AttemptResult> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Runs one reconcile under a deadline. If it throws or times out, the answer is `cannot_answer`. */
export function runReconcile(_call: ConnectorCall): Promise<ReconcileResult> {
  throw new Error('NOT_IMPLEMENTED');
}
