// Owned by the sandbox-runner slice (EXP-05). See docs/06-delivery/m11b-slices.md and ADR-034 D3. How the sandbox
// worker talks to the runner. Implements the port in @ensemus/domain/sandbox, over ./protocol.
import type { SandboxRunnerPort } from '@ensemus/domain/sandbox';

/**
 * Every failure to get an answer is SandboxRunnerUnavailable, with no detail, and an answer that does not
 * fit the protocol counts as no answer. Aborting cancels the job on the runner too.
 */
export function createRunnerClient(_config: {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}): SandboxRunnerPort {
  throw new Error('NOT_IMPLEMENTED');
}
