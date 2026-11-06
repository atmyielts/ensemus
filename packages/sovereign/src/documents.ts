// The shape of every signed document (ADR-030 D2). Object schemas here are not strict, on purpose: a
// signed document with a field this version does not know is still good, because a customer who has
// stopped upgrading has to keep reading what is issued later, and no field can take away the right to run.
// A change an older reader must not miss takes a new `format_version`, which that reader refuses, leaving
// everything already installed as it was (ADR-030 D2). Fields that exist are strict: never relaxed.
import {
  ADVISORY_SEVERITIES,
  BRANCH_STATUSES,
  isDateOnly,
  isReleaseVersion,
  type AdvisoryDocument,
  type LicenseDocument,
  type MaintenanceDocument,
  type SupportPolicyDocument,
} from '@ensemus/domain/license';
import { z } from 'zod';
import type { DocumentPurpose } from './trust-root';

const day = z.string().refine(isDateOnly);
const version = z.string().refine(isReleaseVersion);
const line = z.string().regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
const moment = z.iso.datetime({ offset: true });
const shortText = z.string().trim().min(1).max(200);
const count = z.int().min(0).nullable();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const licenseDocumentSchema = z.object({
  format: z.literal('ensemus.license'),
  format_version: z.literal(1),
  license_id: z.uuid(),
  issued_at: moment,
  licensee: z.object({ display_name: shortText, contract_reference: shortText }),
  edition: z.literal('sovereign'),
  term: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('perpetual') }),
    z.object({ kind: z.literal('pilot'), review_on: day }),
  ]),
  licensed_release: z.object({ line, version }),
  footprint: z.object({
    organizations: count,
    seats: count,
    production_deployments: count,
    nonproduction_deployments: count,
  }),
  components: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(64),
  update_rights: z.object({
    security_patches_after_lapse: z.enum(['none', 'licensed_line']),
    major_versions_with_maintenance: z.enum(['included', 'separate_purchase']),
    releases_published_during_maintenance: z.enum(['kept_after_lapse', 'not_kept']),
    outside_rights_on_install: z.enum(['warn', 'refuse']),
  }),
}) satisfies z.ZodType<LicenseDocument>;

export const maintenanceDocumentSchema = z
  .object({
    format: z.literal('ensemus.maintenance'),
    format_version: z.literal(1),
    maintenance_id: z.uuid(),
    license_id: z.uuid(),
    issued_at: moment,
    starts_on: day,
    ends_on: day,
  })
  .refine(({ starts_on, ends_on }) => starts_on <= ends_on, {
    path: ['ends_on'],
  }) satisfies z.ZodType<MaintenanceDocument>;

export const advisoryDocumentSchema = z.object({
  format: z.literal('ensemus.advisory'),
  format_version: z.literal(1),
  advisory_id: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/),
  issued_at: moment,
  severity: z.enum(ADVISORY_SEVERITIES),
  title: shortText,
  summary: z.string().trim().min(1).max(20_000),
  affected_versions: z.array(version).min(1).max(1024),
  fixed_in_versions: z.array(version).max(1024),
}) satisfies z.ZodType<AdvisoryDocument>;

export const supportPolicyDocumentSchema = z.object({
  format: z.literal('ensemus.support_policy'),
  format_version: z.literal(1),
  policy_id: z.uuid(),
  issued_at: moment,
  branches: z.array(z.object({ line, status: z.enum(BRANCH_STATUSES) })).max(256),
  security_patches_after_lapse_grant: z.enum(['none', 'licensed_line', 'any_supported_line']),
}) satisfies z.ZodType<SupportPolicyDocument>;

/** A path inside a bundle. An allowlist, so nothing in a manifest can point outside the folder. */
export const bundlePathSchema = z
  .string()
  .max(240)
  .regex(/^[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)*$/)
  .refine((path) => !path.includes('..'));

export const BUNDLE_FILE_ROLES = [
  'image',
  'compose',
  'migration',
  'sbom',
  'notice',
  'tool',
  'advisory',
  'support_policy',
  'release_manifest',
  'model',
  'documentation',
] as const;

export const bundleFileSchema = z.object({
  path: bundlePathSchema,
  sha256,
  bytes: z.int().min(0),
  role: z.enum(BUNDLE_FILE_ROLES),
});
export type BundleFile = z.infer<typeof bundleFileSchema>;

const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** What is in an offline bundle (COMM-04, OPS-11). Everything a bundle holds is listed, or it is refused. */
export const bundleManifestSchema = z.object({
  format: z.literal('ensemus.bundle'),
  format_version: z.literal(1),
  bundle_id: z.uuid(),
  issued_at: moment,
  release: z.object({
    version,
    line,
    kind: z.enum(['major', 'minor', 'patch']),
    security: z.boolean(),
    published_on: day,
    git_commit: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  files: z.array(bundleFileSchema).min(1).max(100_000),
  images: z
    .array(
      z.object({
        /** The name the release knows it by, such as `web` or `worker`. */
        name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        digest: imageDigest,
        /** The OCI archive in `files` this image loads from. */
        file: bundlePathSchema,
      }),
    )
    .min(1)
    .max(64),
  compatibility: z.object({
    /** Versions this bundle can upgrade from directly. Anything else needs an intermediate bundle. */
    upgrade_from: z.array(version).max(1024),
    /** Versions the operator can go back to, after restoring the backup taken before upgrading. */
    rollback_to: z.array(version).max(1024),
    /** Known limits, as codes the operator's guide explains. Empty means none are known yet. */
    rollback_constraints: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(64),
    database_schema_version: z.string().regex(/^[0-9]{4}_[a-z0-9_]+\.sql$/),
    workflow_compatibility: shortText,
    node_version: shortText,
  }),
  /** Local model weights, if redistribution is decided. Empty until the owner decides it. */
  models: z
    .array(z.object({ name: shortText, file: bundlePathSchema, license_reference: shortText }))
    .max(64),
});
export type BundleManifest = z.infer<typeof bundleManifestSchema>;

/** What a support organization publishes so a customer can seal a diagnostic bundle to it (SOV-06). */
export const diagnosticRecipientDocumentSchema = z.object({
  format: z.literal('ensemus.diagnostic_recipient'),
  format_version: z.literal(1),
  issued_at: moment,
  recipient_public_key: z.string().min(1).max(512),
  label: shortText,
});
export type DiagnosticRecipientDocument = z.infer<typeof diagnosticRecipientDocumentSchema>;

export const DOCUMENT_SCHEMAS = {
  license: licenseDocumentSchema,
  maintenance: maintenanceDocumentSchema,
  advisory: advisoryDocumentSchema,
  support_policy: supportPolicyDocumentSchema,
  bundle: bundleManifestSchema,
  diagnostic_recipient: diagnosticRecipientDocumentSchema,
} as const satisfies Record<DocumentPurpose, z.ZodType>;

export type DocumentFor<P extends DocumentPurpose> = z.infer<(typeof DOCUMENT_SCHEMAS)[P]>;
