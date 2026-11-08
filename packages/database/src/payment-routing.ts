// For workers only (lint blocks the web tier). Finds a tenant from a hash of its processor reference, which is
// the only way a processor's event ever reaches a tenant (ADR-032 D4).
export { withPaymentCustomerTx } from './tenant';

import { sql } from 'drizzle-orm';
import { createServiceContext, withAccountTx, TenantAccessDenied, type AppDatabase, type TenantContext, type Tx } from './tenant';

/** The only current payment-event routing path. The fixed function resolves an immutable, qualified stored
 * event and original customer namespace; a payload customer/tenant ID is never an argument. Legacy rows
 * return null. This worker-only service context is constructed from that result, never from browser data. */
export function withVerifiedPaymentEventTx<T>(database: AppDatabase, operator: TenantContext, eventId: string,
  fn: (tx: Tx, scope: { account: { id: string; processor: string }; context: TenantContext }) => Promise<T>,
): Promise<T | null> {
  if (operator.actorType !== 'service' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId))
    throw new TenantAccessDenied();
  return withAccountTx(database, operator, async (tx) => {
    const result = await tx.execute<{ organizationId: string; accountId: string; processor: string }>(
      sql`select * from billing.payment_customer_event_route(${eventId}::uuid)`,
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || !/^[0-9a-f-]{36}$/.test(row.organizationId)
      || !/^[0-9a-f-]{36}$/.test(row.accountId) || !/^[a-z][a-z0-9_]{1,55}$/.test(row.processor)) throw new TenantAccessDenied();
    await tx.execute(sql`select set_config('app.organization_id',${row.organizationId},true),
      set_config('app.actor_type','service',true),set_config('app.user_id','',true),set_config('app.membership_id','',true),
      set_config('app.agent_run_id','',true),set_config('app.interactive_session_id','',true)`);
    return fn(tx, { account: { id: row.accountId, processor: row.processor }, context: createServiceContext(row.organizationId) });
  });
}
