// Owned by the bridge slice (EXP-07). See docs/06-delivery/m11c-slices.md and ADR-035 D3. Deterministic workflow
// code: only @temporalio/workflow and types may be imported here. It runs on PLATFORM_TASK_QUEUE, where the
// dispatcher starts it, and every Activity is proxied to FEDERATION_TASK_QUEUE.
import { ApplicationFailure } from '@temporalio/workflow';
import type {
  FederationDeliveryResult,
  FederationItemInput,
  FederationPurgeInput,
  FederationPurgeResult,
} from './schemas';

/** Carries one item across, once. No event starts this until someone has turned the feature on. */
export async function federationDeliveryWorkflow(
  _input: FederationItemInput,
): Promise<FederationDeliveryResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}

/** Removes a whole ended grant's copies, or one withdrawn item's, until none are left. */
export async function federationPurgeWorkflow(
  _input: FederationPurgeInput,
): Promise<FederationPurgeResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
