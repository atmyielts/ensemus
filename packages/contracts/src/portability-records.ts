// One line of an organization archive, for each kind of record (COMM-05, ADR-030 D7). Export writes these
// and import reads them, and both go through these schemas, which is how the two slices agree. They are
// strict, so a new column reaches an archive only by a change here, and a credential has no field to sit in.
//
// There is no organization ID anywhere in a record. An archive cannot name a tenant, so a malicious one has
// nothing to aim with, and row-level security would refuse it anyway. Classification stops at confidential,
// because `standard` scope leaves restricted work out at both ends (ADR-030 D10).
import { z } from 'zod';

const id = z.uuid();
const moment = z.iso.datetime({ offset: true });
const text = z.string().max(10_000);
const longText = z.string().max(200_000);
const shortText = z.string().trim().min(1).max(300);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const classification = z.enum(['public', 'internal', 'confidential']);

export const organizationRecordSchema = z.strictObject({
  kind: z.literal('organization'),
  name: shortText,
  commercial_mode: z.enum(['cloud', 'byom', 'sovereign']),
  created_at: moment,
});

/** Someone at the source. Their password, sessions and accounts are never in an archive. */
export const personRecordSchema = z.strictObject({
  kind: z.literal('person'),
  membership_id: id,
  display_name: shortText,
  email: z.email().max(254),
  role: z.enum(['owner', 'admin', 'member']),
  status: z.enum(['invited', 'active', 'disabled']),
  created_at: moment,
});

export const teamRecordSchema = z.strictObject({
  kind: z.literal('team'),
  id,
  parent_id: id.nullable(),
  name: shortText,
  created_at: moment,
});

export const teamMembershipRecordSchema = z.strictObject({
  kind: z.literal('team_membership'),
  team_id: id,
  membership_id: id,
});

export const clientRecordSchema = z.strictObject({
  kind: z.literal('client'),
  id,
  display_name: shortText,
  classification,
  created_at: moment,
});

export const projectRecordSchema = z.strictObject({
  kind: z.literal('project'),
  id,
  client_id: id.nullable(),
  name: shortText,
  created_at: moment,
});

/** The Work Unit as it stood. Which run held it is left out, because no run here does. */
export const workUnitRecordSchema = z.strictObject({
  kind: z.literal('work_unit'),
  id,
  project_id: id.nullable(),
  parent_id: id.nullable(),
  owner_membership_id: id,
  created_by_membership_id: id.nullable(),
  title: shortText,
  objective: longText.nullable(),
  status: z.enum([
    'queued',
    'ready',
    'running',
    'blocked',
    'awaiting_approval',
    'verifying',
    'completed',
    'failed',
    'cancelled',
  ]),
  completion_criteria: z.json(),
  execution_plan: text.nullable(),
  classification,
  due_at: moment.nullable(),
  created_at: moment,
  updated_at: moment,
});

export const workDependencyRecordSchema = z.strictObject({
  kind: z.literal('work_dependency'),
  prerequisite_id: id,
  dependent_id: id,
});

export const workAssignmentRecordSchema = z.strictObject({
  kind: z.literal('work_assignment'),
  work_unit_id: id,
  membership_id: id,
  responsibility: z.enum(['contributor', 'reviewer']),
  actor_type: z.enum(['human', 'agent']),
});

/** A file's facts. Its bytes are their own part, at `artifactPartPath(id)`, with this hash to check. */
export const artifactRecordSchema = z.strictObject({
  kind: z.literal('artifact'),
  id,
  name: shortText,
  sha256,
  mime_type: z.string().min(1).max(255),
  size_bytes: z.int().min(0),
  classification,
  created_by_membership_id: id.nullable(),
  created_at: moment,
});

export const workArtifactRecordSchema = z.strictObject({
  kind: z.literal('work_artifact'),
  work_unit_id: id,
  artifact_id: id,
});

/** What the deleted things were, so an import can keep them deleted. IDs, a type and a time, like the ledger. */
export const tombstoneRecordSchema = z.strictObject({
  kind: z.literal('tombstone'),
  target_type: z.string().regex(/^[a-z_]+$/),
  target_id: id,
  deleted_at: moment,
});

/**
 * A connection's identity. No credential, no secret ID and no signing secret. It comes back disabled, and
 * someone authorized binds a new credential (docs/07-commercial/03-data-portability-and-exit.md section 3).
 */
export const connectionRecordSchema = z.strictObject({
  kind: z.literal('connection'),
  id,
  connector_type: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  display_name: shortText,
  granted_scopes: z.array(z.string().max(200)).max(200),
  created_at: moment,
});

/** Kept read-only on import, and never made live (ADR-030 D9). */
export const historyRecordSchema = z.strictObject({
  kind: z.literal('history'),
  record_type: z.enum([
    'approval',
    'approval_decision',
    'work_transition',
    'external_action',
    'external_action_receipt',
    'audit_event',
  ]),
  source_id: id,
  work_unit_id: id.nullable(),
  occurred_at: moment,
  record: z.json(),
});

export const coreRecordSchema = z.discriminatedUnion('kind', [
  organizationRecordSchema,
  personRecordSchema,
  teamRecordSchema,
  teamMembershipRecordSchema,
  clientRecordSchema,
  projectRecordSchema,
  workUnitRecordSchema,
  workDependencyRecordSchema,
  workAssignmentRecordSchema,
  artifactRecordSchema,
  workArtifactRecordSchema,
  tombstoneRecordSchema,
  connectionRecordSchema,
  historyRecordSchema,
]);
export type CoreRecord = z.infer<typeof coreRecordSchema>;

const sectionTotals = z.strictObject({ records: z.int().min(0), parts: z.int().min(0) });

/** The first thing an import reads, sealed like everything else. */
export const exportManifestSchema = z.strictObject({
  format: z.literal('ensemus.organization_export'),
  schema_version: z.literal(1),
  export_id: id,
  organization_id: id,
  exported_at: moment,
  snapshot_at: moment,
  tombstones_through: moment,
  initiated_by_membership_id: id,
  source_release: z.string().min(1).max(64),
  scope: z.literal('standard'),
  /** What was left out, so nothing is missing silently. */
  excluded: z.strictObject({
    restricted_work: z.int().min(0),
    restricted_artifacts: z.int().min(0),
    restricted_clients: z.int().min(0),
  }),
  sections: z.record(z.string(), sectionTotals),
  parts: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(100),
        section: z.string().min(1).max(64),
        records: z.int().min(0),
        plaintext_sha256: sha256,
        sealed_sha256: sha256,
        sealed_bytes: z.int().min(0),
      }),
    )
    .max(1_000_000),
  encryption: z.strictObject({
    scheme: z.literal('ensemus.sealed/v1'),
    recipient_key_id: z.string().regex(/^[0-9a-f]{32}$/),
  }),
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;
