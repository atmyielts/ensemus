// One line of an organization archive, for each kind of record (COMM-05, ADR-030 D7). Export writes these
// and import reads them, and both go through these schemas, which is how the two slices agree. They are
// strict, so a new column reaches an archive only by a change here, and a credential has no field to sit in.
//
// There is no organization ID anywhere in a record. An archive cannot name a tenant, so a malicious one has
// nothing to aim with, and row-level security would refuse it anyway. Classification stops at confidential,
// because `standard` scope leaves restricted work out at both ends (ADR-030 D10).
import { z } from 'zod';

const EXPORT_SECTIONS = [
  'organizations',
  'people',
  'clients',
  'projects',
  'work',
  'relations',
  'artifacts',
  'history',
  'connections',
  'tombstones',
  'audit-redacted',
  'knowledge',
  'agents',
  'skills',
  'policy',
  'custom-objects',
] as const;

const id = z.uuid().refine((value) => value === value.toLowerCase());
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

// Authority-bearing records travel as definitions needing review, never as live publications,
// approvals, provider grants or verified facts. No whole database row or arbitrary config is accepted.
const definitionBase = { id, created_at: moment };
const ref = z
  .string()
  .regex(/^(client|project|membership|team|work_unit|knowledge_source):[0-9a-f-]{36}$/);
