// Skill package rules (ADR-034 D1 to D4). Pure: no framework, database or SDK. The state table is repeated
// in migration 0651, because the web tier and the workers share a role, and a test holds the two together.

export const SKILL_VERSION_STATES = [
  'uploaded',
  'verifying',
  'verified',
  'rejected',
  'published',
  'yanked',
] as const;
export type SkillVersionState = (typeof SKILL_VERSION_STATES)[number];

/**
 * Nothing goes back. A version number means one thing for good, so fixing a published version is a new
 * version, and a rejected upload is uploaded again rather than revived.
 */
export const SKILL_VERSION_TRANSITIONS: Record<SkillVersionState, readonly SkillVersionState[]> = {
  uploaded: ['verifying', 'rejected'],
  verifying: ['verified', 'rejected'],
  verified: ['published', 'yanked'],
  published: ['yanked'],
  rejected: [],
  yanked: [],
};

export function canTransitionSkillVersion(from: SkillVersionState, to: SkillVersionState): boolean {
  return SKILL_VERSION_TRANSITIONS[from].includes(to);
}

export const SKILL_PACKAGE_STATES = ['active', 'disabled'] as const;
export type SkillPackageState = (typeof SKILL_PACKAGE_STATES)[number];

export const SKILL_ORIGINS = ['tenant', 'marketplace'] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

export const SKILL_EXECUTION_KINDS = ['declarative', 'sandbox'] as const;
export type SkillExecutionKind = (typeof SKILL_EXECUTION_KINDS)[number];

export const TRUSTED_SIGNER_STATES = ['active', 'revoked'] as const;
export type TrustedSignerState = (typeof TRUSTED_SIGNER_STATES)[number];

export const SKILL_TEST_MODES = ['contract', 'sandbox'] as const;
export type SkillTestMode = (typeof SKILL_TEST_MODES)[number];

export const SKILL_TEST_OUTCOMES = ['passed', 'failed', 'error'] as const;
export type SkillTestOutcome = (typeof SKILL_TEST_OUTCOMES)[number];

/** Why a bundle was refused. Fixed codes, so nothing from a stranger's bundle is ever stored as text. */
export const SKILL_REJECT_CODES = [
  'BUNDLE_MALFORMED',
  'BUNDLE_TOO_LARGE',
  'BUNDLE_HASH_MISMATCH',
  'BUNDLE_UNAVAILABLE',
  'MANIFEST_INVALID',
  'NAME_MISMATCH',
  'VERSION_TAKEN',
  'PATH_UNSAFE',
  'FILE_DUPLICATED',
  'FILE_UNDECLARED',
  'FILE_MISSING',
  'FILE_HASH_MISMATCH',
  'FILE_SIZE_MISMATCH',
  'DIGEST_MISMATCH',
  'SIGNATURE_INVALID',
  'SIGNER_UNTRUSTED',
  'SIGNER_REVOKED',
  'LISTING_NOT_AVAILABLE',
  'ATTESTATION_INVALID',
  'LICENSE_NOT_ALLOWED',
  'DEPENDENCY_NOT_ALLOWED',
  'SCHEMA_NOT_SUPPORTED',
  'LIMITS_OVER_CEILING',
  'NETWORK_NOT_ALLOWED',
  'RUNTIME_NOT_SUPPORTED',
  'FIXTURE_INVALID',
  'TESTS_FAILED',
  'SANDBOX_UNAVAILABLE',
  'VERIFICATION_ERROR',
] as const;
export type SkillRejectCode = (typeof SKILL_REJECT_CODES)[number];

export const SKILL_YANK_CODES = [
  'WITHDRAWN_BY_OWNER',
  'SECURITY_ISSUE',
  'SIGNER_REVOKED',
  'LISTING_REVOKED',
] as const;
export type SkillYankCode = (typeof SKILL_YANK_CODES)[number];

/** Whether a version can do anything for someone right now, and if not, why. */
export const SKILL_USE_DENIALS = [
  'NOT_PUBLISHED',
  'PACKAGE_DISABLED',
  'SIGNER_REVOKED',
  'LISTING_REVOKED',
] as const;
export type SkillUseDenial = (typeof SKILL_USE_DENIALS)[number];

/**
 * Bytes are bounded before anyone parses them, so a huge bundle costs no more than a small one. The
 * database checks the same limit, and the web tier counts as it reads.
 */
export const SKILL_BUNDLE_MAX_BYTES = 8_388_608;
export const SKILL_BUNDLE_MAX_FILES = 500;
export const SKILL_MAX_FIXTURES = 50;
export const SKILL_BUNDLE_MEDIA_TYPE = 'application/vnd.ensemus.skill-bundle+json';

/** A bundle's bytes start with the tenant and hold no names, like any other object key. */
export const skillBundleObjectKey = (organizationId: string, skillVersionId: string) =>
  `${organizationId}/skills/${skillVersionId}`;

export type Semver = { major: number; minor: number; patch: number };

const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/** Release versions only. A prerelease tag would give a version two orderings, and nothing needs it. */
export function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** What decides whether a version may be used, in one place, read fresh before every use. */
export type SkillUseFacts = {
  state: SkillVersionState;
  packageState: SkillPackageState;
  origin: SkillOrigin;
  /** The tenant's own signer row, for a tenant package. */
  signerState: TrustedSignerState | null;
  /** The listing's revocation, for a marketplace copy. */
  listingDelistMode: 'stop_new' | 'revoke' | null;
};

/** Default deny, and a marketplace copy stays usable after `stop_new`, which only stops new installs. */
export function skillUseDenial(facts: SkillUseFacts): SkillUseDenial | null {
  if (facts.state !== 'published') return 'NOT_PUBLISHED';
  if (facts.packageState !== 'active') return 'PACKAGE_DISABLED';
  if (facts.origin === 'tenant' && facts.signerState !== 'active') return 'SIGNER_REVOKED';
  if (facts.origin === 'marketplace' && facts.listingDelistMode === 'revoke') {
    return 'LISTING_REVOKED';
  }
  return null;
}

/**
 * The licences a package may declare, for itself and for anything it vendors. Deliberately the same short
 * list check-licenses.mjs allows without a named exception. Copyleft and unknown licences are refused
 * here, because Sovereign redistributes, and a reviewer should not have to catch it. The last is a tenant's
 * way of saying a package is its own and goes nowhere, and marketplace review refuses it.
 */
export const SKILL_ALLOWED_LICENSES = [
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'LicenseRef-Proprietary-Tenant',
] as const;
export type SkillLicense = (typeof SKILL_ALLOWED_LICENSES)[number];
