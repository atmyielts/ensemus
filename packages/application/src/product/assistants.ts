// Owned by the surfaces slice (UX-19). See docs/06-delivery/m7-slices.md. A thin layer over M4's AgentRunsPort,
// with plain-language wording decided here and a person's right to stop checked there.
import type { TenantContext } from '@ensemus/database';
import type { DelegatedRun, ProductPorts } from './ports';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type AssistantsView = {
  running: readonly DelegatedRun[];
  finished: readonly DelegatedRun[];
  next: string | null;
};

export async function listMyDelegatedRuns(
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'agentRuns'>,
  _input: { after?: string } = {},
): Promise<AssistantsView> {
  throw NOT_BUILT();
}

export async function getDelegatedRun(
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'agentRuns'>,
  _runId: string,
): Promise<DelegatedRun> {
  throw NOT_BUILT();
}

/** A stop that is not honoured is reported as such. It never says stopped until the run says so. */
export async function stopDelegatedRun(
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'agentRuns'>,
  _runId: string,
): Promise<void> {
  throw NOT_BUILT();
}

/** The sentence for a run's status and stop code. Pure, and it knows every code M4 can send. */
export function describeRunStatus(_run: Pick<DelegatedRun, 'status' | 'stopCode'>): string {
  throw NOT_BUILT();
}
