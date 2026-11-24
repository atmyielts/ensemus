import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@ensemus/database';
import { entitledSkillFeatureGate } from './skill-ports';
const context = { organizationId: '00000000-0000-4000-8000-000000000001' } as TenantContext;
describe('skill deployment and entitlement admission', () => {
  it('does not consult commercial admission for a feature the operator disabled', async () => {
    const check = vi.fn(async () => ({ ok: true }));
    const gate = entitledSkillFeatureGate(
      { skill_catalog: false, sandbox: false, marketplace: false },
      { check },
    );
    expect(await gate.isEnabled(context, 'skill_catalog')).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });
  it('checks the current entitlement again on every admission and names the exact feature', async () => {
    const check = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    const gate = entitledSkillFeatureGate(
      { skill_catalog: true, sandbox: true, marketplace: true },
      { check },
    );
    expect(await gate.isEnabled(context, 'skill_catalog')).toBe(true);
    expect(await gate.isEnabled(context, 'skill_catalog')).toBe(false);
    expect(check).toHaveBeenNthCalledWith(1, context, 'skill_catalog');
    expect(check).toHaveBeenCalledTimes(2);
  });
  it('propagates an unavailable entitlement service so no outage becomes permission', async () => {
    const failure = new Error('Generated outage');
    const check = vi.fn(async () => {
      throw failure;
    });
    const gate = entitledSkillFeatureGate(
      { skill_catalog: true, sandbox: true, marketplace: true },
      { check },
    );
    await expect(gate.isEnabled(context, 'sandbox')).rejects.toBe(failure);
  });
});
