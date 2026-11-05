// Test only. Deliberately pushes free text through Temporal to prove what reaches its database.
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';

type CanaryActivities = { failWith(text: string): Promise<string> };

const { failWith } = proxyActivities<CanaryActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 1 },
});

export async function canaryWorkflow(text: string): Promise<string> {
  try {
    await failWith(text);
  } catch {
    // Expected: the activity failure carries the canary in its message.
  }
  throw ApplicationFailure.nonRetryable(`workflow failed with ${text}`);
}
