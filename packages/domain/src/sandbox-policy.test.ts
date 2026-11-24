import { describe, expect, it } from 'vitest';
import {
  compileSandboxPolicy,
  sandboxPolicyHash,
  SANDBOX_DEFAULT_CEILINGS,
  SANDBOX_MINIMUM_LIMITS,
  type SandboxLimits,
} from './sandbox';

const request = () => ({
  runtime: 'node24',
  entry: 'main.js',
  network: { mode: 'none' },
  limits: { ...SANDBOX_DEFAULT_CEILINGS },
});
describe('sandbox policy admission', () => {
  it('binds all controls and copies limits so later caller mutation cannot change the accepted policy', () => {
    const input = request();
    const result = compileSandboxPolicy(input, SANDBOX_DEFAULT_CEILINGS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected admission');
    expect(result.policyHash).toBe(sandboxPolicyHash(result.policy));
    expect(result.policy).toMatchObject({
      credentials: 'none',
      environment: 'fixed_empty',
      network: { mode: 'none' },
      filesystem: { root: 'read_only', skill: 'read_only', scratch: 'tmpfs_only' },
    });
    input.limits.pids = 999;
    expect(result.policy.limits.pids).toBe(32);
  });
  it('refuses runtime and network requests before resource admission', () => {
    expect(
      compileSandboxPolicy({ ...request(), runtime: 'shell' }, SANDBOX_DEFAULT_CEILINGS),
    ).toEqual({ ok: false, code: 'RUNTIME_NOT_SUPPORTED' });
    for (const mode of ['host', 'allowlist', ''])
      expect(
        compileSandboxPolicy({ ...request(), network: { mode } }, SANDBOX_DEFAULT_CEILINGS),
      ).toEqual({ ok: false, code: 'NETWORK_NOT_ALLOWED' });
  });
  it.each(Object.keys(SANDBOX_DEFAULT_CEILINGS) as (keyof SandboxLimits)[])(
    'refuses invalid %s, without silently clamping',
    (field) => {
      for (const value of [
        SANDBOX_DEFAULT_CEILINGS[field] + 1,
        SANDBOX_MINIMUM_LIMITS[field] - 1,
        NaN,
        Infinity,
        1.5,
      ]) {
        const input = request();
        input.limits[field] = value;
        expect(compileSandboxPolicy(input, SANDBOX_DEFAULT_CEILINGS)).toEqual({
          ok: false,
          code: 'LIMITS_OVER_CEILING',
        });
      }
    },
  );
});
