// The dispatcher starts these on the platform queue. Only the optional federation worker
// polls for the Activities, and every input and result is a reference, count or decision.
import { proxyActivities, continueAsNew } from '@temporalio/workflow';
import { FEDERATION_TASK_QUEUE } from './constants';
import type { FederationActivities } from './federation-activities';
import type {
  FederationDeliveryResult,
  FederationItemInput,
  FederationPurgeInput,
  FederationPurgeResult,
} from './schemas';

const activities = proxyActivities<FederationActivities>({
  taskQueue: FEDERATION_TASK_QUEUE,
  startToCloseTimeout: '5 minutes',
  retry: { initialInterval: '2 seconds', maximumInterval: '5 minutes' },
});
const passesPerRun = 50;

export async function federationDeliveryWorkflow(
  input: FederationItemInput,
): Promise<FederationDeliveryResult> {
  const outcome = await activities.deliverFederationItem(input);
  if (outcome === 'delivered') await activities.recordFederationItemReceived(input);
  return { itemId: input.itemId, outcome };
}

export async function federationPurgeWorkflow(
  input: FederationPurgeInput,
  progress: { purged: number; inboundDone: boolean } = { purged: 0, inboundDone: false },
): Promise<FederationPurgeResult> {
  if ('itemId' in input) {
    const { purged } = await activities.purgeFederationItem(input);
    return { purged };
  }

  let { purged, inboundDone } = progress;
  for (let pass = 0; pass < passesPerRun; pass++) {
    if (!inboundDone) {
      const result = await activities.purgeFederationGrantPass(input);
      purged += result.purged;
      inboundDone = !result.more;
    } else if (!(await activities.settleFederationGrantEnd(input))) {
      return { purged };
    }
  }
  return continueAsNew<typeof federationPurgeWorkflow>(input, { purged, inboundDone });
}
