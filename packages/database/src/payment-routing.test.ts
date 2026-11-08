import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createServiceContext, type AppDatabase, type Tx } from './tenant';
import { withVerifiedPaymentEventTx, verifiedPaymentEventRoute, type VerifiedPaymentEventRoute } from './payment-routing';
const row = { organizationId: randomUUID(), accountId: randomUUID(), paymentId: randomUUID(), executionBindingId: randomUUID(), processor: 'test_scripted',
  providerEventId: 'generated-event', customerRefHash: 'a'.repeat(64), accountNamespaceSha256: 'b'.repeat(64), identitySha256: 'c'.repeat(64), bindingSha256: 'd'.repeat(64), webhookBindingSha256: 'e'.repeat(64) };
const expected = { organizationId: row.organizationId, processor: row.processor, providerEventId: row.providerEventId, customerRefHash: row.customerRefHash };
describe('process-local payment routing proof scope (explicit metadata SQL double)', () => {
  it('requires the actual callback transaction and exact tenant/customer/event, then expires on return', async () => {
    const tx = { execute: vi.fn(async () => ({ rows: [row] })) } as unknown as Tx;
    const database = { transaction: async (_bindings: unknown, callback: (value: Tx) => Promise<unknown>) => callback(tx) } as unknown as AppDatabase;
    let held: VerifiedPaymentEventRoute | undefined;
    await withVerifiedPaymentEventTx(database, createServiceContext(randomUUID()), randomUUID(), async (actual, scope) => {
      held = scope.proof;
      expect(verifiedPaymentEventRoute(scope.proof, actual, expected)).toBe(scope.proof);
      expect(verifiedPaymentEventRoute({ ...scope.proof }, actual, expected)).toBeNull();
      expect(verifiedPaymentEventRoute(scope.proof, {} as Tx, expected)).toBeNull();
      for (const changed of [{ organizationId: randomUUID() }, { processor: 'another_test' }, { providerEventId: 'another-event' }, { customerRefHash: 'f'.repeat(64) }])
        expect(verifiedPaymentEventRoute(scope.proof,actual,{...expected,...changed})).toBeNull();
    });
    expect(verifiedPaymentEventRoute(held,tx,expected)).toBeNull();
  });
  it('does not mint any context/proof for a missing legacy route or malformed metadata', async () => {
    const callback = vi.fn();
    for (const rows of [[], [{...row,bindingSha256:'not-a-proof'}], [row,row]]) {
      const tx = { execute: vi.fn(async () => ({ rows })) } as unknown as Tx;
      const database = { transaction: async (_bindings: unknown, fn: (value: Tx) => Promise<unknown>) => fn(tx) } as unknown as AppDatabase;
      if (!rows.length) expect(await withVerifiedPaymentEventTx(database,createServiceContext(randomUUID()),randomUUID(),callback)).toBeNull();
      else await expect(withVerifiedPaymentEventTx(database,createServiceContext(randomUUID()),randomUUID(),callback)).rejects.toMatchObject({ name:'TenantAccessDenied' });
    }
    expect(callback).not.toHaveBeenCalled();
  });
});