const spec = z.strictObject({
  api_version: z.literal('ensemus.ai/v1'),
  id: z.string().regex(/^[a-z][a-z0-9-]{2,80}$/),
  version: z.int().min(1),
  objective: z.string().min(10).max(1000),
  instructions: z.string().min(1).max(8000),
  model: z.strictObject({
    required_capabilities: z
      .array(z.enum(['text', 'tools', 'structured_output', 'vision', 'long_context']))
      .min(1),
    quality_tier: z.enum(['economy', 'balanced', 'high']),
    fallback: z.enum(['approved_profiles_only', 'disabled']),
  }),
  context: z.strictObject({
    allowed_scopes: z.array(z.string().max(300)).max(100),
    memory_write_policy: z.enum(['none', 'propose_only']),
    max_input_tokens: z.int().min(128).optional(),
  }),
  skills: z.array(z.string()).max(0).optional(),
  tools: z.strictObject({
    allow: z.array(z.string().max(200)).max(100),
    deny: z.array(z.string().max(200)).max(100).optional(),
  }),
  execution: z.strictObject({
    max_model_turns: z.int().min(1).max(100),
    max_tool_calls: z.int().min(0).max(500),
    max_total_tokens: z.int().min(1),
    max_cost_usd: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/),
    timeout_seconds: z.int().min(1),
    max_delegation_depth: z.int().min(0).max(5),
  }),
  output: z.strictObject({ schema_ref: text, verification: z.array(text).max(100) }),
  evaluation: z.strictObject({ suite_ref: text, min_pass_rate: z.number().min(0).max(1) }),
});
export const extensionRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('service_identity'),
    ...definitionBase,
    owner_membership_id: id,
    purpose: shortText,
  }),
  z.strictObject({
    kind: z.literal('agent_definition'),
    ...definitionBase,
    slug: z.string().regex(/^[a-z][a-z0-9-]{2,80}$/),
    name: z.string().min(1).max(120),
    owner_membership_id: id,
    service_identity_id: id,
  }),
  z.strictObject({
    kind: z.literal('agent_version'),
    id,
    definition_id: id,
    version_number: z.int().min(1),
    spec,
    spec_sha256: sha256,
    published_at: moment,
  }),
  z.strictObject({
    kind: z.literal('model_profile'),
    ...definitionBase,
    alias: shortText,
    model_id: shortText,
    provider_kind: z.enum([
      'openai_hosted',
      'anthropic_hosted',
      'openai_compatible',
      'local_openai_compatible',
    ]),
    billing_owner: z.enum(['customer', 'ensemus']),
    capabilities: z.array(shortText).max(30),
    allowed_classes: z.array(z.enum(['public', 'internal', 'confidential', 'restricted'])).max(4),
    allowed_purposes: z.array(shortText).max(30),
    limits: z.strictObject({ maxInputTokens: z.int().min(1), maxOutputTokens: z.int().min(1) }),
  }),
  z.strictObject({
    kind: z.literal('rate_card'),
    ...definitionBase,
    profile_id: id,
    version: z.int().min(1),
    input_micros_per_mtok: z.int().min(0),
    output_micros_per_mtok: z.int().min(0),
    effective_from: moment,
  }),
  z.strictObject({
    kind: z.literal('agent_run'),
    ...definitionBase,
    work_unit_id: id,
    agent_version_id: id,
    status: z.enum([
      'queued',
      'preparing',
      'running',
      'paused',
      'waiting_for_approval',
      'waiting_for_child',
      'verifying',
      'completed',
      'failed',
      'cancelled',
      'budget_exhausted',
      'policy_denied',
      'timed_out',
      'outcome_unverified',
    ]),
    effective_classification: classification,
    model_turns: z.int().min(0),
    tool_calls: z.int().min(0),
    input_tokens: z.int().min(0),
    output_tokens: z.int().min(0),
    cost_micros: z.int().min(0),
  }),
  z.strictObject({
    kind: z.literal('execution_step'),
    id,
    run_id: id,
    step_number: z.int().min(0),
    step_kind: z.enum([
      'prepare',
      'model_turn',
      'tool_call',
      'approval_wait',
      'delegation',
      'verification',
    ]),
    state: z.enum(['in_flight', 'completed', 'failed', 'cancelled']),
    label_code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    started_at: moment,
    work_unit_id: id,
  }),
  z.strictObject({
    kind: z.literal('agent_assignment'),
    id,
    work_unit_id: id,
    service_identity_id: id,
    agent_run_id: id,
    created_at: moment,
  }),
  z.strictObject({
    kind: z.literal('budget'),
    ...definitionBase,
    scope: z.enum(['organization', 'agent_version']),
    agent_version_id: id.nullable(),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    limit_micros: z.int().min(0),
  }),
  z.strictObject({
    kind: z.literal('usage_entry'),
    ...definitionBase,
    work_unit_id: id,
    run_id: id,
    meter: z.enum(['model_input_tokens', 'model_output_tokens', 'tool_call']),
    quantity: z.int(),
    cost_micros: z.int(),
    billing_period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    commercial_mode: z.enum(['cloud', 'byom', 'sovereign']),
  }),
  z.strictObject({
    kind: z.literal('policy_definition'),
    ...definitionBase,
    version: z.int().min(1),
    sha256,
    // Source text is a quarantined definition, never accepted by the policy engine on import.
    document_text: z.string().max(200_000),
  }),
  z.strictObject({
    kind: z.literal('external_resource'),
    id,
    connection_id: id,
    stream: shortText,
    resource_type: shortText,
    external_id: text,
    external_version: text.nullable(),
    display_name: shortText.nullable(),
    classification,
    first_seen_at: moment,
  }),
  z.strictObject({
    kind: z.literal('external_acl'),
    id,
    resource_id: id,
    principal_kind: z.enum(['user', 'group', 'domain', 'anyone']),
    principal_external_id: text,
    access: z.enum(['read', 'write', 'owner']),
    membership_id: id.nullable(),
    team_id: id.nullable(),
    updated_at: moment,
  }),
  z.strictObject({
    kind: z.literal('mcp_definition'),
    id,
    connection_id: id,
    tool_name: shortText,
    definition_sha256: sha256,
    first_seen_at: moment,
  }),
  z.strictObject({
    kind: z.literal('client_reader'),
    id,
    client_id: id,
    membership_id: id,
    created_at: moment,
  }),
  z.strictObject({
    kind: z.literal('action_attempt'),
    id,
    external_action_id: id,
    work_unit_id: id,
    attempt_no: z.int().min(1).max(5),
    request_hash: sha256,
    outcome: z.enum(['accepted', 'rejected', 'not_sent', 'indeterminate']).nullable(),
    recorded_at: moment,
    finished_at: moment.nullable(),
  }),
  z.strictObject({
    kind: z.literal('knowledge_source'),
    ...definitionBase,
    source_kind: z.enum(['upload', 'connector']),
    connection_id: id.nullable(),
    external_resource_id: id.nullable(),
    classification,
    owner_membership_id: id.nullable(),
  }),
  z.strictObject({
    kind: z.literal('source_grant'),
    ...definitionBase,
    source_id: id,
    principal_kind: z.enum(['membership', 'team', 'organization']),
    membership_id: id.nullable(),
    team_id: id.nullable(),
  }),
  z.strictObject({
    kind: z.literal('knowledge_document'),
    ...definitionBase,
    source_id: id,
    version_no: z.int().min(1),
    title: z.string().min(1).max(512),
    content_sha256: sha256,
    size_bytes: z.int().min(0).max(26214400),
    media_type: shortText,
    classification,
    source_version: text.nullable(),
    superseded_at: moment.nullable(),
  }),
  z.strictObject({
    kind: z.literal('embedding_space'),
    ...definitionBase,
    model_id: shortText,
    dimension: z.int().min(1).max(8192),
    vector_space_version: shortText,
  }),
  z.strictObject({
    kind: z.literal('fact_definition'),
    ...definitionBase,
    subject_ref: ref,
    predicate: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
    claim_text: z.string().max(16384),
    classification,
    source_ids: z.array(id).max(1000),
  }),
  z.strictObject({
    kind: z.literal('fact_evidence'),
    id,
    fact_id: id,
    source_id: id,
    chunk_id: id,
    content_sha256: sha256,
    quote_start: z.int().min(0),
    quote_end: z.int().min(1),
    created_at: moment,
  }),
  z.strictObject({
    kind: z.literal('graph_edge'),
    ...definitionBase,
    from_ref: ref,
    to_ref: ref,
    relation: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    fact_id: id.nullable(),
  }),
  z.strictObject({
    kind: z.literal('artifact_citation'),
    id,
    artifact_id: id,
    source_id: id,
    document_id: id,
    chunk_id: id,
    content_sha256: sha256,
    artifact_start: z.int().min(0),
    artifact_end: z.int().min(1),
    created_at: moment,
    work_unit_ids: z.array(id).max(1000),
  }),
]);
export type ExtensionRecord = z.infer<typeof extensionRecordSchema>;

