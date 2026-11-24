import { patched, proxyActivities } from '@temporalio/workflow';
import { AGENT_TASK_QUEUE, PLATFORM_TASK_QUEUE } from './constants';
import type {
  GovernedMeetingActivities,
  MeetingDerivationActivities,
} from './meeting-derivation-activities';
import type { MeetingDerivationInput, MeetingDerivationOutcome } from './schemas';

const run = proxyActivities<Pick<MeetingDerivationActivities, 'runMeetingDerivation'>>({
  taskQueue: PLATFORM_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  scheduleToStartTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});
const agent = proxyActivities<GovernedMeetingActivities>({
  taskQueue: AGENT_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  scheduleToStartTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});
const cleanup = proxyActivities<Pick<MeetingDerivationActivities, 'stopInterruptedDerivation'>>({
  taskQueue: PLATFORM_TASK_QUEUE,
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

/** Private content stays inside one Activity. Temporal carries an identifier and a terminal outcome. */
export async function meetingDerivationWorkflow(
  input: MeetingDerivationInput,
): Promise<MeetingDerivationOutcome> {
  try {
    return patched('meeting-governed-agent-worker-v1')
      ? await agent.runGovernedMeetingDerivation(input)
      : await run.runMeetingDerivation(input);
  } catch {
    return cleanup.stopInterruptedDerivation(input);
  }
}
