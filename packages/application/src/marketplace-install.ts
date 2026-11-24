// Owned by the marketplace-install slice (EXP-06). See docs/06-delivery/m11b-slices.md and ADR-034 D6, D7.
// A tenant's side of taking a listing. Installing copies bytes and grants nothing (AGENT-14's rule), and the
// copy goes through the same verification as an upload, and someone here still has to publish it.
import { createHash } from 'node:crypto';
import {
  marketplaceInstallations,
  marketplaceListingObjectReservations,
  marketplaceListings,
  marketplaceReviews,
  skillBundleUploads,
  skillPackages,
  skillVersions,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { can } from '@ensemus/domain/policy';
import { SKILL_BUNDLE_MEDIA_TYPE, skillBundleObjectKey } from '@ensemus/domain/skill';
import {
  AGGREGATE_MARKETPLACE_INSTALLATION,
  MARKETPLACE_INSTALLED,
  MARKETPLACE_INSTALL_FAILED,
  MARKETPLACE_INSTALL_REQUESTED,
  MARKETPLACE_REMOVED,
  NOTIFY_MARKETPLACE_INSTALL_FAILED,
} from '@ensemus/domain/skill-events';
import type {
  DelistMode,
  InstallationFailureCode,
  InstallationState,
  ListingState,
} from '@ensemus/domain/marketplace';
import type { ObjectStore } from './artifacts';
import { AppError, pgCode } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { withPrivilegeTx } from './product/privileged';
import { requireSkillMember } from './skill-access';
import { SKILL_SQLSTATE, type SkillFeatureGate } from './skill-ports';
import { yankSkillVersionInTx } from './skill-release';
import { auditAction, notify } from './work';

export type ListingView = {
  id: string;
  publisherDisplayName: string;
  name: string;
  semver: string;
  displayName: string;
  summary: string;
  digest: string;
  license: string;
  executionKind: 'declarative' | 'sandbox';
  maxClassification: 'public' | 'internal' | 'confidential';
  toolBoundaries: readonly string[];
  signerKeyId: string;
  reviewerKeyId: string;
  state: ListingState;
  delistMode: DelistMode | null;
  listedAt: Date;
};

export type ListingPage = { items: readonly ListingView[]; nextCursor: string | null };

export type InstallationView = {
  id: string;
  listingId: string;
  state: InstallationState;
  packageId: string | null;
  skillVersionId: string | null;
  failureCode: InstallationFailureCode | null;
  createdAt: Date;
  version: number;
};

const listings = marketplaceListings;
const listingFields = {
  id: listings.id,
  publisherDisplayName: listings.publisherDisplayName,
  name: listings.name,
  semver: listings.semver,
  displayName: listings.displayName,
  summary: listings.summary,
  digest: listings.digest,
  license: listings.license,
  executionKind: listings.executionKind,
  maxClassification: listings.maxClassification,
  toolBoundaries: sql<unknown>`${listings.manifest}->'tool_boundaries'`,
  signerKeyId: listings.signerKeyId,
  reviewerKeyId: listings.reviewerKeyId,
  state: listings.state,
  delistMode: listings.delistMode,
  listedAt: listings.listedAt,
};

function listingView(
  row: Omit<
    ListingView,
    'executionKind' | 'maxClassification' | 'toolBoundaries' | 'state' | 'delistMode'
  > & {
    executionKind: string;
    maxClassification: string;
    toolBoundaries: unknown;
    state: string;
    delistMode: string | null;
  },
): ListingView {
  if (
    !Array.isArray(row.toolBoundaries) ||
    !row.toolBoundaries.every((value: unknown) => typeof value === 'string')
  )
    throw new AppError('INVALID_STATE');
  return {
    ...row,
    toolBoundaries: row.toolBoundaries as string[],
    executionKind: row.executionKind as ListingView['executionKind'],
    maxClassification: row.maxClassification as ListingView['maxClassification'],
    state: row.state as ListingState,
    delistMode: row.delistMode as DelistMode | null,
  };
}

const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64url');

function listingCursor(value: string) {
  if (value.length !== 48) throw new AppError('INVALID_INPUT');
  const parsed = idSchema.safeParse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!parsed.success || encodeCursor(parsed.data) !== value) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

/** Browse what is currently offered. Delisted listings can be opened only where native RLS allows them. */
export async function listListings(
  database: AppDatabase,
  context: TenantContext,
  gate: SkillFeatureGate,
  input: { after?: string; limit?: number },
): Promise<ListingPage> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('INVALID_INPUT');
  const after = input.after === undefined ? undefined : listingCursor(input.after);
  if (!(await gate.isEnabled(context, 'marketplace'))) return { items: [], nextCursor: null };
  return withTenantTx(database, context, async (tx) => {
    await requireSkillMember(tx, context);
    const rows = await tx
      .select(listingFields)
      .from(listings)
      .where(
        and(eq(listings.state, 'listed'), after === undefined ? undefined : gt(listings.id, after)),
      )
      .orderBy(asc(listings.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(listingView);
    return {
      items,
      nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.id) : null,
    };
  });
}

export async function getListing(
  database: AppDatabase,
  context: TenantContext,
  gate: SkillFeatureGate,
  listingId: string,
): Promise<ListingView> {
  const target = idSchema.safeParse(listingId);
  if (!target.success) throw new AppError('INVALID_INPUT');
  if (!(await gate.isEnabled(context, 'marketplace'))) throw new AppError('FEATURE_NOT_ENABLED');
  return withTenantTx(database, context, async (tx) => {
    await requireSkillMember(tx, context);
    const [row] = await tx.select(listingFields).from(listings).where(eq(listings.id, target.data));
    if (!row) throw new AppError('NOT_FOUND');
    return listingView(row);
  });
}

/**
 * Needs marketplace.install and a person. Writes the row and MARKETPLACE_INSTALL_REQUESTED. A listing that
 * is not `listed` answers MARKETPLACE_LISTING_NOT_AVAILABLE, whichever way it got that way.
 */
export async function requestInstallation(
  database: AppDatabase,
  context: TenantContext,
  gate: SkillFeatureGate,
  input: { listingId: string },
): Promise<InstallationView> {
  const listingId = idSchema.safeParse(input.listingId);
  if (!listingId.success) throw new AppError('INVALID_INPUT');
  if (context.actorType !== 'user' || !can(context.role, 'marketplace.install'))
    throw new AppError('FORBIDDEN');
  if (!(await gate.isEnabled(context, 'marketplace'))) throw new AppError('FEATURE_NOT_ENABLED');
  try {
    return await withTenantTx(database, context, async (tx) => {
      const role = await requireSkillMember(tx, context);
      if (!can(role, 'marketplace.install')) throw new AppError('FORBIDDEN');
      const [row] = await tx
        .insert(installations)
        .values({
          organizationId: context.organizationId,
          listingId: listingId.data,
          requestedByMembershipId: context.membershipId,
        })
        .returning(installationFields);
      if (!row) throw new AppError('INVALID_STATE');
      await emitInstallation(tx, context, row, MARKETPLACE_INSTALL_REQUESTED);
      return installationView(row);
    });
  } catch (error) {
    const code = pgCode(error);
    if (code === SKILL_SQLSTATE.REVIEW_GATE)
      throw new AppError('MARKETPLACE_LISTING_NOT_AVAILABLE');
    if (code === '23505') throw new AppError('MARKETPLACE_ALREADY_INSTALLED');
    if (code === '42501') throw new AppError('FORBIDDEN');
    throw error;
  }
}

const installations = marketplaceInstallations;
const installationFields = {
  id: installations.id,
  listingId: installations.listingId,
  state: installations.state,
  packageId: installations.packageId,
  skillVersionId: installations.skillVersionId,
  failureCode: installations.failureCode,
  createdAt: installations.createdAt,
  version: installations.version,
};

function installationView(
  row: Omit<InstallationView, 'failureCode' | 'state'> & {
    failureCode: string | null;
    state: string;
  },
): InstallationView {
  return {
    ...row,
    state: row.state as InstallationState,
    failureCode: row.failureCode as InstallationFailureCode | null,
  };
}

const installationTarget = (id: string) => 'marketplace_installation:' + id;

async function emitInstallation(
  tx: Tx,
  context: TenantContext,
  row: { id: string; listingId: string; version: number },
  eventType: string,
  failureCode?: InstallationFailureCode,
) {
  await emit(tx, context, {
    eventType,
    aggregateType: AGGREGATE_MARKETPLACE_INSTALLATION,
    aggregateId: row.id,
    aggregateVersion: row.version,
    classification: 'internal',
    payload: { listing_id: row.listingId, ...(failureCode ? { code: failureCode } : {}) },
  });
  await auditAction(tx, context, eventType, installationTarget(row.id), failureCode);
}

function installationScope(context: TenantContext, id: string) {
  return and(eq(installations.organizationId, context.organizationId), eq(installations.id, id));
}

async function lockInstallation(tx: Tx, context: TenantContext, id: string) {
  const [row] = await tx
    .select()
    .from(installations)
    .where(installationScope(context, id))
    .for('update');
  return row;
}

export function listInstallations(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly (InstallationView & { listingDisplayName: string })[]> {
  return withTenantTx(database, context, async (tx) => {
    await requireSkillMember(tx, context);
    const rows = await tx
      .select({ ...installationFields, listingDisplayName: listings.displayName })
      .from(installations)
      .innerJoin(listings, eq(listings.id, installations.listingId))
      .where(eq(installations.organizationId, context.organizationId))
      .orderBy(desc(installations.createdAt), desc(installations.id));
    return rows.map(({ listingDisplayName, ...row }) => ({
      ...installationView(row),
      listingDisplayName,
    }));
  });
}

/**
 * Needs marketplace.install. Moves to `removed`, disables the package, and yanks any live version with
 * WITHDRAWN_BY_OWNER, in one transaction, so nothing here uses it from the next read on.
 */
export async function removeInstallation(
  database: AppDatabase,
  context: TenantContext,
  input: { installationId: string; expectedVersion: number },
): Promise<void> {
  const id = idSchema.safeParse(input.installationId);
  if (!id.success || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new AppError('INVALID_INPUT');
  if (context.actorType !== 'user' || !can(context.role, 'marketplace.install'))
    throw new AppError('FORBIDDEN');
  await withPrivilegeTx(database, context, async (tx) => {
    const role = await requireSkillMember(tx, context, true);
    if (!can(role, 'marketplace.install')) throw new AppError('FORBIDDEN');
    await tx.execute(sql`select skills.lock_trust()`);
    const row = await lockInstallation(tx, context, id.data);
    if (!row) throw new AppError('NOT_FOUND');
    if (input.expectedVersion !== row.version) throw new AppError('VERSION_CONFLICT');
    if (row.state !== 'installed' || !row.packageId || !row.skillVersionId)
      throw new AppError('INVALID_STATE');

    const [version] = await tx
      .select({ state: skillVersions.state, version: skillVersions.version })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.organizationId, context.organizationId),
          eq(skillVersions.packageId, row.packageId),
          eq(skillVersions.id, row.skillVersionId),
        ),
      )
      .for('update');
    if (!version) throw new AppError('INVALID_STATE');
    if (version.state !== 'yanked') {
      await yankSkillVersionInTx(tx, context, {
        skillVersionId: row.skillVersionId,
        expectedVersion: version.version,
        code: 'WITHDRAWN_BY_OWNER',
      });
    }
    await disableInstallationPackage(tx, context, row.packageId);
    const nextVersion = row.version + 1;
    await tx
      .update(installations)
      .set({
        state: 'removed',
        removedByMembershipId: context.membershipId,
        version: nextVersion,
        updatedAt: sql`statement_timestamp()`,
      })
      .where(installationScope(context, row.id));
    await emitInstallation(tx, context, { ...row, version: nextVersion }, MARKETPLACE_REMOVED);
  });
}

