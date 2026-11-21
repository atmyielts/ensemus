// Owned by the skill-catalog slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D1, D2, D4.
// Managing skills needs skill.manage, publishing needs skill.publish, and reading needs only membership.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type {
  SkillExecutionKind,
  SkillOrigin,
  SkillPackageState,
  SkillTestMode,
  SkillTestOutcome,
  SkillUseDenial,
  SkillVersionState,
  SkillYankCode,
  TrustedSignerState,
} from '@ensemus/domain/skill';
import type { ObjectStore } from './artifacts';
import type { SkillFeatureGate } from './skill-ports';

export type SkillSignerView = {
  id: string;
  displayName: string;
  keyId: string;
  state: TrustedSignerState;
  version: number;
  createdAt: Date;
  revokedAt: Date | null;
};

export type SkillPackageView = {
  id: string;
  name: string;
  displayName: string;
  origin: SkillOrigin;
  listingId: string | null;
  state: SkillPackageState;
  contentClassification: 'public' | 'internal' | 'confidential' | 'restricted';
  version: number;
  createdAt: Date;
};

export type SkillTestResultView = {
  mode: SkillTestMode;
  outcome: SkillTestOutcome;
  fixturesTotal: number;
  fixturesPassed: number;
  firstFailedFixture: number | null;
  code: string | null;
  finishedAt: Date;
};

export type SkillVersionView = {
  id: string;
  packageId: string;
  state: SkillVersionState;
  bundleSha256: string;
  sizeBytes: number;
  semver: string | null;
  digest: string | null;
  executionKind: SkillExecutionKind | null;
  license: string | null;
  maxClassification: 'public' | 'internal' | 'confidential' | null;
  signerKeyId: string | null;
  /** From the manifest, so a person can see what it could ask for. Declaring a tool grants nothing. */
  toolBoundaries: readonly string[];
  rejectCode: string | null;
  yankCode: string | null;
  latestTest: SkillTestResultView | null;
  uploadedAt: Date;
  publishedAt: Date | null;
  version: number;
};

export type SkillPackagePage = { items: readonly SkillPackageView[]; nextCursor: string | null };

/** Stores a key's public half. Refuses anything that is not 32 bytes, and a key already on file. */
export function addTrustedSigner(
  _database: AppDatabase,
  _context: TenantContext,
  _gate: SkillFeatureGate,
  _input: { displayName: string; publicKey: Buffer },
): Promise<SkillSignerView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listTrustedSigners(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly SkillSignerView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * For good, in one transaction with yanking every unyanked tenant-origin version it signed, code
 * SIGNER_REVOKED. A marketplace copy is the operator's to revoke, through its listing, so it stays.
 */
export function revokeTrustedSigner(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { signerId: string; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export function createSkillPackage(
  _database: AppDatabase,
  _context: TenantContext,
  _gate: SkillFeatureGate,
  _input: {
    name: string;
    displayName: string;
    contentClassification?: SkillPackageView['contentClassification'];
  },
): Promise<SkillPackageView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listSkillPackages(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { after?: string; limit?: number },
): Promise<SkillPackagePage> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getSkillPackage(
  _database: AppDatabase,
  _context: TenantContext,
  _packageId: string,
): Promise<SkillPackageView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * A marketplace copy's classification cannot be changed here, because its content is not this tenant's.
 * Disabling takes effect at once, because every use rereads the row.
 */
export function updateSkillPackage(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    packageId: string;
    expectedVersion: number;
    displayName?: string;
    state?: SkillPackageState;
    contentClassification?: SkillPackageView['contentClassification'];
  },
): Promise<SkillPackageView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The web tier's whole job with a bundle: count it, hash it, store it, write the row and the event. It parses
 * nothing and believes nothing (ADR-034 D2). Bytes over the limit are refused with SKILL_BUNDLE_TOO_LARGE. The
 * same bytes sent again find the same row, and store nothing twice. Follows addArtifact's order, with the
 * version's ID as the blob's: a `blob_lifecycle` row marked `uploading` first, then the bytes, then the version
 * row, the event and removing the marker in one transaction. So no row ever names bytes that are not there, and
 * a crash leaves bytes the existing upkeep sweep already removes.
 */
export function uploadSkillBundle(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _gate: SkillFeatureGate,
  _input: { packageId: string; bytes: Buffer },
): Promise<SkillVersionView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listSkillVersions(
  _database: AppDatabase,
  _context: TenantContext,
  _packageId: string,
): Promise<readonly SkillVersionView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getSkillVersion(
  _database: AppDatabase,
  _context: TenantContext,
  _skillVersionId: string,
): Promise<SkillVersionView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * A person's decision, so a service context is refused. Someone other than the uploader has to do it
 * (SKILL_PUBLISH_SAME_PERSON), and the table holds that too. A version that lost its signer or tests
 * since it was verified is refused by the trigger, and answers SKILL_VERSION_NOT_PUBLISHABLE.
 */
export function publishSkillVersion(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { skillVersionId: string; expectedVersion: number },
): Promise<SkillVersionView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function yankSkillVersion(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    skillVersionId: string;
    expectedVersion: number;
    code: Extract<SkillYankCode, 'WITHDRAWN_BY_OWNER' | 'SECURITY_ISSUE'>;
  },
): Promise<SkillVersionView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** What M4's agent runtime and the sandbox slice read before any use. Pinned by ID, never by "latest". */
export type UsableSkillVersion = {
  ok: true;
  skillVersionId: string;
  packageId: string;
  name: string;
  semver: string;
  digest: string;
  executionKind: SkillExecutionKind;
  maxClassification: 'public' | 'internal' | 'confidential';
  /** The manifest as verified. Prompt text in it is lower-trust content, and is treated as data. */
  manifest: unknown;
  bundleObjectKey: string;
  bundleSha256: string;
  signerKeyId: string;
  signature: Buffer;
};

/**
 * The one answer to "may this version be used now". Reads the version, package, signer and listing in one
 * transaction, and puts them through skillUseDenial. Called fresh before every use, so a revoke or a yank
 * takes effect for anything not already past this point (ADR-034 D1). A version in another tenant is
 * NOT_PUBLISHED, the same as one that does not exist.
 */
export function resolveSkillVersionForUse(
  _database: AppDatabase,
  _context: TenantContext,
  _skillVersionId: string,
): Promise<UsableSkillVersion | { ok: false; denial: SkillUseDenial }> {
  throw new Error('NOT_IMPLEMENTED');
}
