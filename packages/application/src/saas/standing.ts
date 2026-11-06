// Owned by the subscriptions slice (OPS-21). A tenant's standing, which is what suspension is. Moving it
// never deletes anything, and the database refuses a move with no record beside it. See ADR-032 D5.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import { accountContextOf } from '@ensemus/database/account';
import type { TenantLifecycle } from '@ensemus/saas/entitlements';
import { AppError } from '../errors';

export type StandingActor =
  | { type: 'operator'; ref: string }
  | { type: 'system'; ref: string; collectionPolicyId: string }
  | { type: 'membership'; ref: string };

/**
 * Service only. Writes `billing.standing_changes` and then the lifecycle, in that order, in the caller's
 * transaction. Emits TENANT_STANDING_CHANGED, tells owners, and halts or releases agents through the port.
 * A repeat that changes nothing writes nothing.
 */
export function setTenantStandingInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: { to: TenantLifecycle; reasonCode: string; actor: StandingActor },
  _agents: import('./ports').AgentHaltPort,
): Promise<'changed' | 'unchanged'> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * For handing M6's export service a context that can write in any standing, since a customer leaving or
 * suspended must still be able to get their data out (ADR-032 D5). Nothing else should need this.
 */
export const forExportInAnyStanding = (context: TenantContext) => accountContextOf(context);

export type AccountSurface = 'core' | 'account';

/**
 * Whether this person may use this surface. `core` is everything ordinary, and `account` is billing, export,
 * support and leaving. A suspended or leaving tenant loses `core`, as a TENANT_SUSPENDED error the web tier
 * turns into its own page. A read-only one keeps its reads, and PostgreSQL refuses its writes. Fixed by the
 * foundation, because every route and page goes through it. Pure on the context, so it is cheap.
 */
export function assertServing(context: TenantContext, surface: AccountSurface): void {
  if (surface === 'account') return;
  if (context.serving === 'suspended' || context.serving === 'offboarding') {
    throw new AppError('TENANT_SUSPENDED');
  }
}

/** Provisions a new tenant from the operator's command, and ends with the owner's invitation link. */
export function provisionTenant(
  _database: AppDatabase,
  _input: {
    organizationName: string;
    commercialMode: 'cloud' | 'byom';
    ownerEmail: string;
    planVersionId: string;
    operatorRef: string;
  },
): Promise<{ organizationId: string; invitationToken: string }> {
  throw new Error('NOT_IMPLEMENTED');
}
