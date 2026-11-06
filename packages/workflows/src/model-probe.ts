// Owned by the model-profiles slice (MODEL-01). See docs/06-delivery/m4-slices.md and ADR-028 FD-23.
// Deterministic workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { ModelProbeInput, ModelProbeOutcome } from './agent-schemas';

/** Sends one synthetic prompt from agent-worker, and writes whether the profile passed. */
export async function modelProbeWorkflow(_input: ModelProbeInput): Promise<ModelProbeOutcome> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
