// Runtime contracts for tiers and residency (ADR-035 D5 and D6). The shapes match
// docs/specifications/openapi.yaml. They report what an operator declared and what a probe found, and carry
// no certification, no service level and no promise.
import { z } from 'zod';

export const tenancyTierSchema = z.enum(['shared', 'dedicated']);
export const residencySurfaceSchema = z.enum([
  'storage',
  'backups',
  'support',
  'embeddings',
  'inference',
  'telemetry',
]);
export const residencyScopeSchema = z.enum([
  'all',
  'public',
  'internal',
  'confidential',
  'restricted',
]);
export const isolationAspectSchema = z.enum([
  'database',
  'network',
  'worker_pool',
  'temporal_namespace',
  'object_store',
  'backups',
  'embeddings',
  'telemetry',
  'key_encryption_key',
]);

export const setResidencyRequirementSchema = z.strictObject({
  scope: residencyScopeSchema,
  /** Null removes it. A region this deployment is not in is refused. */
  region: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,31}$/)
    .nullable(),
  expected_version: z.int().min(0),
});
export type SetResidencyRequirementBody = z.infer<typeof setResidencyRequirementSchema>;
