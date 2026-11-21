// For workers only (lint blocks the web tier). Finds a tenant from a hash of its processor reference, which is
// the only way a processor's event ever reaches a tenant (ADR-032 D4).
export { withPaymentCustomerTx } from './tenant';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  createServiceContext,
  withAccountTx,
  TenantAccessDenied,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from './tenant';

type PaymentEventRouteRow = {
  organizationId: string;
  accountId: string;
  paymentId: string;
  executionBindingId: string;
  processor: string;
  providerEventId: string;
  customerRefHash: string;
  accountNamespaceSha256: string;
  identitySha256: string;
  bindingSha256: string;
  webhookBindingSha256: string;
};
export type VerifiedPaymentEventRoute = Readonly<
  PaymentEventRouteRow & { sourceOrganizationId: string; sourceEventId: string }
>;
const routes = new WeakMap<object, Tx>();
/** Only the actual fixed SQL route can create this process-local proof, tied to this exact transaction. */
export function verifiedPaymentEventRoute(
  value: unknown,
  tx: Tx,
  expected: {
    organizationId: string;
    processor: string;
    providerEventId: string;
    customerRefHash: string;
  },
): VerifiedPaymentEventRoute | null {
  if (!value || typeof value !== 'object' || routes.get(value) !== tx) return null;
  const proof = value as VerifiedPaymentEventRoute;
  return proof.organizationId === expected.organizationId &&
    proof.processor === expected.processor &&
    proof.providerEventId === expected.providerEventId &&
    proof.customerRefHash === expected.customerRefHash
    ? proof
    : null;
}

/** The only current payment-event routing path. The fixed function resolves an immutable, qualified stored
 * event and original customer namespace; a payload customer/tenant ID is never an argument. Legacy rows
 * return null. This worker-only service context is constructed from that result, never from browser data. */
export function withVerifiedPaymentEventTx<T>(
  database: AppDatabase,
  operator: TenantContext,
  eventId: string,
  fn: (
    tx: Tx,
    scope: {
      account: { id: string; processor: string };
      context: TenantContext;
      proof: VerifiedPaymentEventRoute;
    },
  ) => Promise<T>,
): Promise<T | null> {
  if (
    operator.actorType !== 'service' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)
  )
    throw new TenantAccessDenied();
  return withAccountTx(database, operator, async (tx) => {
    const result = await tx.execute<PaymentEventRouteRow>(
      sql`select * from billing.payment_customer_event_route(${eventId}::uuid)`,
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      !/^[0-9a-f-]{36}$/.test(row.organizationId) ||
      !/^[0-9a-f-]{36}$/.test(row.accountId) ||
      !/^[0-9a-f-]{36}$/.test(row.paymentId) ||
      !/^[0-9a-f-]{36}$/.test(row.executionBindingId) ||
      !/^[a-z][a-z0-9_]{1,55}$/.test(row.processor) ||
      !row.providerEventId ||
      row.providerEventId.length > 256 ||
      [
        row.customerRefHash,
        row.accountNamespaceSha256,
        row.identitySha256,
        row.bindingSha256,
        row.webhookBindingSha256,
      ].some((value) => !/^[0-9a-f]{64}$/.test(value))
    )
      throw new TenantAccessDenied();
    await tx.execute(sql`select set_config('app.organization_id',${row.organizationId},true),
      set_config('app.actor_type','service',true),set_config('app.user_id','',true),set_config('app.membership_id','',true),
      set_config('app.agent_run_id','',true),set_config('app.interactive_session_id','',true)`);
    const proof = Object.freeze({
      ...row,
      sourceOrganizationId: operator.organizationId,
      sourceEventId: eventId,
    });
    routes.set(proof, tx);
    try {
      return await fn(tx, {
        account: { id: row.accountId, processor: row.processor },
        context: createServiceContext(row.organizationId),
        proof,
      });
    } finally {
      routes.delete(proof);
    }
  });
}

/** The same digest as SQL's `billing.checkout_route`: an order reference, or one provider transaction. */
export function checkoutRoute(kind: 'order' | 'txn', processor: string, ref: string): string {
  return createHash('sha256')
    .update(kind === 'order' ? `order:${ref}` : `txn:${processor}:${ref}`, 'utf8')
    .digest('hex');
}

const CHECKOUT_GUCS = `set_config('app.user_id','',true),set_config('app.membership_id','',true),
  set_config('app.actor_type','service',true),set_config('app.agent_run_id','',true),
  set_config('app.interactive_session_id','',true)`;

/**
 * Inside a delivery's own transaction in the deployment's organization: binds only the hash of one order or
 * provider transaction, which reveals that one checkout row, binds that row's tenant for `fn`, and binds
 * the deployment's organization again before returning, so the reply and the delivery's own state commit
 * with the change in one transaction. Nothing about the tenant comes from the provider. `fn` is not called
 * when nothing matches. Worker-only (lint).
 */
export async function withCheckoutRoute<T>(
  tx: Tx,
  operator: TenantContext,
  routeSha256: string,
  fn: (
    tx: Tx,
    scope: { organizationId: string; sessionId: string; context: TenantContext },
  ) => Promise<T>,
): Promise<{ found: true; value: T } | { found: false }> {
  if (operator.actorType !== 'service' || !/^[0-9a-f]{64}$/.test(routeSha256))
    throw new TenantAccessDenied();
  await tx.execute(sql`select set_config('app.checkout_route_sha256', ${routeSha256}, true)`);
  let found: { organization_id: string; id: string }[];
  try {
    found = (
      await tx.execute<{ organization_id: string; id: string }>(
        sql`select organization_id, id from billing.checkout_sessions
             where order_route_sha256 = ${routeSha256} or txn_route_sha256 = ${routeSha256}`,
      )
    ).rows;
  } finally {
    await restoreQuietly(tx, sql`select set_config('app.checkout_route_sha256', '', true)`);
  }
  if (found.length !== 1) return { found: false };
  const [row] = found;
  await tx.execute(
    sql`select set_config('app.organization_id', ${row!.organization_id}, true), ${sql.raw(CHECKOUT_GUCS)}`,
  );
  try {
    return {
      found: true,
      value: await fn(tx, {
        organizationId: row!.organization_id,
        sessionId: row!.id,
        context: createServiceContext(row!.organization_id),
      }),
    };
  } finally {
    await restoreQuietly(
      tx,
      sql`select set_config('app.organization_id', ${operator.organizationId}, true), ${sql.raw(CHECKOUT_GUCS)}`,
    );
  }
}

/** After a failed statement the transaction only rolls back, so the original error is the one to keep. */
async function restoreQuietly(tx: Tx, statement: ReturnType<typeof sql>) {
  try {
    await tx.execute(statement);
  } catch {
    // The transaction is already failing; it will roll back with every setting it made.
  }
}