async function disableInstallationPackage(tx: Tx, context: TenantContext, packageId: string) {
  await tx
    .update(skillPackages)
    .set({
      state: 'disabled',
      version: sql`${skillPackages.version}+1`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(skillPackages.organizationId, context.organizationId),
        eq(skillPackages.id, packageId),
        eq(skillPackages.state, 'active'),
      ),
    );
}
/** A listing's signed source and immutable byte identity, visible only to its install worker. */
export async function readInstallingListing(
  tx: Tx,
  context: TenantContext,
  installationId: string,
) {
  const [row] = await tx
    .select({
      ...listingFields,
      installationId: installations.id,
      publisherId: listings.publisherId,
      submissionId: listings.submissionId,
      reviewSignature: listings.attestationSignature,
      objectKey: listings.objectKey,
      sizeBytes: listings.sizeBytes,
      signerPublicKey: listings.signerPublicKey,
      signature: listings.signature,
      attestation: marketplaceReviews.attestation,
      attestationSignature: marketplaceReviews.attestationSignature,
      bundleSha256: marketplaceListingObjectReservations.bundleSha256,
    })
    .from(installations)
    .innerJoin(listings, eq(listings.id, installations.listingId))
    .leftJoin(
      marketplaceReviews,
      and(
        eq(marketplaceReviews.id, listings.reviewId),
        eq(marketplaceReviews.submissionId, listings.submissionId),
        eq(marketplaceReviews.submissionOrganizationId, listings.publisherOrganizationId),
        eq(marketplaceReviews.verdict, 'approved'),
      ),
    )
    .leftJoin(
      marketplaceListingObjectReservations,
      and(
        eq(marketplaceListingObjectReservations.digest, listings.digest),
        eq(marketplaceListingObjectReservations.sizeBytes, listings.sizeBytes),
      ),
    )
    .where(and(installationScope(context, installationId), eq(installations.state, 'installing')));
  return row ?? null;
}

