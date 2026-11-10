import { describe, expect, it } from 'vitest';
import { createServiceContext } from '@ensemus/database/service';
import type { Tx } from '@ensemus/database';
import { loadEntitlementMetadataInTx } from './entitlement-metadata';

const context = createServiceContext('90000000-0000-4000-8000-000000000001');
const valid = {
  planVersionId: '90000000-0000-4000-8000-000000000002',
  subscriptionStatus: 'active',
  balanceMicrocredits: '-5',
  standingReasonCode: 'TEST_STANDING',
  standingChangedAt: new Date('2026-01-01T00:00:00Z'),
};
const tx = (rows: unknown[]) => ({ execute: async () => ({ rows }) }) as unknown as Tx;

describe('the bounded standing metadata result', () => {
  it('maps only the fixed native person refusal to the application authorization result', async () => {
    const denied = new Error('TEST_WRAPPED', {
      cause: { code: '42501', message: 'ENTITLEMENT_METADATA_PERSON' },
    });
    const database = {
      execute: async () => {
        throw denied;
      },
    } as unknown as Tx;
    await expect(loadEntitlementMetadataInTx(database, context)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it.each([
    { code: '42501', message: 'permission denied for function current_entitlement_metadata' },
    { code: '08006', message: 'TEST_CONNECTION_LOST' },
  ])('does not hide an infrastructure/grant failure as missing licensing: %j', async (cause) => {
    const failure = new Error('TEST_WRAPPED', { cause });
    const database = {
      execute: async () => {
        throw failure;
      },
    } as unknown as Tx;
    await expect(loadEntitlementMetadataInTx(database, context)).rejects.toBe(failure);
  });
  it('keeps a real overdrawn balance and exposes only the five reviewed fields', async () => {
    const result = await loadEntitlementMetadataInTx(tx([valid]), context);
    expect(result).toEqual({ ...valid, balanceMicrocredits: -5n });
    expect(Object.keys(result).sort()).toEqual(
      [
        'planVersionId',
        'subscriptionStatus',
        'balanceMicrocredits',
        'standingReasonCode',
        'standingChangedAt',
      ].sort(),
    );
  });
  it('allows the explicit no-subscription metadata result', async () => {
    expect(
      await loadEntitlementMetadataInTx(
        tx([
          {
            planVersionId: null,
            subscriptionStatus: null,
            balanceMicrocredits: 0n,
            standingReasonCode: null,
            standingChangedAt: null,
          },
        ]),
        context,
      ),
    ).toEqual({
      planVersionId: null,
      subscriptionStatus: null,
      balanceMicrocredits: 0n,
      standingReasonCode: null,
      standingChangedAt: null,
    });
  });
  it.each([
    { ...valid, billingEmail: 'generated-fixture@example.invalid' },
    { ...valid, subscriptionStatus: 'unsupported' },
    { ...valid, planVersionId: null },
    { ...valid, balanceMicrocredits: 'not-a-balance' },
    { ...valid, standingReasonCode: 'unreviewed free text' },
    { ...valid, standingChangedAt: 'not-a-time' },
  ])('refuses malformed or private-field result %j', async (row) => {
    await expect(loadEntitlementMetadataInTx(tx([row]), context)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it.each([{ rows: [] }, { rows: [valid, valid] }])(
    'refuses an absent or ambiguous row set %j',
    async ({ rows }) => {
      await expect(loadEntitlementMetadataInTx(tx(rows), context)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    },
  );
});
