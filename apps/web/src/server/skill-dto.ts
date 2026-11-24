import type { SkillPackageView, SkillVersionView } from '@ensemus/application';

export function skillPackageDto(row: SkillPackageView) {
  return {
    id: row.id,
    name: row.name,
    display_name: row.displayName,
    origin: row.origin,
    listing_id: row.listingId,
    state: row.state,
    content_classification: row.contentClassification,
    version: row.version,
    created_at: row.createdAt.toISOString(),
  };
}

export function skillVersionDto(row: SkillVersionView) {
  const test = row.latestTest;
  return {
    id: row.id,
    package_id: row.packageId,
    state: row.state,
    bundle_sha256: row.bundleSha256,
    size_bytes: row.sizeBytes,
    semver: row.semver,
    digest: row.digest,
    execution_kind: row.executionKind,
    license: row.license,
    max_classification: row.maxClassification,
    signer_key_id: row.signerKeyId,
    tool_boundaries: row.toolBoundaries,
    reject_code: row.rejectCode,
    yank_code: row.yankCode,
    latest_test: test
      ? {
          mode: test.mode,
          outcome: test.outcome,
          fixtures_total: test.fixturesTotal,
          fixtures_passed: test.fixturesPassed,
          first_failed_fixture: test.firstFailedFixture,
          code: test.code,
          finished_at: test.finishedAt.toISOString(),
        }
      : null,
    uploaded_at: row.uploadedAt.toISOString(),
    published_at: row.publishedAt?.toISOString() ?? null,
    version: row.version,
  };
}
