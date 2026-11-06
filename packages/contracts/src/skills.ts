// Runtime contracts for skill packages, sandbox runs and the marketplace (ADR-034). The manifest and bundle
// are the format a publisher signs, so changing them is a new format version. The request and response
// shapes match docs/specifications/openapi.yaml, and a test keeps their enums the same.
import { z } from 'zod';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const skillName = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const semver = z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/);
const toolName = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
/** Base64 with padding, the only spelling a signature or key may have. */
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

/**
 * A relative path inside a package. There is no way to name a parent, a hidden file, a drive or a device,
 * because nothing here should ever have to clean one up. Every part starts with a letter or digit.
 */
export const skillPathSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);

const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 2000;
/**
 * The JSON Schema words a skill may use. No `pattern`, `format` or `$ref`: this runs in a worker over what
 * a stranger wrote, so it must not be able to compile a regular expression, fetch anything or recurse. A
 * small interpreter in @ensemus/skills/bundle reads exactly this list (ADR-034 D2).
 */
export const SKILL_SCHEMA_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'description',
  'title',
] as const;

/** Counts nodes while checking every key, and stops at the first thing outside the subset. */
function isSupportedSchema(value: unknown, depth = 0, seen = { nodes: 0 }): boolean {
  seen.nodes += 1;
  if (seen.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) return false;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (!(SKILL_SCHEMA_KEYWORDS as readonly string[]).includes(key)) return false;
    if (key === 'properties') {
      if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return false;
      for (const child of Object.values(inner as Record<string, unknown>)) {
        if (!isSupportedSchema(child, depth + 1, seen)) return false;
      }
    } else if (key === 'items' || (key === 'additionalProperties' && typeof inner === 'object')) {
      if (!isSupportedSchema(inner, depth + 1, seen)) return false;
    }
  }
  return true;
}

export const skillJsonSchemaSchema = z
  .record(z.string(), z.unknown())
  .refine((schema) => isSupportedSchema(schema), { message: 'SCHEMA_NOT_SUPPORTED' });

/** What a package asks of a sandbox. `network` has one possible value (ADR-034 D3). */
const sandboxExecutionSchema = z.strictObject({
  kind: z.literal('sandbox'),
  runtime: z.literal('node24'),
  entry: skillPathSchema,
  network: z.strictObject({ mode: z.literal('none') }),
  limits: z.strictObject({
    wall_ms: z.int().min(100).max(600_000),
    cpu_ms: z.int().min(100).max(600_000),
    memory_mb: z.int().min(32).max(4096),
    tmpfs_mb: z.int().min(1).max(1024),
    output_kb: z.int().min(1).max(1024),
    pids: z.int().min(1).max(256),
  }),
});

/**
 * The manifest a publisher signs. Its hash is the package's digest, and because it lists every file with
 * its hash and size, signing it signs them all. `tool_boundaries` limits what the instructions may ask
 * for and grants nothing: tools still have their own authorization (principles: "skills describe
 * behaviour; tools execute capabilities"). Exact names and no ranges, so a version means one thing.
 */
export const skillManifestSchema = z
  .strictObject({
    schema_version: z.literal(1),
    name: skillName,
    version: semver,
    display_name: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(500),
    license: z.string().min(1).max(64),
    instructions: skillPathSchema,
    input_schema: skillJsonSchemaSchema,
    output_schema: skillJsonSchemaSchema,
    tool_boundaries: z.array(toolName).max(50),
    max_classification: z.enum(['public', 'internal', 'confidential']),
    /** Third-party code carried inside the bundle, by name, so it can be checked. Nothing is fetched. */
    dependencies: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(214),
          version: z.string().min(1).max(64),
          license: z.string().min(1).max(64),
        }),
      )
      .max(200),
    execution: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('declarative') }),
      sandboxExecutionSchema,
    ]),
    tests: z
      .array(
        z.strictObject({
          name: z.string().trim().min(1).max(120),
          input: skillPathSchema,
          expected_output: skillPathSchema,
        }),
      )
      .min(1)
      .max(50),
    files: z
      .array(
        z.strictObject({
          path: skillPathSchema,
          sha256: sha256Hex,
          size_bytes: z.int().min(0).max(8_388_608),
        }),
      )
      .min(1)
      .max(500),
  })
  .refine((manifest) => new Set(manifest.files.map((file) => file.path)).size === manifest.files.length, {
    path: ['files'],
    message: 'FILE_DUPLICATED',
  });