export type InstallationSubject = NonNullable<Awaited<ReturnType<typeof readInstallingListing>>>;
type InstallationOutcome = 'installed' | 'failed';
type InstallationStart =
  | { step: 'ready'; subject: InstallationSubject; skillVersionId: string | null }
  | { step: 'settled'; outcome: InstallationOutcome }
  | { step: 'unavailable' };

async function installationWorkerTx<T>(
  database: AppDatabase,
  context: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, async (tx) => {
    const native = await tx.execute<{ allowed: boolean }>(
      sql`select session_user='ensemus_worker' and current_user=session_user as allowed`,
    );
    if (native.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
    return fn(tx);
  });
}

function lockListing(tx: Tx, listingId: string) {
  return tx.execute(sql`select marketplace.lock_install_listing(${listingId}::uuid)`);
}

/** A retry reads the same pending source or returns the durable terminal result. */
export function beginInstallation(
  database: AppDatabase,
  context: TenantContext,
  input: { installationId: string },
): Promise<InstallationStart> {
  return installationWorkerTx(database, context, async (tx) => {
    const row = await lockInstallation(tx, context, input.installationId);
    if (!row) return { step: 'unavailable' };
    if (row.state === 'installed' || row.state === 'removed')
      return { step: 'settled', outcome: 'installed' };
    if (row.state === 'failed') return { step: 'settled', outcome: 'failed' };
    if (row.state === 'requested') {
      await tx
        .update(installations)
        .set({
          state: 'installing',
          version: row.version + 1,
          updatedAt: sql`statement_timestamp()`,
        })
        .where(installationScope(context, row.id));
    }
    await lockListing(tx, row.listingId);
    const subject = await readInstallingListing(tx, context, row.id);
    if (!subject || subject.state !== 'listed') return { step: 'unavailable' };
    return { step: 'ready', subject, skillVersionId: row.skillVersionId };
  });
}

