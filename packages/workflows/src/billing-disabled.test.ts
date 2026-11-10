import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@ensemus/database';
import { describe, expect, it, vi } from 'vitest';
import { createBillingActivities } from './billing-activities';
import { createCreditActivities } from './credit-activities';

describe('replayed billing work with hosted billing disabled', () => {
  it.each([false, undefined])(
    'refuses every new financial effect before database access (%j)',
    async (billingEnabled) => {
      const touched = vi.fn(() => {
        throw new Error('TEST_DATABASE_MUST_NOT_BE_REACHED');
      });
      const database = new Proxy({}, { get: touched }) as AppDatabase;
      const usage = { listSince: vi.fn(), sumForPeriod: vi.fn() };
      const agents = { haltTenantAgents: vi.fn(), releaseTenantAgents: vi.fn() };
      const deps = {
        database,
        usage,
        agents,
        ...(billingEnabled === undefined ? {} : { billingEnabled }),
      };
      const billing = createBillingActivities(deps),
        credits = createCreditActivities(deps);
      const input = { organizationId: randomUUID() };
      for (const invoke of [
        () => billing.runBillingSweep(input),
        () => billing.runCollectionsStep(input),
        () => billing.issueDraftInvoice({ ...input, invoiceId: randomUUID() }),
        () => credits.consumeUsagePage(input),
      ])
        await expect(invoke()).rejects.toMatchObject({ code: 'BILLING_NOT_ENABLED' });
      expect(touched).not.toHaveBeenCalled();
      expect(usage.listSince).not.toHaveBeenCalled();
      expect(usage.sumForPeriod).not.toHaveBeenCalled();
      expect(agents.haltTenantAgents).not.toHaveBeenCalled();
      expect(agents.releaseTenantAgents).not.toHaveBeenCalled();
    },
  );
});
