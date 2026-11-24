// M11B tables: the skills catalog, sandbox runs and the marketplace (ADR-034). Roles, grants, RLS and the
// triggers that hold "signed, tested and reviewed before anyone can use it" are in reviewed SQL, migration
// 0651. Nothing here stores a private key, a price or a payment.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, organizations } from './schema';
import { workUnits } from './schema-work';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id);

export const skillsSchema = pgSchema('skills');
export const sandboxSchema = pgSchema('sandbox');
export const marketplaceSchema = pgSchema('marketplace');

/**
 * A public key this tenant trusts for the packages it uploads. The private half is never here: a package
 * arrives already signed, and Ensemus cannot sign one for anybody (ADR-034 D2).
 */
export const trustedSigners = skillsSchema.table(
  'trusted_signers',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    displayName: text().notNull(),
    /** SHA-256 of the raw public key, in hex. What a signature names, and what a person compares. */
    keyId: text().notNull(),
    /** A raw 32-byte Ed25519 public key. */
    publicKey: bytea().notNull(),
    state: text().notNull().default('active'),
    addedByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp({ withTimezone: true }),
    revokedByMembershipId: uuid(),
    version: bigint({ mode: 'number' }).notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('trusted_signers_key').on(t.organizationId, t.keyId),
    foreignKey({
      columns: [t.organizationId, t.addedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.revokedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('trusted_signers_state', sql`${t.state} in ('active','revoked')`),
    check('trusted_signers_key_format', sql`${t.keyId} ~ '^[0-9a-f]{64}$'`),
    check('trusted_signers_key_size', sql`octet_length(${t.publicKey}) = 32`),
    check('trusted_signers_name_size', sql`char_length(${t.displayName}) between 1 and 120`),
    check(
      'trusted_signers_revocation',
      sql`(${t.state} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
  ],
);

/**
 * A named skill in one tenant. `listing_id` says it came from the marketplace, and migration 0651 holds
 * the foreign key, because the tables refer to each other in a circle Drizzle's types cannot follow.
 */
export const skillPackages = skillsSchema.table(
  'packages',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    name: text().notNull(),
    displayName: text().notNull(),
    origin: text().notNull().default('tenant'),
    listingId: uuid(),
    state: text().notNull().default('active'),
    /** How sensitive the package's own instructions are. Only `public` can go to the marketplace. */
    contentClassification: text().notNull().default('internal'),
    ownerMembershipId: uuid(),
    createdByMembershipId: uuid(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('skill_packages_name').on(t.organizationId, t.name),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('skill_packages_name_format', sql`${t.name} ~ '^[a-z][a-z0-9-]{1,63}$'`),
    check('skill_packages_display_size', sql`char_length(${t.displayName}) between 1 and 120`),
    check('skill_packages_origin', sql`${t.origin} in ('tenant','marketplace')`),
    check('skill_packages_state', sql`${t.state} in ('active','disabled')`),
    check(
      'skill_packages_classification',
      sql`${t.contentClassification} in ('public','internal','confidential','restricted')`,
    ),
    check(
      'skill_packages_origin_listing',
      sql`(${t.origin} = 'marketplace') = (${t.listingId} is not null)`,
    ),
    check('skill_packages_version', sql`${t.version} > 0`),
  ],
);

/**
 * One uploaded bundle. Its bytes are in the object store, and nothing about it is believed until a worker
 * has read them: the web tier only knows the size and the hash. What a worker learns from the bundle is
 * set once, on the way to `verified`, and a trigger refuses any change after that, so a published version
 * can never come to mean something else (ADR-034 D1).
 */
export const skillVersions = skillsSchema.table(
  'package_versions',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    packageId: uuid().notNull(),
    state: text().notNull().default('uploaded'),
    /** Starts with the tenant, and holds no names. */
    bundleObjectKey: text().notNull(),
    /** SHA-256 of the stored bytes, in hex, taken by whoever wrote them. */
    bundleSha256: text().notNull(),
    sizeBytes: integer().notNull(),
    /** The rest are null until a worker has read and checked the bundle. */
    semver: text(),
    /** The manifest's canonical hash. A signature covers this, and the manifest lists every file. */
    digest: text(),
    manifest: jsonb(),
    executionKind: text(),
    license: text(),
    maxClassification: text(),
    signerKeyId: text(),
    signature: bytea(),
    /** Null for a copy that came from the marketplace, which nobody in this tenant uploaded. */
    uploadedByMembershipId: uuid(),
    uploadedAt: createdAt(),
    verifiedAt: timestamp({ withTimezone: true }),
    publishedByMembershipId: uuid(),
    publishedAt: timestamp({ withTimezone: true }),
    yankedByMembershipId: uuid(),
    yankedAt: timestamp({ withTimezone: true }),
    /** A code from the fixed list in @ensemus/domain/skill. Text from a bundle never goes here. */
    rejectCode: text(),
    yankCode: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.packageId],
      foreignColumns: [skillPackages.organizationId, skillPackages.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.uploadedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.publishedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.yankedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    // A version number means one thing. A rejected upload never took it, so the name stays free.
    uniqueIndex('skill_versions_semver')
      .on(t.organizationId, t.packageId, t.semver)
      .where(sql`${t.semver} is not null and ${t.state} <> 'rejected'`),
    // Uploading the same bytes again finds the same row.
    uniqueIndex('skill_versions_bundle')
      .on(t.organizationId, t.packageId, t.bundleSha256)
      .where(sql`${t.state} <> 'rejected'`),
    index('skill_versions_package_idx').on(t.organizationId, t.packageId, t.uploadedAt),
    index('skill_versions_signer_idx').on(t.organizationId, t.signerKeyId),
    check(
      'skill_versions_state',
      sql`${t.state} in ('uploaded','verifying','verified','rejected','published','yanked')`,
    ),
    check('skill_versions_bundle_hash', sql`${t.bundleSha256} ~ '^[0-9a-f]{64}$'`),
    check('skill_versions_digest', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check('skill_versions_signer_key', sql`${t.signerKeyId} ~ '^[0-9a-f]{64}$'`),
    check('skill_versions_size', sql`${t.sizeBytes} between 1 and 8388608`),
    check('skill_versions_semver_format', sql`${t.semver} ~ '^[0-9]+[.][0-9]+[.][0-9]+$'`),
    check('skill_versions_execution', sql`${t.executionKind} in ('declarative','sandbox')`),
    check(
      'skill_versions_max_classification',
      sql`${t.maxClassification} in ('public','internal','confidential')`,
    ),
    // Whatever has been checked has everything a check needs.
    check(
      'skill_versions_checked_complete',
      sql`${t.state} not in ('verified','published') or (
        ${t.semver} is not null and ${t.digest} is not null and ${t.manifest} is not null
        and ${t.executionKind} is not null and ${t.license} is not null
        and ${t.maxClassification} is not null and ${t.signerKeyId} is not null
        and ${t.signature} is not null and ${t.verifiedAt} is not null)`,
    ),
    check(
      'skill_versions_published_by',
      sql`${t.state} <> 'published' or (${t.publishedByMembershipId} is not null and ${t.publishedAt} is not null)`,
    ),
    check('skill_versions_reject', sql`(${t.state} = 'rejected') = (${t.rejectCode} is not null)`),
    check(
      'skill_versions_yank',
      sql`(${t.state} = 'yanked') = (${t.yankCode} is not null and ${t.yankedAt} is not null)`,
    ),
    // Whoever uploaded a version cannot also be who decides it goes live (ADR-034 D4).
    check(
      'skill_versions_two_people',
      sql`${t.publishedByMembershipId} is null or ${t.uploadedByMembershipId} is null
        or ${t.publishedByMembershipId} <> ${t.uploadedByMembershipId}`,
    ),
    check('skill_versions_version', sql`${t.version} > 0`),
  ],
);

/** A reserved key and its write outcome. A superseded key remains in the inventory. */
export const skillBundleUploads = skillsSchema.table(
  'bundle_uploads',
  {
    organizationId: tenantId(),
    id: uuid().notNull(),
    packageId: uuid(),
    membershipId: uuid().notNull(),
    bundleSha256: text().notNull(),
    sizeBytes: integer().notNull(),
    state: text().notNull().default('writing'),
    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    putFinishedAt: timestamp({ withTimezone: true }),
    putMaterialGeneration: uuid(),
    putAuthGeneration: uuid(),
    marketplaceCopy: boolean().notNull().default(false),
    copyMaterialGeneration: uuid(),
    copyAuthGeneration: uuid(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.packageId],
      foreignColumns: [skillPackages.organizationId, skillPackages.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('skill_bundle_upload_one_writer')
      .on(t.organizationId, t.packageId, t.bundleSha256)
      .where(sql`${t.state} = 'writing'`),
    index('skill_upload_cleanup_ready')
      .on(t.organizationId, t.putFinishedAt, t.id)
      .where(sql`${t.putFinishedAt} is not null and ${t.state} in ('writing','superseded')`),
    check(
      'skill_upload_put_receipt',
      sql`(${t.putFinishedAt} is null and ${t.putMaterialGeneration} is null and ${t.putAuthGeneration} is null)
        or (${t.putFinishedAt} is not null and ${t.putMaterialGeneration} is not null and ${t.putAuthGeneration} is not null)`,
    ),
    check(
      'skill_upload_marketplace_target',
      sql`(${t.marketplaceCopy} and ${t.copyMaterialGeneration} is not null and ${t.copyAuthGeneration} is not null
        and (${t.packageId} is null or ${t.packageId}=${t.id})
        and (${t.state}<>'attached' or ${t.packageId} is not null))
        or (not ${t.marketplaceCopy} and ${t.packageId} is not null
          and ${t.copyMaterialGeneration} is null and ${t.copyAuthGeneration} is null)`,
    ),
    check('bundle_uploads_bundle_sha256_check', sql`${t.bundleSha256} ~ '^[0-9a-f]{64}$'`),
    check('bundle_uploads_size_bytes_check', sql`${t.sizeBytes} between 1 and 8388608`),
    check('bundle_uploads_state_check', sql`${t.state} in ('writing','attached','superseded')`),
  ],
);

/** One pass of a version's own tests. Append-only: a result is never edited, only followed by another. */
export const skillTestRuns = skillsSchema.table(
  'test_runs',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    skillVersionId: uuid().notNull(),
    digest: text().notNull(),
    /** `contract` checks fixtures against the declared schemas. `sandbox` also runs the code. */
    mode: text().notNull(),
    outcome: text().notNull(),
    fixturesTotal: integer().notNull(),
    fixturesPassed: integer().notNull(),
    /** Which fixture failed first, by position. A failing fixture's content is never copied here. */
    firstFailedFixture: integer(),
    code: text(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    finishedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.skillVersionId],
      foreignColumns: [skillVersions.organizationId, skillVersions.id],
    }),
    index('skill_test_runs_version_idx').on(t.organizationId, t.skillVersionId, t.finishedAt),
    check('skill_test_runs_mode', sql`${t.mode} in ('contract','sandbox')`),
    check('skill_test_runs_outcome', sql`${t.outcome} in ('passed','failed','error')`),
    check('skill_test_runs_digest', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check(
      'skill_test_runs_counts',
      sql`${t.fixturesTotal} between 1 and 50 and ${t.fixturesPassed} between 0 and ${t.fixturesTotal}`,
    ),
    check(
      'skill_test_runs_passed_means_all',
      sql`${t.outcome} <> 'passed' or ${t.fixturesPassed} = ${t.fixturesTotal}`,
    ),
  ],
);

/**
 * One execution of a version's code. The input and output stay here, under RLS, and Temporal only ever
 * sees this row's ID (ADR-024 D2). The input and policy are fixed when the row is written, so what was
 * approved and what runs are the same. Restricted data is refused by the classification check.
 */
export const sandboxRuns = sandboxSchema.table(
  'runs',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    skillVersionId: uuid().notNull(),
    digest: text().notNull(),
    purpose: text().notNull(),
    /** Set for a run that tests a version, so a result is tied to what it tested. */
    testFixture: integer(),
    fixtureSignerKeyId: text(),
    workUnitId: uuid(),
    /** M4's run and step. Plain IDs until the final merge adds the keys (ADR-034 D8). */
    agentRunId: uuid(),
    executionStepId: uuid(),
    requestedByMembershipId: uuid(),
    classification: text().notNull(),
    input: jsonb().notNull(),
    /** The policy this run was compiled to, as it was compiled. */
    policy: jsonb().notNull(),
    policyHash: text().notNull(),
    status: text().notNull().default('queued'),
    /** A code from the fixed list in @ensemus/domain/sandbox. Text from a job never goes here. */
    outcomeCode: text(),
    /** How many times it went to the runner. Nothing leaves a sandbox, so another try is safe. */
    attempts: integer().notNull().default(0),
    /** Irreversible database marker. A missing historical receipt starts true. */
    executionEverAdmitted: boolean().notNull().default(true),
    exitCode: integer(),
    wallMs: integer(),
    cpuMs: integer(),
    peakMemoryKb: integer(),
    stdoutBytes: integer(),
    stderrBytes: integer(),
    /** What the code returned, checked against the declared output schema. Data, never instructions. */
    output: jsonb(),
    outputSha256: text(),
    /** When a runner's own probe last passed, for this run. Null is not evidence of anything. */
    isolationProbePassedAt: timestamp({ withTimezone: true }),
    runtimeName: text(),
    runtimeVersion: text(),
    cancelRequestedAt: timestamp({ withTimezone: true }),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.skillVersionId],
      foreignColumns: [skillVersions.organizationId, skillVersions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('sandbox_runs_status_idx').on(t.organizationId, t.status, t.updatedAt),
    index('sandbox_runs_version_idx').on(t.organizationId, t.skillVersionId, t.createdAt),
    index('sandbox_runs_agent_idx').on(t.organizationId, t.agentRunId),
    uniqueIndex('sandbox_bound_fixture_once')
      .on(t.organizationId, t.skillVersionId, t.testFixture)
      .where(sql`${t.fixtureSignerKeyId} is not null`),
    check(
      'sandbox_fixture_signer_binding',
      sql`${t.fixtureSignerKeyId} is null or (${t.purpose}='skill_test' and ${t.fixtureSignerKeyId} ~ '^[0-9a-f]{64}$' and ${t.testFixture} between 0 and 49)`,
    ),
    check('sandbox_runs_purpose', sql`${t.purpose} in ('skill_test','agent_tool','operator_test')`),
    check(
      'sandbox_runs_status',
      sql`${t.status} in ('queued','running','succeeded','failed','timed_out','memory_exceeded','output_exceeded','denied','cancelled','runner_unavailable')`,
    ),
    check(
      'sandbox_runs_classification',
      sql`${t.classification} in ('public','internal','confidential')`,
    ),
    check('sandbox_runs_digest', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check('sandbox_runs_policy_hash', sql`${t.policyHash} ~ '^[0-9a-f]{64}$'`),
    check('sandbox_runs_input_size', sql`octet_length(${t.input}::text) <= 1048576`),
    check('sandbox_runs_output_size', sql`octet_length(${t.output}::text) <= 1048576`),
    check('sandbox_runs_attempts', sql`${t.attempts} between 0 and 3`),
    check(
      'sandbox_runs_test_fixture',
      sql`(${t.purpose} = 'skill_test') = (${t.testFixture} is not null)`,
    ),
    check(
      'sandbox_runs_agent_link',
      sql`(${t.purpose} = 'agent_tool') = (${t.agentRunId} is not null and ${t.executionStepId} is not null)`,
    ),
    check('sandbox_runs_version', sql`${t.version} > 0`),
  ],
);

/** A tenant that has asked to publish to this deployment's marketplace. */
export const marketplacePublishers = marketplaceSchema.table(
  'publishers',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: tenantId().unique('marketplace_publishers_organization'),
    displayName: text().notNull(),
    state: text().notNull().default('active'),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('marketplace_publishers_state', sql`${t.state} in ('active','suspended')`),
    check('marketplace_publishers_name_size', sql`char_length(${t.displayName}) between 1 and 120`),
  ],
);

/**
 * A publisher's request to list one version, with everything a reviewer needs copied in, so the operator
 * role never has to reach the `skills` schema. A trigger holds the copy equal to the version it names.
 */
export const marketplaceSubmissions = marketplaceSchema.table(
  'submissions',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    publisherId: uuid()
      .notNull()
      .references(() => marketplacePublishers.id),
    packageId: uuid().notNull(),
    skillVersionId: uuid().notNull(),
    name: text().notNull(),
    semver: text().notNull(),
    digest: text().notNull(),
    manifest: jsonb().notNull(),
    signerKeyId: text().notNull(),
    signerPublicKey: bytea().notNull(),
    signature: bytea().notNull(),
    bundleObjectKey: text().notNull(),
    sizeBytes: integer().notNull(),
    state: text().notNull().default('submitted'),
    submittedByMembershipId: uuid().notNull(),
    /** Someone with authority said this package may be shown to other organizations. */
    publishConfirmedAt: timestamp({ withTimezone: true }).notNull(),
    withdrawnByMembershipId: uuid(),
    /** A publisher cannot write a listing. This asks the operator to take theirs down. */
    delistRequestedAt: timestamp({ withTimezone: true }),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.skillVersionId],
      foreignColumns: [skillVersions.organizationId, skillVersions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.packageId],
      foreignColumns: [skillPackages.organizationId, skillPackages.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.submittedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.withdrawnByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('marketplace_submissions_one_open')
      .on(t.organizationId, t.skillVersionId)
      .where(sql`${t.state} in ('submitted','in_review')`),
    index('marketplace_submissions_queue_idx').on(t.state, t.createdAt),
    check(
      'marketplace_submissions_state',
      sql`${t.state} in ('submitted','in_review','approved','rejected','withdrawn')`,
    ),
    check('marketplace_submissions_digest', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check('marketplace_submissions_signer', sql`${t.signerKeyId} ~ '^[0-9a-f]{64}$'`),
    check('marketplace_submissions_key_size', sql`octet_length(${t.signerPublicKey}) = 32`),
    check('marketplace_submissions_version', sql`${t.version} > 0`),
  ],
);

/**
 * A decision by a person holding a review key. Append-only for everyone. The attestation is what they
 * signed, so a row written by anything else fails at install however it got here (ADR-034 D5).
 */
export const marketplaceReviews = marketplaceSchema.table(
  'security_reviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    submissionOrganizationId: uuid().notNull(),
    submissionId: uuid().notNull(),
    digest: text().notNull(),
    signerKeyId: text().notNull(),
    reviewerKeyId: text().notNull(),
    reviewerLabel: text().notNull(),
    verdict: text().notNull(),
    /** Each check from REVIEW_CHECKS in @ensemus/domain/marketplace, with pass, fail or not_applicable. */
    checks: jsonb().notNull(),
    findingCodes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    attestation: jsonb().notNull(),
    attestationSignature: bytea().notNull(),
    decidedAt: timestamp({ withTimezone: true }).notNull(),
    recordedAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.submissionOrganizationId, t.submissionId],
      foreignColumns: [marketplaceSubmissions.organizationId, marketplaceSubmissions.id],
    }),
    index('marketplace_reviews_submission_idx').on(t.submissionOrganizationId, t.submissionId),
    check('marketplace_reviews_verdict', sql`${t.verdict} in ('approved','rejected')`),
    check('marketplace_reviews_digest', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check('marketplace_reviews_reviewer_key', sql`${t.reviewerKeyId} ~ '^[0-9a-f]{64}$'`),
    check('marketplace_reviews_signature_size', sql`octet_length(${t.attestationSignature}) = 64`),
    check('marketplace_reviews_label_size', sql`char_length(${t.reviewerLabel}) between 1 and 120`),
  ],
);

/**
 * What every tenant on this deployment can see. Global on purpose, and written only by the operator role,
 * through a trigger that refuses a listing without an approved review of exactly this digest. There is no
 * price here, and nothing in M11B takes a payment (ADR-034 D6).
 */
export const marketplaceListings = marketplaceSchema.table(
  'listings',
  {
    id: uuid().primaryKey().defaultRandom(),
    publisherId: uuid()
      .notNull()
      .references(() => marketplacePublishers.id),
    publisherOrganizationId: uuid().notNull(),
    publisherDisplayName: text().notNull(),
    submissionId: uuid().notNull(),
    reviewId: uuid()
      .notNull()
      .references(() => marketplaceReviews.id)
      .unique('marketplace_listings_review'),
    name: text().notNull(),
    semver: text().notNull(),
    displayName: text().notNull(),
    summary: text().notNull(),
    digest: text().notNull(),
    manifest: jsonb().notNull(),
    license: text().notNull(),
    executionKind: text().notNull(),
    maxClassification: text().notNull(),
    signerKeyId: text().notNull(),
    signerPublicKey: bytea().notNull(),
    signature: bytea().notNull(),
    reviewerKeyId: text().notNull(),
    attestationSignature: bytea().notNull(),
    /** A copy outside any tenant's prefix, made once the bytes were checked against the digest. */
    objectKey: text().notNull(),
    sizeBytes: integer().notNull(),
    state: text().notNull().default('listed'),
    /** Only when delisted. `stop_new` keeps existing installs running, and `revoke` stops them too. */
    delistMode: text(),
    delistCode: text(),
    listedAt: createdAt(),
    delistedAt: timestamp({ withTimezone: true }),
    version: bigint({ mode: 'number' }).notNull().default(1),
  },
  (t) => [
    foreignKey({
      columns: [t.publisherOrganizationId, t.submissionId],
      foreignColumns: [marketplaceSubmissions.organizationId, marketplaceSubmissions.id],
    }),
    unique('marketplace_listings_release').on(t.publisherId, t.name, t.semver),
    index('marketplace_listings_state_idx').on(t.state, t.listedAt),
    check('marketplace_listings_state', sql`${t.state} in ('listed','delisted')`),
    check('marketplace_listings_digest', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check('marketplace_listings_key_size', sql`octet_length(${t.signerPublicKey}) = 32`),
    check('marketplace_listings_signature_size', sql`octet_length(${t.signature}) = 64`),
    check('marketplace_listings_execution', sql`${t.executionKind} in ('declarative','sandbox')`),
    check(
      'marketplace_listings_max_classification',
      sql`${t.maxClassification} in ('public','internal','confidential')`,
    ),
    check('marketplace_listings_delist_mode', sql`${t.delistMode} in ('stop_new','revoke')`),
    check(
      'marketplace_listings_delisted',
      sql`(${t.state} = 'delisted') = (${t.delistMode} is not null and ${t.delistCode} is not null and ${t.delistedAt} is not null)`,
    ),
    check('marketplace_listings_version', sql`${t.version} > 0`),
  ],
);

/**
 * One tenant taking one listing. Installing copies bytes and grants nothing: the copy goes through the
 * same verification as an upload, and someone in the tenant still has to publish it (ADR-034 D7).
 */
export const marketplaceInstallations = marketplaceSchema.table(
  'installations',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    listingId: uuid()
      .notNull()
      .references(() => marketplaceListings.id),
    state: text().notNull().default('requested'),
    packageId: uuid(),
    skillVersionId: uuid(),
    requestedByMembershipId: uuid().notNull(),
    removedByMembershipId: uuid(),
    failureCode: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp({ withTimezone: true }),
    birthMaterialGeneration: uuid(),
    birthAuthGeneration: uuid(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.packageId],
      foreignColumns: [skillPackages.organizationId, skillPackages.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.skillVersionId],
      foreignColumns: [skillVersions.organizationId, skillVersions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.removedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('marketplace_installations_one_live')
      .on(t.organizationId, t.listingId)
      .where(sql`${t.state} in ('requested','installing','installed')`),
    index('marketplace_installations_listing_idx').on(t.listingId),
    check(
      'marketplace_installations_state',
      sql`${t.state} in ('requested','installing','installed','failed','removed')`,
    ),
    check(
      'marketplace_installations_failed',
      sql`(${t.state} = 'failed') = (${t.failureCode} is not null)`,
    ),
    check(
      'marketplace_installations_installed',
      sql`${t.state} <> 'installed' or (${t.packageId} is not null and ${t.skillVersionId} is not null)`,
    ),
    check(
      'marketplace_installation_birth_generation_pair',
      sql`(${t.birthMaterialGeneration} is null) = (${t.birthAuthGeneration} is null)`,
    ),
    check('marketplace_installations_version', sql`${t.version} > 0`),
  ],
);

/** Immutable bytes identity for the shared manifest-digest object used by a listing. */
export const marketplaceListingObjectReservations = marketplaceSchema.table(
  'listing_object_reservations',
  { digest: text().primaryKey(), bundleSha256: text().notNull(), sizeBytes: integer().notNull() },
  (t) => [
    check('listing_object_reservations_digest_check', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check(
      'listing_object_reservations_bundle_sha256_check',
      sql`${t.bundleSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'listing_object_reservations_size_bytes_check',
      sql`${t.sizeBytes} between 1 and 8388608`,
    ),
  ],
);

export type SkillVersionRow = typeof skillVersions.$inferSelect;
export type SkillPackageRow = typeof skillPackages.$inferSelect;
export type TrustedSignerRow = typeof trustedSigners.$inferSelect;
export type SandboxRunRow = typeof sandboxRuns.$inferSelect;
export type MarketplaceListingRow = typeof marketplaceListings.$inferSelect;
export type MarketplaceSubmissionRow = typeof marketplaceSubmissions.$inferSelect;
export type MarketplaceInstallationRow = typeof marketplaceInstallations.$inferSelect;
export type MarketplaceReviewRow = typeof marketplaceReviews.$inferSelect;
