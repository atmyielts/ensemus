// ID-05 and KNOW-07: the pure rules. Everything that depends on them is denied by default.
import { describe, expect, it } from 'vitest';
import {
  canChangeRecord,
  canProduct,
  canReadRecord,
  mfaDecision,
  PRIVILEGED_ACTIONS,
  type PrivilegedAction,
} from './product-policy';

const NOW = new Date('2026-11-06T12:00:00Z');
const facts = (over: Partial<Parameters<typeof mfaDecision>[1]> = {}) => ({
  verifiedAt: new Date(NOW.getTime() - 60_000),
  maxAgeSeconds: 900,
  mfaForAdministration: false,
  actorType: 'user' as const,
  ...over,
});

describe('recent MFA', () => {
  it('allows a recent proof', () => {
    expect(mfaDecision('studio.publish', facts(), NOW)).toBe('allow');
  });
  it('requires a real recent person for bounded paid-model/data-egress approval independently of opt-in administration', () => {
    expect(PRIVILEGED_ACTIONS['model_workload.approve']).toBe('always');
    expect(
      mfaDecision(
        'model_workload.approve',
        facts({ verifiedAt: null, mfaForAdministration: false }),
        NOW,
      ),
    ).toBe('require_mfa');
    expect(mfaDecision('model_workload.approve', facts(), NOW)).toBe('allow');
    for (const actorType of ['agent', 'delegated', 'service'])
      expect(mfaDecision('model_workload.approve', facts({ actorType }), NOW)).toBe('deny_service');
    expect(Object.keys(PRIVILEGED_ACTIONS)).not.toContain('model_workload.revoke');
  });

  it('refuses no proof, an old proof, and a proof from the future', () => {
    expect(mfaDecision('studio.publish', facts({ verifiedAt: null }), NOW)).toBe('require_mfa');
    const old = new Date(NOW.getTime() - 901_000);
    expect(mfaDecision('studio.publish', facts({ verifiedAt: old }), NOW)).toBe('require_mfa');
    const ahead = new Date(NOW.getTime() + 1000);
    expect(mfaDecision('studio.publish', facts({ verifiedAt: ahead }), NOW)).toBe('require_mfa');
  });

  it('never passes a service, even for an action a tenant has not extended', () => {
    for (const action of Object.keys(PRIVILEGED_ACTIONS) as PrivilegedAction[]) {
      expect(mfaDecision(action, facts({ actorType: 'service' }), NOW)).toBe('deny_service');
    }
  });

  it('asks for administration actions only when the tenant turned that on', () => {
    expect(mfaDecision('member.manage', facts({ verifiedAt: null }), NOW)).toBe('allow');
    expect(
      mfaDecision('member.manage', facts({ verifiedAt: null, mfaForAdministration: true }), NOW),
    ).toBe('require_mfa');
  });

  it('cannot be turned off for the actions that always ask', () => {
    for (const [action, tier] of Object.entries(PRIVILEGED_ACTIONS)) {
      if (tier !== 'always') continue;
      expect(mfaDecision(action as PrivilegedAction, facts({ verifiedAt: null }), NOW)).toBe(
        'require_mfa',
      );
    }
  });
});

describe('product capabilities', () => {
  it('denies an unknown role everything', () => {
    expect(canProduct('service', 'studio.author')).toBe(false);
    expect(canProduct('__proto__', 'studio.author')).toBe(false);
  });

  it('keeps Studio, packs and SSO from a member', () => {
    for (const capability of [
      'studio.author',
      'studio.publish',
      'pack.manage',
      'sso.manage',
    ] as const) {
      expect(canProduct('member', capability)).toBe(false);
    }
  });

  it('keeps the security policy with the owner', () => {
    expect(canProduct('owner', 'security_policy.manage')).toBe(true);
    expect(canProduct('admin', 'security_policy.manage')).toBe(false);
  });
});

describe('custom record access', () => {
  const record = (classification: string, ownerMembershipId = 'o') => ({
    classification,
    ownerMembershipId,
  });

  it('keeps restricted records from an organization admin who does not hold them', () => {
    expect(canReadRecord(record('restricted'), { membershipId: 'a', role: 'admin' })).toBe(false);
    expect(canReadRecord(record('restricted'), { membershipId: 'o', role: 'member' })).toBe(true);
  });

  it('keeps confidential records from another member', () => {
    expect(canReadRecord(record('confidential'), { membershipId: 'm', role: 'member' })).toBe(
      false,
    );
    expect(canReadRecord(record('confidential'), { membershipId: 'a', role: 'admin' })).toBe(true);
  });

  it('denies a classification it does not know', () => {
    expect(canReadRecord(record('secret'), { membershipId: 'o', role: 'owner' })).toBe(false);
  });

  it('does not let reading alone change a record', () => {
    expect(canChangeRecord(record('internal'), { membershipId: 'm', role: 'member' })).toBe(false);
    expect(canChangeRecord(record('internal', 'm'), { membershipId: 'm', role: 'member' })).toBe(
      true,
    );
    expect(canChangeRecord(record('restricted'), { membershipId: 'a', role: 'admin' })).toBe(false);
  });
});
