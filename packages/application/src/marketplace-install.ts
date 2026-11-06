// Owned by the marketplace-install slice (EXP-06). See docs/06-delivery/m11b-slices.md and ADR-034 D6, D7.
// A tenant's side of taking a listing. Installing copies bytes and grants nothing (AGENT-14's rule), and the
// copy goes through the same verification as an upload, and someone here still has to publish it.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type {
  DelistMode,
  InstallationFailureCode,
  InstallationState,
  ListingState,
} from '@ensemus/domain/marketplace';
import type { ObjectStore } from './artifacts';
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

/** Every member can read what is on offer. Needs the marketplace feature on, and answers an empty page if not. */
export function listListings(
  _database: AppDatabase,
  _context: TenantContext,
  _gate: SkillFeatureGate,
  _input: { after?: string; limit?: number },
): Promise<ListingPage> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getListing(
  _database: AppDatabase,
  _context: TenantContext,
  _gate: SkillFeatureGate,
  _listingId: string,
): Promise<ListingView> {
  throw new Error('NOT_IMPLEMENTED');
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

export function listInstallations(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly InstallationView[]> {
  throw new Error('NOT_IMPLEMENTED');
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
