import { randomUUID } from 'node:crypto';
import { createOrganization, resolveTenantContext, type AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { startSubscription } from '@ensemus/application/saas/subscriptions';
import {
  draftDuePeriodInvoices,
  getInvoice,
  issueInvoice,
  listInvoices,
} from '@ensemus/application/saas/invoices';
import { hashCustomerRef } from '@ensemus/saas/payment';
import type pg from 'pg';
import { seedBillingAccount, seedPlan } from '../helpers/saas';

export const paymentAgents = {
  haltTenantAgents: async () => undefined,
  releaseTenantAgents: async () => undefined,
};
export async function paymentTenant(database: AppDatabase, auth: pg.Client) {
  const userId = randomUUID();
  await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
    userId,
    'Same payment name',
    `${userId}@example.invalid`,
  ]);
  const org = await createOrganization(database, {
    userId,
    name: 'Same payment name',
    commercialMode: 'byom',
  });
  return resolveTenantContext(database, userId, org.organizationId);
}
export async function paymentFixture(database: AppDatabase, auth: pg.Client) {
  const owner = await paymentTenant(database, auth),
    service = createServiceContext(owner.organizationId),
    customerRef = `test-customer:${randomUUID()}`;
  await seedBillingAccount(database, owner, {
    processor: 'test_scripted',
    processorCustomerRef: customerRef,
    customerRefHash: hashCustomerRef('test_scripted', customerRef),
  });
  const plan = await seedPlan({ mode: 'byom' });
  const startsAt = new Date(Date.now() - 40 * 86400000);
  const subscription = await startSubscription(database, service, {
    planVersionId: plan.planVersionId,
    startsAt,
  });
  await draftDuePeriodInvoices(
    database,
    service,
    {
      usage: {
        listSince: async () => ({ entries: [], nextCursor: null }),
        sumForPeriod: async () => [],
      },
      agents: paymentAgents,
    },
    new Date(),
  );
  const row = (await listInvoices(database, owner, {})).items[0]!;
  await issueInvoice(database, service, {
    invoiceId: row.id,
    tax: { taxMicros: 0n, providerRef: null },
  });
  return {
    owner,
    service,
    customerRef,
    plan,
    subscription,
    invoice: await getInvoice(database, owner, row.id),
  };
}