export type SkillManifest = z.infer<typeof skillManifestSchema>;

/** The whole package as one JSON document, so nothing here has to unpack an archive (ADR-034 D2). */
export const skillBundleSchema = z.strictObject({
  format: z.literal('ensemus.skill.bundle.v1'),
  manifest: skillManifestSchema,
  files: z.array(z.strictObject({ path: skillPathSchema, content_base64: base64 })).max(500),
  signature: z.strictObject({
    algorithm: z.literal('ed25519'),
    key_id: sha256Hex,
    value_base64: base64,
  }),
});
export type SkillBundle = z.infer<typeof skillBundleSchema>;

export const skillVersionStateSchema = z.enum([
  'uploaded',
  'verifying',
  'verified',
  'rejected',
  'published',
  'yanked',
]);
export const sandboxRunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'memory_exceeded',
  'output_exceeded',
  'denied',
  'cancelled',
  'runner_unavailable',
]);
export const submissionStateSchema = z.enum([
  'submitted',
  'in_review',
  'approved',
  'rejected',
  'withdrawn',
]);
export const listingStateSchema = z.enum(['listed', 'delisted']);
export const installationStateSchema = z.enum([
  'requested',
  'installing',
  'installed',
  'failed',
  'removed',
]);
export const isolationEvidenceSchema = z.enum(['none', 'probe_passed']);

// Requests.

export const createSkillPackageSchema = z.strictObject({
  name: skillName,
  display_name: z.string().trim().min(1).max(120),
  content_classification: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
});
export type CreateSkillPackageBody = z.infer<typeof createSkillPackageSchema>;

export const updateSkillPackageSchema = z
  .strictObject({
    display_name: z.string().trim().min(1).max(120).optional(),
    state: z.enum(['active', 'disabled']).optional(),
    content_classification: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0);
export type UpdateSkillPackageBody = z.infer<typeof updateSkillPackageSchema>;

export const addTrustedSignerSchema = z.strictObject({
  display_name: z.string().trim().min(1).max(120),
  /** A raw 32-byte Ed25519 public key, in base64. A private key has no field to go in. */
  public_key_base64: base64.max(64),
});
export type AddTrustedSignerBody = z.infer<typeof addTrustedSignerSchema>;

export const yankSkillVersionSchema = z.strictObject({
  code: z.enum(['WITHDRAWN_BY_OWNER', 'SECURITY_ISSUE']),
});
export type YankSkillVersionBody = z.infer<typeof yankSkillVersionSchema>;

export const requestSandboxTestRunSchema = z.strictObject({
  classification: z.enum(['public', 'internal', 'confidential']),
  input: z.unknown(),
});
export type RequestSandboxTestRunBody = z.infer<typeof requestSandboxTestRunSchema>;

export const createPublisherSchema = z.strictObject({
  display_name: z.string().trim().min(1).max(120),
});
export type CreatePublisherBody = z.infer<typeof createPublisherSchema>;

export const submitToMarketplaceSchema = z.strictObject({
  skill_version_id: z.uuid(),
  /** A person saying this package may be shown to every organization on this deployment. */
  confirm_share_with_other_organizations: z.literal(true),
});
export type SubmitToMarketplaceBody = z.infer<typeof submitToMarketplaceSchema>;

export const requestInstallationSchema = z.strictObject({ listing_id: z.uuid() });
export type RequestInstallationBody = z.infer<typeof requestInstallationSchema>;
