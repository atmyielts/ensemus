// Owned by the policy-router slice (SEC-01). The table comes from docs/specifications/data-egress-matrix.csv,
// cell by cell with the stricter reading where the docs differ (ADR-028 G7). This stub denies everything.
import type { EgressDecision, EgressInput } from './types';

export function decideEgress(_input: EgressInput): EgressDecision {
  return {
    decision: 'deny',
    reasonCode: 'POLICY_UNREADABLE',
    policyVersion: 'unbuilt',
    expiresAt: null,
    obligations: [],
  };
}
