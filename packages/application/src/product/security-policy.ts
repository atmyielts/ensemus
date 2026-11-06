// Owned by the mfa slice (ID-05). See docs/06-delivery/m7-slices.md and ADR-031 D8.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { SessionProof } from './privileged';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type SecurityPolicyView = {
  mfaForAdministration: boolean;
  mfaMaxAgeSeconds: number;
  ssoEnforcement: 'optional' | 'required';
  version: number;
};

export type MemberSecondFactor = { membershipId: string; name: string; enrolled: boolean };

/** Anyone in the tenant may read it, because it decides what they will be asked for. */
export async function getSecurityPolicy(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<SecurityPolicyView> {
  throw NOT_BUILT();
}

/** Needs `security_policy.manage` and recent MFA. Tightening and loosening are both audited. */
export async function updateSecurityPolicy(
  _database: AppDatabase,
  _context: TenantContext,
  _proof: SessionProof | null,
  _input: {
    expectedVersion: number;
    mfaForAdministration: boolean;
    mfaMaxAgeSeconds: number;
    ssoEnforcement: 'optional' | 'required';
  },
): Promise<SecurityPolicyView> {
  throw NOT_BUILT();
}

/** Needs `member.manage`. Whether each person has enrolled, and nothing about their secret. */
export async function listMemberSecondFactors(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly MemberSecondFactor[]> {
  throw NOT_BUILT();
}
