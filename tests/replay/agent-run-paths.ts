// Required real-server history names and terminal results. Capture never manufactures a history and
// replay never silently substitutes a missing one. All IDs and Activity replies are synthetic.
export const AGENT_RUN_HISTORIES = [
  { name: 'agent-run-completed', status: 'completed', stop: null },
  { name: 'agent-run-outcome-unverified', status: 'outcome_unverified', stop: 'OUTPUT_UNVERIFIED' },
  { name: 'agent-run-budget-exhausted', status: 'budget_exhausted', stop: 'COST_LIMIT' },
  { name: 'agent-run-model-unavailable', status: 'failed', stop: 'MODEL_UNAVAILABLE' },
  { name: 'agent-run-invalid-output', status: 'failed', stop: 'INVALID_OUTPUT' },
  { name: 'agent-run-policy-denied', status: 'policy_denied', stop: 'POLICY_DENIED' },
  { name: 'agent-run-stop-before-model', status: 'cancelled', stop: 'STOPPED_BY_PERSON' },
  { name: 'agent-run-halt-before-model', status: 'cancelled', stop: 'HALTED' },
  { name: 'agent-run-stop-in-flight', status: 'cancelled', stop: 'STOPPED_BY_PERSON' },
  { name: 'agent-run-halt-in-flight', status: 'cancelled', stop: 'HALTED' },
  { name: 'agent-run-workflow-cancelled', status: 'cancelled', stop: 'WORK_STOPPED' },
  { name: 'agent-run-pause-resume', status: 'completed', stop: null },
  { name: 'agent-run-tool-approval-done', status: 'completed', stop: null },
  { name: 'agent-run-tool-approval-denied', status: 'policy_denied', stop: 'APPROVAL_DENIED' },
  {
    name: 'agent-run-tool-approval-unknown',
    status: 'outcome_unverified',
    stop: 'UNKNOWN_EXTERNAL_STATE',
  },
  { name: 'agent-run-tool-denied', status: 'policy_denied', stop: 'POLICY_DENIED' },
  { name: 'agent-run-delegation-success', status: 'completed', stop: null },
  { name: 'agent-run-delegation-failure', status: 'failed', stop: 'CHILD_FAILED' },
  { name: 'agent-run-delegation-child-execution-failed', status: 'failed', stop: 'CHILD_FAILED' },
  { name: 'agent-run-delegation-refused', status: 'policy_denied', stop: 'DELEGATION_DENIED' },
  { name: 'agent-run-nothing-queued', status: 'nothing_queued', stop: null },
  { name: 'agent-run-model-activity-failed', status: 'failed', stop: 'INTERNAL_ERROR' },
  { name: 'agent-run-missing-model-activity', status: 'failed', stop: 'INTERNAL_ERROR' },
  { name: 'agent-run-resumed-final-output', status: 'completed', stop: null },
  { name: 'agent-run-resumed-tool-wait', status: 'completed', stop: null },
  { name: 'agent-run-resumed-next-step', status: 'completed', stop: null },
  { name: 'agent-run-reclaim-denied', status: 'cancelled', stop: 'INITIATOR_INACTIVE' },
  { name: 'agent-run-continued-resume', status: 'completed', stop: null },
] as const;

export const AGENT_CONTINUE_HISTORY = 'agent-run-continue-as-new';
export const AGENT_INPUT = {
  organizationId: '6f1c2c6e-1111-4111-8111-111111111111',
  workUnitId: '6f1c2c6e-2222-4222-8222-222222222222',
};
export const AGENT_RUN_ID = '6f1c2c6e-3333-4333-8333-333333333333';
export const CHILD_WORK_ID = '6f1c2c6e-4444-4444-8444-444444444444';
export const CHILD_RUN_ID = '6f1c2c6e-5555-4555-8555-555555555555';
