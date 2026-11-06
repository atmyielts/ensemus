// Owned by the policy-router slice (SEC-01). What a tool may do, independent of any model. Deny wins over
// require_approval, which wins over allow. This stub denies everything.
import type { ActionDecision, ActionInput } from './types';

export function decideAction(_input: ActionInput): ActionDecision {
  return { decision: 'deny', reasonCode: 'POLICY_UNREADABLE' };
}
