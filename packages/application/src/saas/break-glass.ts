// The customer's and the operator's signatures on a break-glass request. Owned by the support slice (OPS-24).
// Default is no access. A second authorizer, a time limit and an audit trail are required, and even a fully
// authorized request reads nothing in M8: there is no such path. See ADR-032 D8.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { EnsemusDrizzle } from '@ensemus/database/operator';
import type { BreakGlassConfig, BreakGlassState } from '@ensemus/saas/support';

export type BreakGlassView = {
  id: string;
  ticketId: string;
  reasonCode: string;
  scopeType: string;
  scopeId: string;
  requestedMinutes: number;
  state: BreakGlassState;
  operatorAuthorized: boolean;
  customerAuthorized: boolean;
  expiresAt: Date | null;
  version: number;
};

/** `break_glass.authorize`, which only an owner has. */
export function listBreakGlassRequests(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly BreakGlassView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * `break_glass.authorize`, and a person. The customer's side: agree or refuse. Applies `signBreakGlass`, logs
 * it, audits it, and tells the other owners. Refusing is final. An approval needs the scope to be in this tenant.
 */
export function decideBreakGlass(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    requestId: string;
    decision: 'authorize' | 'deny';
    expectedVersion: number;
  },
  _config: BreakGlassConfig,
): Promise<{ state: BreakGlassState; expiresAt: Date | null }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** `break_glass.authorize`. A customer can end it at any moment, whoever agreed to it. */
export function revokeBreakGlass(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { requestId: string; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** The operator's side, from the command line, as `ensemus_operator`. Never the person who asked. */
export function authorizeBreakGlassAsOperator(
  _db: EnsemusDrizzle,
  _input: { organizationId: string; requestId: string; operatorRef: string },
  _config: BreakGlassConfig,
  _now: Date,
): Promise<{ state: BreakGlassState; expiresAt: Date | null }> {
  throw new Error('NOT_IMPLEMENTED');
}
