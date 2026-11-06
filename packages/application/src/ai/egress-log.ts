// Owned by the policy-router slice (SEC-01). Writes `governance.egress_decisions` as the agent role, and
// gives the tenant's people a filtered read. Every stub refuses.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { EgressLog } from './ports';

export function createEgressLog(_database: AppDatabase): EgressLog {
  throw new Error('NOT_IMPLEMENTED');
}

export type EgressDecisionView = {
  id: string;
  runId: string | null;
  profileId: string | null;
  dataClass: string;
  purpose: string;
  decision: 'allow' | 'deny';
  reasonCode: string;
  policyVersion: string;
  createdAt: Date;
};

/** Needs `usage.view`. M5's AGENT-10 builds the machine-readable ledger on this table. */
export function listEgressDecisions(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { runId: string },
): Promise<readonly EgressDecisionView[]> {
  throw new Error('NOT_IMPLEMENTED');
}
