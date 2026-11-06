// Owned by the payments slice (BILL-01, OPS-21). Failed payments follow the published rules, without data
// loss. With no approved policy nothing automatic happens, and a person decides. See ADR-032 D5.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { AgentHaltPort } from './ports';

export type CollectionOutcome = {
  opened: number;
  stepsTaken: number;
  /** Overdue with no approved policy. It waits for a person, and an operator's alert counts these. */
  noPolicy: number;
};

/**
 * Service only, from the billing cycle. For each overdue invoice: opens a case on the subscription's policy,
 * and takes each due step once, by moving `step_no` under the case's lock. `retry` asks for a new payment
 * only when none is live. `read_only` and `suspend` go through `setTenantStandingInTx`. Nothing deletes.
 * An invoice paid since resolves its case, and gives the tenant back its standing.
 */
export function runCollections(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: { agents: AgentHaltPort },
  _now: Date,
): Promise<CollectionOutcome> {
  throw new Error('NOT_IMPLEMENTED');
}
