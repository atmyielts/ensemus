// Owned by the marketplace-install slice (EXP-06). See docs/06-delivery/m11b-slices.md and ADR-034 D6, D7.
// A tenant's side of taking a listing. Installing copies bytes and grants nothing (AGENT-14's rule), and the
// copy goes through the same verification as an upload, and someone here still has to publish it.
import {
  marketplaceInstallations,
  marketplaceListings,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type {
  DelistMode,
  InstallationFailureCode,
  InstallationState,
  ListingState,
} from '@ensemus/domain/marketplace';
import type { ObjectStore } from './artifacts';
import { AppError } from './errors';
import { idSchema } from './ids';
import { requireSkillMember } from './skill-access';
import type { SkillFeatureGate } from './skill-ports';

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
export function requestInstallation(
  _database: AppDatabase,
  _context: TenantContext,
  _gate: SkillFeatureGate,
  _input: { listingId: string },
): Promise<InstallationView> {
  throw new Error('NOT_IMPLEMENTED');
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

export function listInstallations(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly InstallationView[]> {
  return withTenantTx(database, context, async (tx) => {
    await requireSkillMember(tx, context);
    const rows = await tx
      .select(installationFields)
      .from(installations)
      .where(eq(installations.organizationId, context.organizationId))
      .orderBy(desc(installations.createdAt), desc(installations.id));
    return rows.map((row) => ({
      ...row,
      state: row.state as InstallationState,
      failureCode: row.failureCode as InstallationFailureCode | null,
    }));
  });
}

/**
 * Needs marketplace.install. Moves to `removed`, disables the package, and yanks any live version with
 * WITHDRAWN_BY_OWNER, in one transaction, so nothing here uses it from the next read on.
 */
export function removeInstallation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { installationId: string; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** What a worker needs to copy a listing in. Lives only in the worker's memory. */
export type InstallationSubject = {
  installationId: string;
  listingId: string;
  name: string;
  displayName: string;
  semver: string;
  digest: string;
  objectKey: string;
  sizeBytes: number;
  signerKeyId: string;
  signerPublicKey: Buffer;
  signature: Buffer;
  reviewerKeyId: string;
  attestation: unknown;
  attestationSignature: Buffer;
  delistMode: DelistMode | null;
  state: ListingState;
};

/** Moves `requested` to `installing`, and reads the subject. A retry finds it `installing` and reads it again. */
export function beginInstallation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { installationId: string },
): Promise<InstallationSubject | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * After the Activity has checked the attestation, the signature and the bytes: copies the bytes to this
 * tenant's prefix, then creates the package (origin marketplace) and an `uploaded` version with nobody as
 * uploader, in one transaction. Answers NAME_TAKEN if this tenant already has a package of that name. The
 * version is then verified by the workflow's child, so no event is emitted for it.
 */
export function materializeInstallation(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _input: { installationId: string; subject: InstallationSubject; bytes: Buffer },
): Promise<{ ok: true; skillVersionId: string } | { ok: false; code: InstallationFailureCode }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function finishInstallation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    installationId: string;
    outcome: { ok: true } | { ok: false; code: InstallationFailureCode };
  },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
