import {
  addTrustedSigner as addSigner,
  listTrustedSigners as listSigners,
  revokeTrustedSigner as revokeSigner,
} from './skill-signers';
export {
  createSkillPackage,
  getSkillPackage,
  listSkillPackages,
  updateSkillPackage,
} from './skill-packages';
export { listSkillVersions, getSkillVersion, getSkillVersionReview } from './skill-version-reads';
export { uploadSkillBundle } from './skill-bundle-upload';
export { publishSkillVersion, yankSkillVersion, resolveSkillVersionForUse } from './skill-release';
// Owned by the skill-catalog slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D1, D2, D4.
// Managing skills needs skill.manage, publishing needs skill.publish, and reading needs only membership.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type {
  SkillExecutionKind,
  SkillOrigin,
  SkillPackageState,
  SkillTestMode,
  SkillTestOutcome,
  SkillVersionState,
  TrustedSignerState,
} from '@ensemus/domain/skill';
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
  database: AppDatabase,
  context: TenantContext,
  gate: SkillFeatureGate,
  input: { displayName: string; publicKey: Buffer },
): Promise<SkillSignerView> {
  return addSigner(database, context, gate, input);
}

export function listTrustedSigners(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly SkillSignerView[]> {
  return listSigners(database, context);
}

/**
 * For good, in one transaction with yanking every unyanked tenant-origin version it signed, code
 * SIGNER_REVOKED. A marketplace copy is the operator's to revoke, through its listing, so it stays.
 */
export function revokeTrustedSigner(
  database: AppDatabase,
  context: TenantContext,
  input: { signerId: string; expectedVersion: number },
): Promise<void> {
  return revokeSigner(database, context, input);
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
