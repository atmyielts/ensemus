import type { ProcessRunView } from '@ensemus/application/process-runs';
import { usdTextFromMicros } from '@ensemus/domain/agent-draft';
export const runStatusNames = {
  queued: 'Waiting to start',
  running: 'In progress',
  waiting: 'Waiting for the next step',
  completed: 'Done',
  failed: 'Needs attention',
  cancelled: 'Stopped',
} as const;
export const stepKindNames = {
  work_item: 'Work for a person',
  agent_task: 'Assistant task',
  human_approval: 'A person decides',
  external_action: 'Outside action',
  evidence_check: 'Evidence check',
} as const;
const codes: Record<string, string> = {
  STOP_REQUESTED:
    'A person requested a stop. The worker will stop further steps; an outside action already in progress may need reconciliation.',
  ROOT_CONFIRMATION_REQUIRED:
    'Every step is recorded as done. Open the workflow work and confirm its completion as the accountable owner.',
  WORK_CONFIRMATION_REQUIRED:
    'The result is recorded, but the accountable owner still needs to confirm this task in Work.',
  DETAILS_NEEDED:
    'A person must write the proposed email. The saved reviewer rule selects a currently eligible independent approver.',
  REVIEWER_NEEDED:
    'Name an eligible reviewer on the workflow work before this step can ask for a decision.',
  APPROVER_UNAVAILABLE: 'No eligible independent approver is available for this step.',
  EVIDENCE_MISSING: 'The required file, decision or delivery receipt has not been verified.',
  APPROVAL_PROOF_MISSING: 'The recorded approval cannot currently be verified for this exact step.',
  RECEIPT_PROOF_MISSING:
    'A sent status alone does not establish delivery. The exact action receipt is still required.',
  EXTERNAL_ACTION_UNKNOWN:
    'Delivery is uncertain. Open the outside action for reconciliation; do not send it again.',
  STEP_PROOF_CHANGED:
    'Evidence or access for a completed step changed. The workflow stopped before relying on it for another effect.',
  TOOL_NOT_CONNECTED: 'This outside tool has no active supported connection.',
  AGENT_NOT_PUBLISHED: 'The selected assistant has no current eligible publication.',
  STARTER_INACTIVE: 'The person who started the workflow is no longer active here.',
  WORK_CHANGED: 'The workflow work changed in a way this saved definition cannot use.',
  ROOT_STOPPED: 'The workflow work was stopped.',
  SPEC_HASH_MISMATCH: 'The stored definition does not match its recorded snapshot.',
  ADVANCE_FAILED:
    'The worker could not continue. Check the underlying work and operational status before starting another workflow.',
  NEEDS_EMAIL_CONNECTOR: 'An active supported email connection is required.',
  NEEDS_ACCOUNTING_CONNECTOR:
    'The accounting connector required by this workflow is not available here.',
  NEEDS_MEETING_NOTES: 'The meeting notes input required by this workflow is not available here.',
};
export function runCodeText(code: string | null) {
  return code === null
    ? null
    : (codes[code] ?? 'This step needs attention. Open its work for the current details.');
}
export function runCostText(cost: ProcessRunView['cost']) {
  return cost === null
    ? 'Cost is not measured or is not available to you.'
    : `${cost.isEstimate ? 'Estimate from available recorded entries' : 'Recorded cost'}: USD ${usdTextFromMicros(cost.costMicros)}. This covers the available work cost entries; it is not a price promise.`;
}
export const liveRun = (status: ProcessRunView['status']) =>
  !['completed', 'failed', 'cancelled'].includes(status);
export function stepStatusText(status: ProcessRunView['steps'][number]['status']) {
  return {
    pending: 'Not started',
    ready: 'Ready for the worker',
    waiting: 'Waiting',
    done: 'Done',
    failed: 'Needs attention',
    skipped: 'Not performed',
  }[status];
}
