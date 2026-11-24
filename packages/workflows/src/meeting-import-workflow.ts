import { CancellationScope, isCancellation, proxyActivities } from '@temporalio/workflow';
import { CONNECTOR_TASK_QUEUE, PLATFORM_TASK_QUEUE } from './constants';
import type {
  MeetingImportConnectorActivities,
  MeetingImportPlatformActivities,
} from './meeting-import-activities';
import type { MeetingImportInput, MeetingImportOutcome } from './schemas';

const connector = proxyActivities<MeetingImportConnectorActivities>({
  taskQueue: CONNECTOR_TASK_QUEUE,
  scheduleToStartTimeout: '1 hour',
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});
const platform = proxyActivities<MeetingImportPlatformActivities>({
  taskQueue: PLATFORM_TASK_QUEUE,
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

/** The Activity handles the note. Workflow history carries only identifiers and status. */
export async function meetingImportWorkflow(
  input: MeetingImportInput,
): Promise<MeetingImportOutcome> {
  try {
    return await connector.readMeetingNotes(input);
  } catch (error) {
    if (!isCancellation(error)) return platform.stopUnreadImport(input);
    await CancellationScope.nonCancellable(() => platform.stopUnreadImport(input));
    throw error;
  }
}
