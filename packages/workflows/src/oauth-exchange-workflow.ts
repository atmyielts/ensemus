// Deterministic workflow code (ADR-038 D1). Only @temporalio/workflow and types may be imported here, plus
// the pure step module and the queue names. The input is two IDs, and the result is an outcome and a
// connection ID: no code, verifier, client or token ever crosses Temporal.
import { CancellationScope, proxyActivities } from '@temporalio/workflow';
import { OAUTH_EXCHANGE_MAX_ATTEMPTS, OAUTH_EXCHANGE_TASK_QUEUE } from './constants';
import type { OAuthExchangeActivities } from './oauth-exchange-activities';
import { runOAuthExchange } from './oauth-exchange-step';
import type { OAuthExchangeInput, OAuthExchangeOutcome } from './schemas';

// Once, ever. The provider has a short life on a code, so a worker that does not pick this up within ten
// minutes is too late anyway, and the attempt is abandoned.
const { exchangeOAuthAuthorization } = proxyActivities<OAuthExchangeActivities>({
  taskQueue: OAUTH_EXCHANGE_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  scheduleToStartTimeout: '10 minutes',
  retry: { maximumAttempts: OAUTH_EXCHANGE_MAX_ATTEMPTS },
});

// Only PostgreSQL and the sealed values, so this rides out an outage the way the external action's
// bookkeeping does. It gives up after a day rather than leave a run open for ever.
const { abandonOAuthExchange } = proxyActivities<OAuthExchangeActivities>({
  taskQueue: OAUTH_EXCHANGE_TASK_QUEUE,
  startToCloseTimeout: '30 seconds',
  scheduleToCloseTimeout: '24 hours',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['AppError'],
  },
});

/**
 * Takes one consent attempt from `code_received` to `connected`, `failed` or `expired`. Nothing cancels
 * it partway: a token request whose answer nobody records is the gap this closes.
 */
export async function oauthExchangeWorkflow(
  input: OAuthExchangeInput,
): Promise<OAuthExchangeOutcome> {
  return CancellationScope.nonCancellable(() =>
    runOAuthExchange({
      exchange: () => exchangeOAuthAuthorization(input),
      abandon: () => abandonOAuthExchange(input),
    }),
  );
}