export const EXTENSION_SECTION_KINDS = {
  agents: [
    'service_identity',
    'agent_definition',
    'agent_version',
    'model_profile',
    'rate_card',
    'agent_run',
    'execution_step',
    'agent_assignment',
  ],
  policy: ['budget', 'usage_entry', 'policy_definition'],
  knowledge: [
    'knowledge_source',
    'source_grant',
    'knowledge_document',
    'embedding_space',
    'fact_definition',
    'fact_evidence',
    'graph_edge',
    'artifact_citation',
  ],
  connections: ['external_resource', 'external_acl', 'mcp_definition'],
  clients: ['client_reader'],
  history: ['action_attempt'],
} as const;

export function validatePortableRecord(
  section: string,
  raw: unknown,
): CoreRecord | ExtensionRecord {
  const core = coreRecordSchema.safeParse(raw);
  if (core.success) return core.data;
  const extension = extensionRecordSchema.parse(raw);
  const allowed = EXTENSION_SECTION_KINDS[section as keyof typeof EXTENSION_SECTION_KINDS] as
    readonly string[] | undefined;
  if (!allowed?.includes(extension.kind)) throw new Error('RECORD_REFUSED');
  return extension;
}

const sectionTotals = z.strictObject({ records: z.int().min(0), parts: z.int().min(0) });

/** The first thing an import reads, sealed like everything else. */
const manifestV1Schema = z.strictObject({
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
const manifestV2Schema = manifestV1Schema.extend({
  schema_version: z.literal(2),
  inventory_version: z.enum(['ensemus.m3-m5/1', 'ensemus.m3-m5/2']),
  generated_bodies_excluded: z.int().min(0),
  inventory: z
    .array(
      z.strictObject({
        table: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
        section: z.enum(EXPORT_SECTIONS),
        disposition: z.enum([
          'records',
          'quarantined',
          'original_bytes',
          'rebuild',
          'private_excluded',
          'credentials_excluded',
          'operational_excluded',
        ]),
        version: z.literal(1),
      }),
    )
    .max(200),
});
export const exportManifestSchema = z
  .discriminatedUnion('schema_version', [manifestV1Schema, manifestV2Schema])
  .superRefine((value, ctx) => {
    const names = Object.keys(value.sections);
    if (
      names.length !== EXPORT_SECTIONS.length ||
      EXPORT_SECTIONS.some((name) => !names.includes(name))
    )
      ctx.addIssue({ code: 'custom', message: 'Incomplete section inventory' });
    for (const name of EXPORT_SECTIONS) {
      const parts = value.parts.filter((part) => part.section === name);
      const counts = value.sections[name];
      if (
        !counts ||
        counts.parts !== parts.length ||
        counts.records !== parts.reduce((sum, part) => sum + part.records, 0)
      )
        ctx.addIssue({ code: 'custom', message: 'Section totals differ' });
    }
    if (value.parts.some((part) => !(EXPORT_SECTIONS as readonly string[]).includes(part.section)))
      ctx.addIssue({ code: 'custom', message: 'Unknown section' });
    if (
      value.schema_version === 1 &&
      ['knowledge', 'agents', 'skills', 'policy', 'custom-objects'].some(
        (name) => value.sections[name]?.parts !== 0,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Legacy archives carry only core inert records' });
    if (value.sections['custom-objects']?.parts !== 0 || value.sections.skills?.parts !== 0)
      ctx.addIssue({ code: 'custom', message: 'Section absent from this inventory profile' });
  });
export type ExportManifest = z.infer<typeof exportManifestSchema>;