type Materialization =
  { ok: true; skillVersionId: string } | { ok: false; code: InstallationFailureCode };

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function candidateInstallation(tx: Tx, context: TenantContext, subject: InstallationSubject) {
  const row = await lockInstallation(tx, context, subject.installationId);
  if (!row || row.state !== 'installing' || row.listingId !== subject.id) return null;
  await lockListing(tx, row.listingId);
  const current = await readInstallingListing(tx, context, row.id);
  if (!current || current.state !== 'listed' || current.bundleSha256 !== subject.bundleSha256)
    return null;
  return row;
}

function uploadScope(context: TenantContext, id: string) {
  return and(
    eq(skillBundleUploads.organizationId, context.organizationId),
    eq(skillBundleUploads.id, id),
    eq(skillBundleUploads.marketplaceCopy, true),
  );
}

async function recordCopyCompletion(database: AppDatabase, context: TenantContext, id: string) {
  await installationWorkerTx(database, context, async (tx) => {
    await tx
      .update(skillBundleUploads)
      .set({ putFinishedAt: sql`statement_timestamp()` })
      .where(and(uploadScope(context, id), isNull(skillBundleUploads.putFinishedAt)));
  });
}

/** Each installation reserves one object key. Every retry must prove the exact bytes at that key. */
export async function materializeInstallation(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { installationId: string; subject: InstallationSubject; bytes: Buffer },
): Promise<Materialization> {
  const { subject, bytes } = input;
  const id = input.installationId;
  const hash = subject.bundleSha256;
  if (
    id !== subject.installationId ||
    !hash ||
    bytes.length !== subject.sizeBytes ||
    sha256(bytes) !== hash
  )
    return { ok: false, code: 'BUNDLE_HASH_MISMATCH' };
  if (!store.putSingleAttempt) return { ok: false, code: 'BUNDLE_UNAVAILABLE' };

  const claim = await installationWorkerTx(database, context, async (tx) => {
    const row = await candidateInstallation(tx, context, subject);
    if (!row) return { status: 'unavailable' } as const;
    if (row.skillVersionId)
      return { status: 'attached', skillVersionId: row.skillVersionId } as const;
    const [collision] = await tx
      .select({ id: skillPackages.id })
      .from(skillPackages)
      .where(
        and(
          eq(skillPackages.organizationId, context.organizationId),
          eq(skillPackages.name, subject.name),
        ),
      );
    if (collision) return { status: 'name_taken' } as const;
    const [pending] = await tx
      .select({ id: skillBundleUploads.id })
      .from(skillBundleUploads)
      .where(uploadScope(context, id));
    if (pending) return { status: 'pending' } as const;
    await tx.execute(sql`insert into skills.bundle_uploads
      (organization_id,id,membership_id,bundle_sha256,size_bytes,marketplace_copy)
      values (${context.organizationId},${id},${row.requestedByMembershipId},${hash},${bytes.length},true)`);
    return { status: 'writer' } as const;
  });
  if (claim.status === 'unavailable') return { ok: false, code: 'LISTING_NOT_AVAILABLE' };
  if (claim.status === 'name_taken') return { ok: false, code: 'NAME_TAKEN' };
  if (claim.status === 'attached') return { ok: true, skillVersionId: claim.skillVersionId };

  const key = skillBundleObjectKey(context.organizationId, id);
  if (claim.status === 'writer') {
    const put = await store.putSingleAttempt(key, bytes, SKILL_BUNDLE_MEDIA_TYPE).catch(() => null);
    if (put?.transport === 'written') await recordCopyCompletion(database, context, id);
  }
  // A concurrent retry or a lost PUT reply can advance only after a positive read-back.
  const stored = await store.get(key, subject.sizeBytes).catch(() => null);
  if (!stored) throw new AppError('SKILL_UPLOAD_PENDING');
  if (stored.length !== bytes.length || sha256(stored) !== hash)
    return { ok: false, code: 'BUNDLE_HASH_MISMATCH' };
  await recordCopyCompletion(database, context, id);

  try {
    return await installationWorkerTx(database, context, async (tx): Promise<Materialization> => {
      const row = await candidateInstallation(tx, context, subject);
      if (!row) return { ok: false, code: 'LISTING_NOT_AVAILABLE' };
      if (row.skillVersionId) return { ok: true, skillVersionId: row.skillVersionId };
      await tx.insert(skillPackages).values({
        organizationId: context.organizationId,
        id,
        name: subject.name,
        displayName: subject.displayName,
        origin: 'marketplace',
        listingId: subject.id,
        contentClassification: 'public',
      });
      await tx.insert(skillVersions).values({
        organizationId: context.organizationId,
        id,
        packageId: id,
        bundleObjectKey: key,
        bundleSha256: hash,
        sizeBytes: bytes.length,
      });
      await tx
        .update(skillBundleUploads)
        .set({ packageId: id, state: 'attached' })
        .where(uploadScope(context, id));
      await tx
        .update(installations)
        .set({
          packageId: id,
          skillVersionId: id,
          version: row.version + 1,
          updatedAt: sql`statement_timestamp()`,
        })
        .where(installationScope(context, id));
      return { ok: true, skillVersionId: id };
    });
  } catch (error) {
    const code = pgCode(error);
    if (code === SKILL_SQLSTATE.REVIEW_GATE) return { ok: false, code: 'LISTING_NOT_AVAILABLE' };
    if (code === '23505') return { ok: false, code: 'NAME_TAKEN' };
    throw error;
  }
}

