// Owned by the skill-verification slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D1, D2.
// What a worker writes as it checks a bundle. Called under a service context, on an ID from the outbox, so
// RLS still confines every query to that tenant. Nothing here touches bytes: the Activity reads and checks
// them with @ensemus/skills, and hands over only what it found.
import {
  skillPackages,
  skillTestRuns,
  skillVersions,
  trustedSigners,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { SandboxPolicy } from '@ensemus/domain/sandbox';
import { SKILL_REJECT_CODES } from '@ensemus/domain/skill';
import type {
  SkillExecutionKind,
  SkillOrigin,
  SkillRejectCode,
  SkillTestMode,
  SkillTestOutcome,
  SkillVersionState,
} from '@ensemus/domain/skill';
import {
  AGGREGATE_SKILL_VERSION,
  NOTIFY_SKILL_VERSION_REJECTED,
  NOTIFY_SKILL_VERSION_VERIFIED,
  SKILL_VERSION_REJECTED,
  SKILL_VERSION_VERIFIED,
  skillVersionTargetRef,
} from '@ensemus/domain/skill-events';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { SKILL_SQLSTATE } from './skill-ports';
import { auditAction, notify } from './work';

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

const forVersion = (context: TenantContext, id: string) =>
  and(eq(skillVersions.organizationId, context.organizationId), eq(skillVersions.id, id));

async function verificationTx<T>(
  database: AppDatabase,
  context: TenantContext,
  skillVersionId: string,
  run: (tx: Tx, id: string) => Promise<T>,
): Promise<T> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const id = idSchema.safeParse(skillVersionId);
  if (!id.success) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const login = await tx.execute<{ allowed: boolean }>(
      sql`select session_user = 'ensemus_worker' and current_user = session_user as allowed`,
    );
    if (login.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
    // This lock precedes version row locks and is also taken during signer revocation.
    await tx.execute(sql`select skills.lock_trust()`);
    return run(tx, id.data);
  });
}

type VersionRow = typeof skillVersions.$inferSelect;
const settledOutcome = (row: Pick<VersionRow, 'state'>) =>
  row.state === 'verified' || row.state === 'published' ? 'verified' : 'rejected';

async function announceSettlement(
  tx: Tx,
  context: TenantContext,
  row: VersionRow,
  verified: boolean,
) {
  const eventType = verified ? SKILL_VERSION_VERIFIED : SKILL_VERSION_REJECTED;
  const target = skillVersionTargetRef(row.id);
  await auditAction(tx, context, eventType, target);
  await emit(tx, context, {
    eventType,
    aggregateType: AGGREGATE_SKILL_VERSION,
    aggregateId: row.id,
    aggregateVersion: row.version,
    classification: 'internal',
    payload: { skill_version_id: row.id },
  });
  if (row.uploadedByMembershipId)
    await notify(
      tx,
      context,
      [row.uploadedByMembershipId],
      verified ? NOTIFY_SKILL_VERSION_VERIFIED : NOTIFY_SKILL_VERSION_REJECTED,
      target,
    );
}

