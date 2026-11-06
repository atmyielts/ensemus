// Owned by the pulse slice (WORK-09). See docs/06-delivery/m7-slices.md and ADR-031 D4.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { PulseSignal } from '@ensemus/domain/pulse';
import type { ProductPorts } from './ports';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type PulseSignalView = PulseSignal & {
  personalState: 'open' | 'snoozed' | 'dismissed';
  snoozedUntil: Date | null;
};

export type CompanyPulse = {
  generatedAt: Date;
  signals: readonly PulseSignalView[];
  /** Counts of what a viewer can read. No per-person number exists anywhere on this page. */
  summary: { openWork: number; overdue: number; waitingOnApproval: number; needsDecision: number };
  /** Parts that could not be read, so the page says so rather than showing false calm. */
  partial: readonly ('agent_runs' | 'process_runs')[];
};

/**
 * A read projection, computed on each read from what the viewer may see. Nothing is stored but a person's
 * own dismissals. Each read is bounded. A port that is unavailable makes that part `partial`, never empty.
 */
export async function getCompanyPulse(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'agentRuns'>,
  _input: { includeDismissed?: boolean } = {},
): Promise<CompanyPulse> {
  throw NOT_BUILT();
}

/** The viewer's own, and nobody else's. The signal's key has to be one they can currently see. */
export async function setPulseSignalState(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'agentRuns'>,
  _input: { signalKey: string; state: 'dismissed' | 'snoozed' | 'open'; until?: Date },
): Promise<void> {
  throw NOT_BUILT();
}
