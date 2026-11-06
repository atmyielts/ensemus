// Owned by the spine slice (AGENT-02, AI-13). See docs/06-delivery/m4-slices.md and ADR-028 FD-1, FD-2, FD-7,
// FD-12, FD-16 and FD-22. Deterministic workflow code: only @temporalio/workflow, types and
// @ensemus/agent-runtime/reducer, which imports nothing, may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { AgentRunInput, AgentRunResult } from './agent-schemas';

/**
 * The bounded loop. Runs under the Work Unit's standard workflow ID. No event starts this until the
 * spine slice lands, and the stub refuses, so a half-built loop cannot touch anything.
 */
export async function agentRunWorkflow(_input: AgentRunInput): Promise<AgentRunResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