async function rejectInTx(tx: Tx, context: TenantContext, id: string, code: SkillRejectCode) {
  const [row] = await tx
    .update(skillVersions)
    .set({
      state: 'rejected',
      rejectCode: code,
      version: sql`${skillVersions.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(forVersion(context, id), sql`${skillVersions.state} in ('uploaded','verifying')`))
    .returning();
  if (row) await announceSettlement(tx, context, row, false);
}

/**
 * Moves `uploaded` to `verifying` and reads the subject. A retry finds it already `verifying` and reads it
 * again. Null when the version has reached a later state, which means another run finished the job.
 */
export async function beginSkillVerification(
  database: AppDatabase,
  context: TenantContext,
  input: { skillVersionId: string },
): Promise<VerificationSubject | null> {
  return verificationTx(database, context, input.skillVersionId, async (tx, id) => {
    const [row] = await tx
      .select({
        version: skillVersions,
        packageName: skillPackages.name,
        origin: skillPackages.origin,
      })
      .from(skillVersions)
      .innerJoin(
        skillPackages,
        and(
          eq(skillPackages.organizationId, skillVersions.organizationId),
          eq(skillPackages.id, skillVersions.packageId),
        ),
      )
      .where(forVersion(context, id));
    if (!row || (row.version.state !== 'uploaded' && row.version.state !== 'verifying'))
      return null;
    if (row.version.state === 'uploaded')
      await tx
        .update(skillVersions)
        .set({
          state: 'verifying',
          version: row.version.version + 1,
          updatedAt: sql`now()`,
        })
        .where(forVersion(context, id));
    const signers =
      row.origin === 'tenant'
        ? await tx
            .select({
              keyId: trustedSigners.keyId,
              publicKey: trustedSigners.publicKey,
              state: trustedSigners.state,
            })
            .from(trustedSigners)
            .where(eq(trustedSigners.organizationId, context.organizationId))
        : [];
    return {
      skillVersionId: id,
      packageId: row.version.packageId,
      packageName: row.packageName,
      origin: row.origin as SkillOrigin,
      state: 'verifying',
      bundleObjectKey: row.version.bundleObjectKey,
      bundleSha256: row.version.bundleSha256,
      sizeBytes: row.version.sizeBytes,
      trustedSigners: signers.map((signer) => ({
        ...signer,
        state: signer.state === 'active' ? 'active' : 'revoked',
      })),
      // Global review admission will be supplied with marketplace installation.
      listing: null,
    };
  });
}

/** Ends it with a fixed code, and tells the uploader. Safe to repeat. */
export async function rejectSkillVersion(
  database: AppDatabase,
  context: TenantContext,
  input: { skillVersionId: string; code: SkillRejectCode },
): Promise<void> {
  if (!SKILL_REJECT_CODES.includes(input.code)) throw new AppError('INVALID_INPUT');
  await verificationTx(database, context, input.skillVersionId, (tx, id) =>
    rejectInTx(tx, context, id, input.code),
  );
}

/** A lost activity response after commit reports exactly the outcome already recorded. */
export async function skillVerificationOutcome(
  database: AppDatabase,
  context: TenantContext,
  skillVersionId: string,
): Promise<'verified' | 'rejected'> {
  return verificationTx(database, context, skillVersionId, async (tx, id) => {
    const [row] = await tx
      .select({ state: skillVersions.state })
      .from(skillVersions)
      .where(forVersion(context, id));
    return row ? settledOutcome(row) : 'rejected';
  });
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
export async function recordSkillTestRun(
  database: AppDatabase,
  context: TenantContext,
  input: SkillTestRunInput,
): Promise<void> {
  await verificationTx(database, context, input.skillVersionId, async (tx, id) => {
    const [row] = await tx
      .select({ state: skillVersions.state })
      .from(skillVersions)
      .where(forVersion(context, id));
    if (row?.state !== 'verifying') return;
    const [prior] = await tx
      .select({ id: skillTestRuns.id })
      .from(skillTestRuns)
      .where(
        and(
          eq(skillTestRuns.organizationId, context.organizationId),
          eq(skillTestRuns.skillVersionId, id),
          eq(skillTestRuns.digest, input.digest),
          eq(skillTestRuns.mode, input.mode),
          eq(skillTestRuns.outcome, input.outcome),
          eq(skillTestRuns.fixturesTotal, input.fixturesTotal),
          eq(skillTestRuns.fixturesPassed, input.fixturesPassed),
          sql`${skillTestRuns.firstFailedFixture} is not distinct from ${input.firstFailedFixture}::integer`,
          sql`${skillTestRuns.code} is not distinct from ${input.code}::text`,
        ),
      )
      .limit(1);
    if (prior) return;
    await tx
      .insert(skillTestRuns)
      .values({ ...input, skillVersionId: id, organizationId: context.organizationId });
  });
}

/**
 * Moves `verifying` to `verified`, writing `facts`, and tells the uploader. The trigger refuses it without
 * a passed test of this digest, or a signer the tenant still trusts, which answers with the reject code
 * instead, so a revoke during verification still ends in `rejected`.
 */
export async function markSkillVersionVerified(
  database: AppDatabase,
  context: TenantContext,
  input: { skillVersionId: string; facts: CheckedBundleFacts },
): Promise<'verified' | 'rejected'> {
  try {
    return await verificationTx(database, context, input.skillVersionId, async (tx, id) => {
      const [current] = await tx
        .select({
          state: skillVersions.state,
          origin: skillPackages.origin,
        })
        .from(skillVersions)
        .innerJoin(
          skillPackages,
          and(
            eq(skillPackages.organizationId, skillVersions.organizationId),
            eq(skillPackages.id, skillVersions.packageId),
          ),
        )
        .where(forVersion(context, id));
      if (!current || current.state !== 'verifying')
        return current ? settledOutcome(current) : 'rejected';
      if (current.origin !== 'tenant') {
        await rejectInTx(tx, context, id, 'LISTING_NOT_AVAILABLE');
        return 'rejected';
      }
      const [signer] = await tx
        .select({ state: trustedSigners.state })
        .from(trustedSigners)
        .where(
          and(
            eq(trustedSigners.organizationId, context.organizationId),
            eq(trustedSigners.keyId, input.facts.signerKeyId),
          ),
        );
      if (signer?.state !== 'active') {
        await rejectInTx(tx, context, id, signer ? 'SIGNER_REVOKED' : 'SIGNER_UNTRUSTED');
        return 'rejected';
      }
      const [row] = await tx
        .update(skillVersions)
        .set({
          ...input.facts,
          state: 'verified',
          verifiedAt: sql`now()`,
          updatedAt: sql`now()`,
          version: sql`${skillVersions.version} + 1`,
        })
        .where(forVersion(context, id))
        .returning();
      if (!row) throw new AppError('VERSION_CONFLICT');
      await announceSettlement(tx, context, row, true);
      return 'verified';
    });
  } catch (error) {
    const code = pgCode(error);
    if (code !== '23505' && code !== SKILL_SQLSTATE.NOT_USABLE) throw error;
    await rejectSkillVersion(database, context, {
      skillVersionId: input.skillVersionId,
      code: code === '23505' ? 'VERSION_TAKEN' : 'VERIFICATION_ERROR',
    });
    return skillVerificationOutcome(database, context, input.skillVersionId);
  }
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
