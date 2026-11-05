// Pure Work Unit rules (docs/02-architecture/04-work-kernel.md). No framework, database or SDK here.

export const WORK_STATES = [
  'queued',
  'ready',
  'running',
  'blocked',
  'awaiting_approval',
  'verifying',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkState = (typeof WORK_STATES)[number];

// The kernel's diagram, plus two things its text requires: authorized reopening of completed work,
// and stopping work that has not finished. Every extension is marked.
const TRANSITIONS: Record<WorkState, readonly WorkState[]> = {
  queued: ['ready', 'cancelled'],
  ready: ['running', 'cancelled' /* extension: stop before it starts */],
  running: [
    'blocked',
    'awaiting_approval',
    'verifying',
    'failed',
    'cancelled' /* extension: stop */,
  ],
  blocked: ['ready', 'cancelled' /* extension: stop */],
  awaiting_approval: ['running', 'cancelled'],
  verifying: ['completed', 'running'],
  completed: ['ready' /* extension: reopen, with a required reason */],
  failed: ['ready'],
  cancelled: [],
};

export function canTransition(from: WorkState, to: WorkState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: WorkState): readonly WorkState[] {
  return TRANSITIONS[from];
}

export type DenialReason =
  'INVALID_TRANSITION' | 'PREREQUISITES_INCOMPLETE' | 'EVIDENCE_MISSING' | 'REASON_REQUIRED';

export type Decision = { ok: true } | { ok: false; reason: DenialReason };

const ok: Decision = { ok: true };

/** A completion criterion must be testable. A model's claim that it is done is not one. */
export type CompletionCriterion =
  { kind: 'artifact_exists' } | { kind: 'reviewer_approved' } | { kind: 'external_receipt' };

export type CompletionEvidence = {
  artifactCount: number;
  approvedReviewCount: number;
  verifiedReceiptCount: number;
};

/** Returns the criteria that the evidence does not yet meet. */
export function unmetCriteria(
  criteria: readonly CompletionCriterion[],
  evidence: CompletionEvidence,
): CompletionCriterion[] {
  return criteria.filter((criterion) => {
    switch (criterion.kind) {
      case 'artifact_exists':
        return evidence.artifactCount === 0;
      case 'reviewer_approved':
        return evidence.approvedReviewCount === 0;
      case 'external_receipt':
        return evidence.verifiedReceiptCount === 0;
    }
  });
}

export type TransitionFacts = {
  from: WorkState;
  to: WorkState;
  /** Prerequisites that are not completed. */
  incompletePrerequisites: number;
  criteria: readonly CompletionCriterion[];
  evidence: CompletionEvidence;
  reason?: string;
};

/** The single decision point for every status change, whoever or whatever asks for it. */
export function decideTransition(facts: TransitionFacts): Decision {
  const { from, to } = facts;
  if (!canTransition(from, to)) return { ok: false, reason: 'INVALID_TRANSITION' };
  if (to === 'ready' && facts.incompletePrerequisites > 0) {
    return { ok: false, reason: 'PREREQUISITES_INCOMPLETE' };
  }
  if (to === 'completed' && unmetCriteria(facts.criteria, facts.evidence).length > 0) {
    return { ok: false, reason: 'EVIDENCE_MISSING' };
  }
  if (from === 'completed' && !facts.reason?.trim()) {
    return { ok: false, reason: 'REASON_REQUIRED' };
  }
  return ok;
}

export const TERMINAL_STATES: readonly WorkState[] = ['completed', 'cancelled'];

export function isTerminal(state: WorkState): boolean {
  return TERMINAL_STATES.includes(state);
}
