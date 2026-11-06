// Owned by the skill-verification slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D1, D2.
// What a worker writes as it checks a bundle. Called under a service context, on an ID from the outbox, so
// RLS still confines every query to that tenant. Nothing here touches bytes: the Activity reads and checks
// them with @ensemus/skills, and hands over only what it found.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { SandboxPolicy } from '@ensemus/domain/sandbox';
import type {
  SkillExecutionKind,
  SkillOrigin,
  SkillRejectCode,
  SkillTestMode,
  SkillTestOutcome,
  SkillVersionState,
} from '@ensemus/domain/skill';

/** Everything a worker needs to check one version, read under the tenant. */
export type VerificationSubject = {
  skillVersionId: string;
  packageId: string;
  packageName: string;
  origin: SkillOrigin;
  state: SkillVersionState;
  bundleObjectKey: string;
  bundleSha256: string;
  sizeBytes: number;
  /** The keys this tenant trusts, for a tenant package. Empty for a marketplace copy. */
  trustedSigners: ReadonlyArray<{ keyId: string; publicKey: Buffer; state: 'active' | 'revoked' }>;
  /** What the listing attests, for a marketplace copy. Null for a tenant package. */
  listing: {
    id: string;
    digest: string;
    signerKeyId: string;
    signerPublicKey: Buffer;
    signature: Buffer;
    delistMode: 'stop_new' | 'revoke' | null;
    /** The signed review, to check again here. Trusting the row alone would trust the database. */
    attestation: unknown;
    reviewerKeyId: string;
    attestationSignature: Buffer;
  } | null;
};

/**
 * Moves `uploaded` to `verifying` and reads the subject. A retry finds it already `verifying` and reads it
 * again. Null when the version has reached a later state, which means another run finished the job.
 */
export function beginSkillVerification(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { skillVersionId: string },
): Promise<VerificationSubject | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Ends it with a fixed code, and tells the uploader. Safe to repeat. */
export function rejectSkillVersion(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { skillVersionId: string; code: SkillRejectCode },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** What a worker found in a bundle that checked out, ready to be written once. */
export type CheckedBundleFacts = {
  semver: string;
  digest: string;
  manifest: unknown;
  executionKind: SkillExecutionKind;
  license: string;
  maxClassification: 'public' | 'internal' | 'confidential';
  signerKeyId: string;
  signature: Buffer;
};

export type SkillTestRunInput = {
  skillVersionId: string;
  digest: string;
  mode: SkillTestMode;
  outcome: SkillTestOutcome;
  fixturesTotal: number;
  fixturesPassed: number;
  firstFailedFixture: number | null;
  code: SkillRejectCode | null;
  startedAt: Date;
};

/** Appends one result. The table never changes a result, so a later pass is another row. */
export function recordSkillTestRun(
  _database: AppDatabase,
  _context: TenantContext,
  _input: SkillTestRunInput,
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Moves `verifying` to `verified`, writing `facts`, and tells the uploader. The trigger refuses it without
 * a passed test of this digest, or a signer the tenant still trusts, which answers with the reject code
 * instead, so a revoke during verification still ends in `rejected`.
 */
export function markSkillVersionVerified(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { skillVersionId: string; facts: CheckedBundleFacts },
): Promise<'verified' | 'rejected'> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Writes one queued sandbox run per fixture, purpose `skill_test`, each with the fixture's input and the
 * compiled policy. Idempotent by version and position, so a retried Activity finds the same runs. Returns
 * their IDs in fixture order. Classification is `internal`: a fixture is the publisher's own test data.
 */
export function createFixtureRuns(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    skillVersionId: string;
    digest: string;
    policy: SandboxPolicy;
    policyHash: string;
    fixtures: ReadonlyArray<{ position: number; input: unknown }>;
  },
): Promise<readonly string[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/** The settled result of each fixture's run, in fixture order. Output stays in PostgreSQL. */
export function loadFixtureRunResults(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { skillVersionId: string },
): Promise<
  ReadonlyArray<{ position: number; sandboxRunId: string; status: string; output: unknown }>
> {
  throw new Error('NOT_IMPLEMENTED');
}
