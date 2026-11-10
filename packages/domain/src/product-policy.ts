// M7's capabilities and what counts as a privileged action (ADR-031 D3, D8). Default-deny, pure, and never
// asks a model. Its own file for now because other milestones are adding to policy.ts at the same time.
import { isRole } from './policy';

export type ProductCapability =
  /** Write agent and process drafts, and run simulations of them. */
  | 'studio.author'
  /** Decide a review someone else asked for. */
  | 'studio.review'
  /** Publish what a review approved, and start a catalog process. */
  | 'studio.publish'
  | 'object_type.manage'
  | 'object_record.write'
  | 'pack.manage'
  | 'onboarding.manage'
  | 'security_policy.manage'
  | 'sso.manage';

const GRANTS: Record<'owner' | 'admin' | 'member', ReadonlySet<ProductCapability>> = {
  owner: new Set([
    'studio.author',
    'studio.review',
    'studio.publish',
    'object_type.manage',
    'object_record.write',
    'pack.manage',
    'onboarding.manage',
    'security_policy.manage',
    'sso.manage',
  ]),
  admin: new Set([
    'studio.author',
    'studio.review',
    'studio.publish',
    'object_type.manage',
    'object_record.write',
    'pack.manage',
    'onboarding.manage',
    'sso.manage',
  ]),
  member: new Set(['object_record.write']),
};

export function canProduct(role: string, capability: ProductCapability): boolean {
  return isRole(role) && GRANTS[role].has(capability);
}

/**
 * What needs recent MFA. `always` is everything new in M7, plus M4's publish and activate routes once the
 * merge connects them. `administration` is M2's administrative actions, and it applies only when a tenant
 * has turned on `mfa_for_administration`, so an install that is running today is not locked out by an
 * upgrade (ADR-031 D8).
 */
export const PRIVILEGED_ACTIONS = {
  'studio.publish': 'always',
  'studio.review_decision': 'always',
  'pack.activate': 'always',
  'pack.rollback': 'always',
  'object_type.lower_scope': 'always',
  'sso.manage': 'always',
  'scim_token.issue': 'always',
  'security_policy.change': 'always',
  'agent.publish': 'always',
  'model_profile.activate': 'always',
  /** Explicit bounded company-data egress and paid model usage authority. */
  'model_workload.approve': 'always',
  'member.manage': 'administration',
  'organization.manage': 'administration',
  'connection.manage': 'administration',
} as const;
export type PrivilegedAction = keyof typeof PRIVILEGED_ACTIONS;

/**
 * How recent is recent, in seconds, when a tenant has not said. A starting value and not a measurement,
 * and a tenant can change it within the bounds the table allows.
 */
export const DEFAULT_MFA_MAX_AGE_SECONDS = 900;
export const MIN_MFA_MAX_AGE_SECONDS = 60;
export const MAX_MFA_MAX_AGE_SECONDS = 3600;

export type MfaFacts = {
  /** The newest thing this session has proven with a second factor, or null. */
  verifiedAt: Date | null;
  maxAgeSeconds: number;
  mfaForAdministration: boolean;
  /** M4 adds `agent`. Anything but a person is refused, so a new kind cannot slip through. */
  actorType: string;
};

export type MfaDecision = 'allow' | 'require_mfa' | 'deny_service';

/**
 * A worker or an agent can never pass this: there is nobody there to hold a second factor, so an action
 * that asks for one is a person's. A date in the future does not count, because a clock moved forward
 * must not make a stale proof last for ever.
 */
export function mfaDecision(action: PrivilegedAction, facts: MfaFacts, now: Date): MfaDecision {
  if (facts.actorType !== 'user') return 'deny_service';
  if (PRIVILEGED_ACTIONS[action] === 'administration' && !facts.mfaForAdministration) {
    return 'allow';
  }
  if (!facts.verifiedAt) return 'require_mfa';
  const age = now.getTime() - facts.verifiedAt.getTime();
  if (age < 0 || age > facts.maxAgeSeconds * 1000) return 'require_mfa';
  return 'allow';
}

/** Who can read a custom record. The same rule as a Work Unit, with its owner as the person involved. */
export function canReadRecord(
  record: { classification: string; ownerMembershipId: string },
  viewer: { membershipId: string; role: string },
): boolean {
  if (!isRole(viewer.role)) return false;
  const mine = record.ownerMembershipId === viewer.membershipId;
  switch (record.classification) {
    case 'public':
    case 'internal':
      return true;
    case 'confidential':
      return mine || viewer.role === 'owner' || viewer.role === 'admin';
    case 'restricted':
      return mine;
    default:
      return false;
  }
}

/** Who can change one. Reading it is not enough. */
export function canChangeRecord(
  record: { classification: string; ownerMembershipId: string },
  viewer: { membershipId: string; role: string },
): boolean {
  if (!canReadRecord(record, viewer)) return false;
  if (!canProduct(viewer.role, 'object_record.write')) return false;
  return (
    record.ownerMembershipId === viewer.membershipId ||
    viewer.role === 'owner' ||
    viewer.role === 'admin'
  );
}