async function successfulInstallation(
  tx: Tx,
  context: TenantContext,
  id: string,
  listingId: string,
) {
  await lockListing(tx, listingId);
  const source = await readInstallingListing(tx, context, id);
  if (!source || source.state !== 'listed') return 'LISTING_NOT_AVAILABLE';
  const [row] = await tx
    .select({ state: skillVersions.state })
    .from(skillVersions)
    .innerJoin(
      skillPackages,
      and(
        eq(skillPackages.organizationId, skillVersions.organizationId),
        eq(skillPackages.id, skillVersions.packageId),
        eq(skillPackages.state, 'active'),
      ),
    )
    .innerJoin(
      skillBundleUploads,
      and(
        eq(skillBundleUploads.organizationId, skillVersions.organizationId),
        eq(skillBundleUploads.id, skillVersions.id),
        eq(skillBundleUploads.marketplaceCopy, true),
        eq(skillBundleUploads.state, 'attached'),
        sql`${skillBundleUploads.putMaterialGeneration}=ai.current_material_restore_generation()`,
        sql`${skillBundleUploads.putAuthGeneration}=app.current_auth_restore_generation()`,
      ),
    )
    .where(and(eq(skillVersions.organizationId, context.organizationId), eq(skillVersions.id, id)));
  return row?.state === 'verified' ? null : 'VERIFICATION_REJECTED';
}

