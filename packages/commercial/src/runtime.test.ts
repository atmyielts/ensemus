import { randomUUID } from 'node:crypto';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntitlementChecker } from '@ensemus/application/saas/entitlements';
import { createEntitlements } from './index';

vi.mock('@ensemus/application/saas/entitlements', () => ({
  createEntitlementChecker: vi.fn(),
  getEntitlements: vi.fn(),
}));
const check = vi.fn();
const context = { organizationId: randomUUID() } as TenantContext;
const database = {} as AppDatabase;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createEntitlementChecker).mockReturnValue({ check, decide: vi.fn() });
});

describe('actual commercial runtime binding', () => {
  it('does not turn positive-balance compatibility into Cloud dispatch without actual prepaid holds', async () => {
    check.mockResolvedValue({ ok: true, billable: true, commercialMode: 'cloud' });
    expect(
      await createEntitlements(database, { billingEnabled: true }).check(context, 'model.call'),
    ).toEqual({ ok: false, code: 'ENTITLEMENT_DENIED' });
    expect(check).toHaveBeenCalledOnce();
  });
  it('passes the explicit deployment flag and defaults missing billing configuration to false', async () => {
    createEntitlements(database);
    expect(createEntitlementChecker).toHaveBeenLastCalledWith(database, false);
    createEntitlements(database, { billingEnabled: true });
    expect(createEntitlementChecker).toHaveBeenLastCalledWith(database, true);
  });
  it('preserves BYOM customer-billed and the existing offline Sovereign port', async () => {
    const entitlement = createEntitlements(database, { billingEnabled: false });
    check.mockResolvedValueOnce({ ok: true, billable: false, commercialMode: 'byom' });
    expect(await entitlement.check(context, 'model.call')).toEqual({
      ok: true,
      billable: false,
      commercialMode: 'byom',
    });
    check.mockResolvedValueOnce({ ok: true, billable: false, commercialMode: 'sovereign' });
    expect(await entitlement.check(context, 'model.call')).toEqual({
      ok: true,
      billable: false,
      commercialMode: 'sovereign',
    });
  });
});
