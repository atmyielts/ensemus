// Records oauthExchangeWorkflow's paths, one history each, with stub Activities. Skipped unless
// ENSEMUS_CAPTURE_REPLAY=1, with a Temporal from compose.capture.yaml (see capture-support.ts). A recorded
// history is never rewritten: it is what proves a later change keeps runs like it working. The stubs answer
// IDs and outcomes only, as the real Activities do, so no code, verifier or token is in any history.
import { randomUUID } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/common';
import { describe, it } from 'vitest';
import { OAUTH_EXCHANGE_TASK_QUEUE, PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import type { OAuthExchangeOutcome } from '@ensemus/workflows/schemas';
import { capturing, withCaptureWorkers } from './capture-support';

const input = () => ({ organizationId: randomUUID(), authorizationId: randomUUID() });

describe.skipIf(!capturing)('capture OAuth exchange histories', () => {
  it('records each path', async () => {
    // What the one exchange answers. 'fail' throws, as an Activity that could not reach the store does.
    let answer: OAuthExchangeOutcome | 'fail' = 'fail';
    const activities = {
      exchangeOAuthAuthorization: async (): Promise<OAuthExchangeOutcome> => {
        if (answer === 'fail')
          throw ApplicationFailure.nonRetryable('Nothing real here', 'CAPTURE');
        return answer;
      },
      abandonOAuthExchange: async () => undefined,
    };
    const queues = [...new Set([PLATFORM_TASK_QUEUE, OAUTH_EXCHANGE_TASK_QUEUE])];
    await withCaptureWorkers({ activities, queues }, async (run) => {
      const record = async (name: string, next: typeof answer) => {
        answer = next;
        await run.record(name, { workflowType: 'oauthExchangeWorkflow', args: [input()] });
      };
      await record('oauth-exchange-connected', {
        outcome: 'connected',
        connectionId: randomUUID(),
      });
      await record('oauth-exchange-failed', { outcome: 'failed', connectionId: null });
      await record('oauth-exchange-expired', { outcome: 'expired', connectionId: null });
      await record('oauth-exchange-already-settled', {
        outcome: 'already_settled',
        connectionId: null,
      });
      await record('oauth-exchange-abandoned', 'fail');
    });
  }, 120_000);
});
