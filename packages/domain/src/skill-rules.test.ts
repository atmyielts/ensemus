// ADR-034: the small pure rules the foundation decided. The rest of the domain's stubs are tested by their slices.
import { describe, expect, it } from 'vitest';
import {
  listingObjectKey,
  REVIEW_CHECKS,
  reviewCanApprove,
  type ReviewChecks,
} from './marketplace';
import {
  canTransitionSandboxRun,
  ISOLATION_CHECKS,
  isSettledSandboxRun,
  probePassed,
  sandboxAcceptsClassification,
  sandboxPolicyHash,
  SANDBOX_DEFAULT_CEILINGS,
  type SandboxPolicy,
} from './sandbox';
import {
  canTransitionSkillVersion,
  compareSemver,
  parseSemver,
  skillBundleObjectKey,
  skillUseDenial,
  type SkillUseFacts,
} from './skill';

describe('a version number', () => {
  it.each([
    ['1.2.3', { major: 1, minor: 2, patch: 3 }],
    ['0.0.0', { major: 0, minor: 0, patch: 0 }],
  ])('reads %s', (value, parsed) => {
    expect(parseSemver(value)).toEqual(parsed);
  });

  it.each(['1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2.3-beta', '1.2.3+build', '', ' 1.2.3'])(
    'refuses %j, because a version means one thing',
    (value) => {
      expect(parseSemver(value)).toBeNull();
    },
  );

  it('orders by number, not as text', () => {
    const order = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);
    expect(order('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(order('2.0.0', '10.0.0')).toBeLessThan(0);
    expect(order('1.2.3', '1.2.3')).toBe(0);
  });
});

describe('whether a version may be used', () => {
  const usable: SkillUseFacts = {
    state: 'published',
    packageState: 'active',
    origin: 'tenant',
    signerState: 'active',
    listingDelistMode: null,
  };

  it('allows a published version of an active package with a trusted signer', () => {
    expect(skillUseDenial(usable)).toBeNull();
  });

  it.each(['uploaded', 'verifying', 'verified', 'rejected', 'yanked'] as const)(
    'refuses a version that is %s',
    (state) => {
      expect(skillUseDenial({ ...usable, state })).toBe('NOT_PUBLISHED');
    },
  );

  it('refuses a disabled package', () => {
    expect(skillUseDenial({ ...usable, packageState: 'disabled' })).toBe('PACKAGE_DISABLED');
  });

  it.each(['revoked', null] as const)('refuses a tenant package whose signer is %s', (signerState) => {
    expect(skillUseDenial({ ...usable, signerState })).toBe('SIGNER_REVOKED');
  });

  it('keeps a marketplace copy working after new installs stop, and stops it on a revoke', () => {
    const copy = { ...usable, origin: 'marketplace' as const, signerState: null };
    expect(skillUseDenial({ ...copy, listingDelistMode: 'stop_new' })).toBeNull();
    expect(skillUseDenial({ ...copy, listingDelistMode: 'revoke' })).toBe('LISTING_REVOKED');
  });

  it('has no move that revives a version', () => {
    expect(canTransitionSkillVersion('yanked', 'published')).toBe(false);
    expect(canTransitionSkillVersion('rejected', 'verifying')).toBe(false);
    expect(canTransitionSkillVersion('uploaded', 'published')).toBe(false);
    expect(canTransitionSkillVersion('verified', 'uploaded')).toBe(false);
  });

  it('starts every object key with the tenant', () => {
    expect(skillBundleObjectKey('org', 'version')).toBe('org/skills/version');
  });
});

describe('sandbox runs', () => {
  it('can only retry from running', () => {
    expect(canTransitionSandboxRun('running', 'queued')).toBe(true);
    expect(canTransitionSandboxRun('succeeded', 'queued')).toBe(false);
    expect(canTransitionSandboxRun('denied', 'running')).toBe(false);
    expect(isSettledSandboxRun('queued')).toBe(false);
    expect(isSettledSandboxRun('runner_unavailable')).toBe(true);
  });

  it('never accept restricted data, whatever a package says', () => {
    expect(sandboxAcceptsClassification('restricted', 'restricted')).toBe(false);
    expect(sandboxAcceptsClassification('confidential', 'internal')).toBe(false);
    expect(sandboxAcceptsClassification('internal', 'internal')).toBe(true);
    expect(sandboxAcceptsClassification('public', 'confidential')).toBe(true);
  });

  const policy: SandboxPolicy = {
    policyVersion: 1,
    runtime: 'node24',
    entry: 'main.mjs',
    network: { mode: 'none' },
    credentials: 'none',
    environment: 'fixed_empty',
    filesystem: { root: 'read_only', skill: 'read_only', scratch: 'tmpfs_only' },
    limits: SANDBOX_DEFAULT_CEILINGS,
  };

  it('bind a run to its policy, so any change is a different hash', () => {
    expect(sandboxPolicyHash(policy)).toBe(sandboxPolicyHash({ ...policy }));
    expect(sandboxPolicyHash(policy)).not.toBe(
      sandboxPolicyHash({ ...policy, limits: { ...policy.limits, memoryMb: 1024 } }),
    );
  });
});

describe('a probe report', () => {
  const report = (checks: ReadonlyArray<{ check: (typeof ISOLATION_CHECKS)[number]; passed: boolean }>) => ({
    runtime: 'test',
    runtimeVersion: '0',
    probedAt: new Date(0).toISOString(),
    checks,
  });
  const all = ISOLATION_CHECKS.map((check) => ({ check, passed: true }));

  it('passes only with every check on the list passing', () => {
    expect(probePassed(report(all))).toBe(true);
  });

  it('fails when one check failed', () => {
    const [first, ...rest] = all;
    expect(probePassed(report([{ check: first!.check, passed: false }, ...rest]))).toBe(false);
  });

  it('fails when one check is missing, so a short report proves nothing', () => {
    expect(probePassed(report(all.slice(1)))).toBe(false);
    expect(probePassed(report([]))).toBe(false);
  });
});

describe('a security review', () => {
  const passed = Object.fromEntries(REVIEW_CHECKS.map((check) => [check, 'pass'])) as ReviewChecks;

  it('approves with every check passed and nothing found', () => {
    expect(reviewCanApprove(passed, [], 'sandbox')).toBe(true);
  });

  it('cannot approve with a finding', () => {
    expect(reviewCanApprove(passed, ['HARMFUL_CODE'], 'sandbox')).toBe(false);
  });

  it('cannot approve with a failed check', () => {
    expect(
      reviewCanApprove({ ...passed, instructions_read_for_abuse: 'fail' }, [], 'declarative'),
    ).toBe(false);
  });

  it('lets only a package with no code skip reading its code', () => {
    const skipped: ReviewChecks = { ...passed, code_read_for_abuse: 'not_applicable' };
    expect(reviewCanApprove(skipped, [], 'declarative')).toBe(true);
    expect(reviewCanApprove(skipped, [], 'sandbox')).toBe(false);
  });

  it.each(REVIEW_CHECKS.filter((check) => check !== 'code_read_for_abuse'))(
    'cannot skip %s, even for a package with no code',
    (check) => {
      expect(reviewCanApprove({ ...passed, [check]: 'not_applicable' }, [], 'declarative')).toBe(
        false,
      );
    },
  );

  it('names a listing copy by what it holds', () => {
    expect(listingObjectKey('abc')).toBe('marketplace/abc');
  });
});
