import { randomUUID } from 'node:crypto';
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { describe, expect, it, vi } from 'vitest';
import {
  advanceSubscriptionInTx,
  changePlan,
  getBillingOverview,
  requestCancellation,
  saveBillingAccount,
  startSubscription,
  startSubscriptionOnce,
  withdrawCancellation,
} from './subscriptions';
import { provisionTenant, setTenantStandingInTx } from './standing';

const context = {
  actorType: 'user',
  role: 'member',
  organizationId: randomUUID(),
  userId: randomUUID(),
  membershipId: randomUUID(),
} as TenantContext;
const transaction = vi.fn();
const database = { transaction } as unknown as AppDatabase;
const tx = {} as Tx;
const account = {
  billingName: 'Test',
  billingEmail: 'billing@example.invalid',
  countryCode: 'XX',
  regionCode: '',
  taxId: null,
  postalCode: null,
  expectedVersion: null,
};
const agents = { haltTenantAgents: vi.fn(), releaseTenantAgents: vi.fn() };

describe('billing permission boundaries precede transaction access', () => {
  it.each([
    ['overview', () => getBillingOverview(database, context, { billingEnabled: true })],
    ['account', () => saveBillingAccount(database, context, account)],
    ['start', () => startSubscription(database, context, { planVersionId: randomUUID() })],
    [
      'idempotent start',
      () =>
        startSubscriptionOnce(database, context, {
          planVersionId: randomUUID(),
          requestKey: randomUUID(),
        }),
    ],
    [
      'change',
      () => changePlan(database, context, { toPlanVersionId: randomUUID(), expectedVersion: 1 }),
    ],
    ['cancel', () => requestCancellation(database, context, { expectedVersion: 1 })],
    ['withdraw', () => withdrawCancellation(database, context, { expectedVersion: 1 })],
    [
      'advance',
      () => advanceSubscriptionInTx(tx, context, { subscriptionId: randomUUID(), now: new Date() }),
    ],
    [
      'standing',
      () =>
        setTenantStandingInTx(
          tx,
          context,
          { to: 'suspended', reasonCode: 'TEST_TERMS', actor: { type: 'operator', ref: 'test' } },
          agents,
        ),
    ],
  ] as const)('member %s refuses as not found', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('service cannot edit contact details or request a person-only purchase', async () => {
    const service = createServiceContext(randomUUID());
    await expect(saveBillingAccount(database, service, account)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      startSubscriptionOnce(database, service, {
        planVersionId: randomUUID(),
        requestKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('an absent trusted provisioning capability or unknown person creates nothing', async () => {
    const input = {
      organizationName: 'Test',
      commercialMode: 'byom' as const,
      ownerEmail: 'owner@example.invalid',
      planVersionId: randomUUID(),
      operatorRef: 'test',
      requestKey: randomUUID(),
    };
    await expect(provisionTenant(database, input)).rejects.toMatchObject({
      code: 'PREREQUISITES_INCOMPLETE',
    });
    const issue = vi.fn();
    await expect(
      provisionTenant(database, input, {
        prepare: async () => null,
        issueOwnerInvitationInTx: issue,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(transaction).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });
});