export function finishInstallation(
  database: AppDatabase,
  context: TenantContext,
  input: {
    installationId: string;
    outcome: { ok: true } | { ok: false; code: InstallationFailureCode };
  },
): Promise<InstallationOutcome> {
  return installationWorkerTx(database, context, async (tx) => {
    await tx.execute(sql`select skills.lock_trust()`);
    const row = await lockInstallation(tx, context, input.installationId);
    if (!row || row.state === 'failed') return 'failed';
    if (row.state === 'installed' || row.state === 'removed') return 'installed';

    const failureCode = input.outcome.ok
      ? await successfulInstallation(tx, context, row.id, row.listingId)
      : input.outcome.code;
    if (failureCode && row.packageId) await disableInstallationPackage(tx, context, row.packageId);
    const version = row.version + 1;
    const state = failureCode ? 'failed' : 'installed';
    await tx
      .update(installations)
      .set({
        state,
        failureCode,
        version,
        updatedAt: sql`statement_timestamp()`,
      })
      .where(installationScope(context, row.id));
    await emitInstallation(
      tx,
      context,
      { ...row, version },
      failureCode ? MARKETPLACE_INSTALL_FAILED : MARKETPLACE_INSTALLED,
      failureCode ?? undefined,
    );
    if (failureCode)
      await notify(
        tx,
        context,
        [row.requestedByMembershipId],
        NOTIFY_MARKETPLACE_INSTALL_FAILED,
        installationTarget(row.id),
      );
    return state;
  });
}
