import { proxyActivities } from '@temporalio/workflow';
import { PLATFORM_TASK_QUEUE } from './constants';
import type { MeetingDerivationActivities } from './meeting-derivation-activities';
import type { MeetingDerivationInput, MeetingDerivationOutcome } from './schemas';

const run = proxyActivities<Pick<MeetingDerivationActivities, 'runMeetingDerivation'>>({
  taskQueue: PLATFORM_TASK_QUEUE,
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
    return await run.runMeetingDerivation(input);
  } catch {
    return cleanup.stopInterruptedDerivation(input);
  }
}
