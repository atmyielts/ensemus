// Company Pulse (WORK-09). A signal is a fact about work with a link to the records it rests on, and
// nothing else: no score for a person, and no claim about why (ADR-031 D4). Owned by the pulse slice,
// which fills in deriveSignals.

export const PULSE_SIGNAL_KINDS = [
  'work_overdue',
  'work_due_soon',
  'work_blocked_by_prerequisite',
  'work_owner_disabled',
  'approval_waiting_past_expiry_window',
  'external_action_unknown',
  'external_action_failed',
  'process_run_failed',
  'agent_run_stopped',
] as const;
export type PulseSignalKind = (typeof PULSE_SIGNAL_KINDS)[number];

export type PulseSeverity = 'attention' | 'watch';

/** A record a signal rests on. Every signal has at least one, and the type requires it. */
export type PulseEvidence = {
  kind: 'work_unit' | 'approval' | 'external_action' | 'process_run' | 'agent_run';
  id: string;
  /** Why this record counts, as a fixed code. */
  reasonCode: string;
  observedAt: Date;
};

export type PulseSignal = {
  /** Stable across recomputes, so a person's dismissal keeps applying to the same fact. */
  key: string;
  kind: PulseSignalKind;
  severity: PulseSeverity;
  /** Never a person: Pulse groups by project and client, and has no per-person numbers at all. */
  scope: { projectId: string | null; clientId: string | null };
  evidence: readonly [PulseEvidence, ...PulseEvidence[]];
  since: Date;
};

export type PulseWorkFact = {
  id: string;
  status: string;
  dueAt: Date | null;
  updatedAt: Date;
  projectId: string | null;
  clientId: string | null;
  ownerDisabled: boolean;
  blockedByPrerequisite: boolean;
};

export type PulseFacts = {
  now: Date;
  /** Only what the viewer can read. The service filters before this function sees anything. */
  work: readonly PulseWorkFact[];
  approvals: readonly { id: string; workUnitId: string; expiresAt: Date; createdAt: Date }[];
  externalActions: readonly {
    id: string;
    workUnitId: string;
    status: 'unknown' | 'failed';
    updatedAt: Date;
  }[];
  processRuns: readonly { id: string; rootWorkUnitId: string; stopCode: string | null; at: Date }[];
  agentRuns: readonly { id: string; workUnitId: string; stopCode: string; at: Date }[];
};

/** How close to its limit something has to be before Pulse mentions it. Starting values. */
export const PULSE_DUE_SOON_HOURS = 48;
export const PULSE_APPROVAL_WINDOW_HOURS = 24;

/**
 * Pure and total: the same facts always give the same signals, in a stable order. Implemented by the pulse
 * slice. Every signal has evidence by construction, and anything uncertain is left out, not guessed.
 */
export function deriveSignals(_facts: PulseFacts): readonly PulseSignal[] {
  throw new Error('NOT_IMPLEMENTED');
}
