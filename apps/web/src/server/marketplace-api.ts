import {
  AppError,
  type InstallationView,
  type ListingView,
  type PublisherView,
  type SubmissionView,
} from '@ensemus/application';
import type { TenantContext } from '@ensemus/database';
import { getSkillFeatureGate } from './skill-runtime';

export async function requireMarketplace(context: TenantContext) {
  const gate = getSkillFeatureGate();
  if (!(await gate.isEnabled(context, 'marketplace'))) throw new AppError('FEATURE_NOT_ENABLED');
  return gate;
}

export function publisherDto(row: PublisherView) {
  return { id: row.id, display_name: row.displayName, state: row.state, version: row.version };
}

export function submissionDto(row: SubmissionView) {
  return {
    id: row.id,
    skill_version_id: row.skillVersionId,
    name: row.name,
    semver: row.semver,
    digest: row.digest,
    state: row.state,
    delist_requested_at: row.delistRequestedAt?.toISOString() ?? null,
    finding_codes: row.findingCodes,
    created_at: row.createdAt.toISOString(),
    decided_at: row.decidedAt?.toISOString() ?? null,
    version: row.version,
  };
}

export function listingDto(row: ListingView) {
  return {
    id: row.id,
    publisher_display_name: row.publisherDisplayName,
    name: row.name,
    semver: row.semver,
    display_name: row.displayName,
    summary: row.summary,
    digest: row.digest,
    license: row.license,
    execution_kind: row.executionKind,
    max_classification: row.maxClassification,
    tool_boundaries: row.toolBoundaries,
    signer_key_id: row.signerKeyId,
    reviewer_key_id: row.reviewerKeyId,
    state: row.state,
    delist_mode: row.delistMode,
    listed_at: row.listedAt.toISOString(),
  };
}

export function installationDto(row: InstallationView) {
  return {
    id: row.id,
    listing_id: row.listingId,
    state: row.state,
    package_id: row.packageId,
    skill_version_id: row.skillVersionId,
    failure_code: row.failureCode,
    created_at: row.createdAt.toISOString(),
    version: row.version,
  };
}
