// The organization archive's rules (COMM-05, ADR-030 D7-D10). Pure, so export, import and the operator's
// tools agree on every name, and a path in an archive can only ever be one this module would have made.

/** Follows docs/07-commercial/03-data-portability-and-exit.md section 2, plus what an import needs. */
export const EXPORT_SECTIONS = [
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
  // Each belongs to a later milestone's tables, which fill it through the PortabilitySection port.
  'knowledge',
  'agents',
  'skills',
  'policy',
  'custom-objects',
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

/** The sections the core reads and writes itself. The rest arrive through the port or stay empty. */
export const CORE_EXPORT_SECTIONS = [
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
] as const satisfies readonly ExportSection[];
export type CoreExportSection = (typeof CORE_EXPORT_SECTIONS)[number];

/** Frozen source sections for the M3-M5 inventory profiles. */
export const LEGACY_PORTABLE_SOURCE_SECTIONS = [
  ...CORE_EXPORT_SECTIONS,
  'knowledge',
  'agents',
  'skills',
  'policy',
] as const;
export const LEGACY_PORTABILITY_INVENTORY_VERSION = 'ensemus.m3-m5/1' as const;
export const PORTABILITY_INVENTORY_V2_VERSION = 'ensemus.m3-m5/2' as const;
export const PORTABILITY_INVENTORY_VERSION = 'ensemus.m3-m7/3' as const;
export const PORTABLE_SOURCE_SECTIONS = [
  ...LEGACY_PORTABLE_SOURCE_SECTIONS,
  'custom-objects',
] as const;
type InventoryDisposition =
  | 'records'
  | 'quarantined'
  | 'original_bytes'
  | 'rebuild'
  | 'private_excluded'
  | 'credentials_excluded'
  | 'operational_excluded';
const inventory = (table: string, section: ExportSection, disposition: InventoryDisposition) => ({
  table,
  section,
  disposition,
  version: 1 as const,
});

/** This is a reviewed source-table inventory, not a catalog query that exports new columns by accident.
 * Unknown schemas fail at composition; adding a source table requires a new inventory profile. */
export const PORTABILITY_INVENTORY_V1 = [
  inventory('org.organizations', 'organizations', 'records'),
  inventory('org.memberships', 'people', 'records'),
  inventory('org.teams', 'people', 'records'),
  inventory('org.team_memberships', 'people', 'records'),
  inventory('work.clients', 'clients', 'records'),
  inventory('work.client_readers', 'clients', 'quarantined'),
  inventory('work.projects', 'projects', 'records'),
  inventory('work.work_units', 'work', 'records'),
  inventory('work.work_dependencies', 'relations', 'records'),
  inventory('work.work_assignments', 'relations', 'records'),
  inventory('work.artifacts', 'artifacts', 'original_bytes'),
  inventory('work.work_artifacts', 'relations', 'records'),
  inventory('work.approvals', 'history', 'quarantined'),
  inventory('work.approval_decisions', 'history', 'quarantined'),
  inventory('work.work_transitions', 'history', 'quarantined'),
  inventory('platform.tombstones', 'tombstones', 'records'),
  inventory('governance.audit_events', 'audit-redacted', 'quarantined'),
  inventory('integrations.connections', 'connections', 'records'),
  inventory('integrations.external_resources', 'connections', 'quarantined'),
  inventory('integrations.external_resource_acl', 'connections', 'quarantined'),
  inventory('integrations.sync_cursors', 'connections', 'operational_excluded'),
  inventory('integrations.external_actions', 'history', 'quarantined'),
  inventory('integrations.external_action_attempts', 'history', 'quarantined'),
  inventory('integrations.external_action_receipts', 'history', 'quarantined'),
  inventory('integrations.webhook_endpoints', 'connections', 'credentials_excluded'),
  inventory('integrations.webhook_deliveries', 'connections', 'private_excluded'),
  inventory('integrations.mcp_tools', 'connections', 'quarantined'),
  inventory('org.service_identities', 'agents', 'quarantined'),
  inventory('ai.model_profiles', 'agents', 'quarantined'),
  inventory('ai.rate_cards', 'agents', 'quarantined'),
  inventory('ai.model_evaluations', 'agents', 'operational_excluded'),
  inventory('ai.agent_definitions', 'agents', 'quarantined'),
  inventory('ai.agent_versions', 'agents', 'quarantined'),
  inventory('ai.agent_publications', 'agents', 'operational_excluded'),
  inventory('ai.agent_runs', 'agents', 'quarantined'),
  inventory('ai.run_controls', 'agents', 'operational_excluded'),
  inventory('ai.execution_steps', 'agents', 'quarantined'),
  inventory('ai.step_payloads', 'agents', 'private_excluded'),
  inventory('ai.tool_proposals', 'agents', 'private_excluded'),
  inventory('ai.artifact_evidence', 'agents', 'operational_excluded'),
  inventory('work.agent_assignments', 'agents', 'quarantined'),
  inventory('platform.budgets', 'policy', 'quarantined'),
  inventory('platform.budget_reservations', 'policy', 'operational_excluded'),
  inventory('platform.usage_ledger', 'policy', 'quarantined'),
  inventory('platform.entitlements', 'policy', 'operational_excluded'),
  inventory('governance.egress_decisions', 'policy', 'operational_excluded'),
  inventory('governance.policy_bundles', 'policy', 'quarantined'),
  inventory('governance.kill_switches', 'policy', 'operational_excluded'),
  inventory('knowledge.sources', 'knowledge', 'records'),
  inventory('knowledge.source_grants', 'knowledge', 'records'),
  inventory('knowledge.documents', 'knowledge', 'original_bytes'),
  inventory('knowledge.document_staging', 'knowledge', 'operational_excluded'),
  inventory('knowledge.object_writers', 'knowledge', 'operational_excluded'),
  inventory('knowledge.chunks', 'knowledge', 'rebuild'),
  inventory('knowledge.embedding_spaces', 'knowledge', 'quarantined'),
  inventory('knowledge.embeddings', 'knowledge', 'rebuild'),
  inventory('knowledge.facts', 'knowledge', 'quarantined'),
  inventory('knowledge.fact_evidence', 'knowledge', 'quarantined'),
  inventory('knowledge.edges', 'knowledge', 'quarantined'),
  inventory('knowledge.evidence_packages', 'knowledge', 'private_excluded'),
  inventory('knowledge.evidence_items', 'knowledge', 'private_excluded'),
  inventory('knowledge.answers', 'knowledge', 'private_excluded'),
  inventory('knowledge.answer_sources', 'knowledge', 'private_excluded'),
  inventory('knowledge.answer_citations', 'knowledge', 'private_excluded'),
  inventory('knowledge.artifact_citations', 'knowledge', 'quarantined'),
  inventory('knowledge.artifact_verifications', 'knowledge', 'operational_excluded'),
  inventory('knowledge.purge_jobs', 'knowledge', 'operational_excluded'),
  inventory('knowledge.model_calls', 'knowledge', 'operational_excluded'),
  inventory('knowledge.artifact_acl_catalog', 'artifacts', 'operational_excluded'),
  inventory('knowledge.artifact_work_links', 'artifacts', 'operational_excluded'),
  inventory('knowledge.artifact_lineage', 'artifacts', 'operational_excluded'),
  inventory('knowledge.artifact_lineage_sources', 'artifacts', 'operational_excluded'),
  inventory('knowledge.artifact_lineage_packages', 'artifacts', 'operational_excluded'),
  inventory('knowledge.artifact_lineage_inputs', 'artifacts', 'operational_excluded'),
  inventory('knowledge.artifact_lineage_records', 'artifacts', 'operational_excluded'),
  inventory('knowledge.structured_record_catalog', 'artifacts', 'operational_excluded'),
  inventory('knowledge.structured_work_assignments', 'artifacts', 'operational_excluded'),
  inventory('work.client_onboardings', 'history', 'private_excluded'),
  inventory('secrets.sealed_secrets', 'connections', 'credentials_excluded'),
] as const;

/**0214 is durable execution safety metadata, not portable execution authority. Observations contain
 * sensitive read relationships; neither those IDs/hashes nor fence/write tokens become import records. */
export const PORTABILITY_INVENTORY_V2 = [
  ...PORTABILITY_INVENTORY_V1,
  inventory('ai.run_input_checkpoints', 'agents', 'operational_excluded'),
  inventory('ai.run_input_observations', 'agents', 'private_excluded'),
  inventory('ai.run_output_writes', 'agents', 'operational_excluded'),
] as const;

/** Joined /3 is a new meaning. /1 and /2 above stay byte-for-byte semantic inventories. Private
 * identity, execution, approvals and reconstruction metadata are never restored as authority.
 * Business projections below are strict column/shape readers; their imports are inert quarantine. */
export const PORTABILITY_INVENTORY = [
  ...PORTABILITY_INVENTORY_V2,
  inventory('identity.users', 'people', 'records'),
  inventory('identity.sessions', 'people', 'credentials_excluded'),
  inventory('identity.accounts', 'people', 'credentials_excluded'),
  inventory('identity.setup_tokens', 'people', 'credentials_excluded'),
  inventory('identity.verifications', 'people', 'credentials_excluded'),
  inventory('identity.rate_limits', 'people', 'operational_excluded'),
  inventory('identity.two_factors', 'people', 'credentials_excluded'),
  inventory('identity.sso_providers', 'people', 'credentials_excluded'),
  inventory('identity.session_assurances', 'people', 'operational_excluded'),
  inventory('ai.model_operation_qualifications', 'agents', 'operational_excluded'),
  inventory('ai.model_workload_approvals', 'policy', 'operational_excluded'),
  inventory('ai.model_workload_profiles', 'policy', 'operational_excluded'),
  inventory('ai.model_jobs', 'agents', 'operational_excluded'),
  inventory('ai.model_call_attempts', 'agents', 'operational_excluded'),
  inventory('ai.model_call_inputs', 'agents', 'private_excluded'),
  inventory('ai.model_job_payloads', 'agents', 'private_excluded'),
  inventory('ai.unproven_child_work_inputs', 'agents', 'operational_excluded'),
  inventory('ai.main_input_snapshots', 'agents', 'operational_excluded'),
  inventory('ai.model_proposal_inputs', 'agents', 'operational_excluded'),
  inventory('knowledge.evidence_package_facts', 'agents', 'private_excluded'),
  inventory('org.security_policies', 'policy', 'quarantined'),
  inventory('org.sso_connections', 'people', 'credentials_excluded'),
  inventory('org.sso_member_links', 'people', 'private_excluded'),
  inventory('org.scim_tokens', 'people', 'credentials_excluded'),
  inventory('org.invitations', 'people', 'credentials_excluded'),
  inventory('platform.blob_lifecycle', 'artifacts', 'operational_excluded'),
  inventory('platform.domain_events', 'history', 'operational_excluded'),
  inventory('platform.idempotency_keys', 'history', 'operational_excluded'),
  inventory('platform.inbox_events', 'history', 'operational_excluded'),
  inventory('platform.outbox_events', 'history', 'operational_excluded'),
  inventory('platform.notifications', 'people', 'private_excluded'),
  inventory('studio.agent_drafts', 'agents', 'quarantined'),
  inventory('studio.process_drafts', 'agents', 'quarantined'),
  inventory('studio.process_specs', 'agents', 'quarantined'),
  inventory('studio.simulation_runs', 'agents', 'private_excluded'),
  inventory('studio.simulation_inputs', 'agents', 'operational_excluded'),
  inventory('studio.publish_reviews', 'agents', 'operational_excluded'),
  inventory('studio.process_runs', 'agents', 'operational_excluded'),
  inventory('studio.process_run_steps', 'agents', 'operational_excluded'),
  inventory('studio.process_run_intents', 'agents', 'operational_excluded'),
  inventory('studio.process_step_births', 'agents', 'operational_excluded'),
  inventory('objects.types', 'custom-objects', 'quarantined'),
  inventory('objects.type_versions', 'custom-objects', 'quarantined'),
  inventory('objects.records', 'custom-objects', 'quarantined'),
  inventory('objects.relations', 'custom-objects', 'quarantined'),
  inventory('objects.record_values', 'custom-objects', 'rebuild'),
  inventory('objects.type_acl_catalog', 'custom-objects', 'rebuild'),
  inventory('objects.migrations', 'custom-objects', 'operational_excluded'),
  inventory('objects.migration_results', 'custom-objects', 'operational_excluded'),
  inventory('objects.relation_slots', 'custom-objects', 'operational_excluded'),
  inventory('packs.installations', 'agents', 'quarantined'),
  inventory('packs.installed_items', 'agents', 'quarantined'),
  inventory('packs.capability_reviews', 'agents', 'operational_excluded'),
  inventory('experience.pulse_signal_states', 'policy', 'private_excluded'),
  inventory('experience.outcome_drafts', 'agents', 'private_excluded'),
  inventory('experience.onboarding_steps', 'policy', 'operational_excluded'),
  // Signed license custody is a separate operator file flow, not a grant restored from an archive.
  inventory('sovereign.license_records', 'policy', 'operational_excluded'),
  inventory('sovereign.signed_documents', 'policy', 'operational_excluded'),
  inventory('sovereign.organization_exports', 'history', 'operational_excluded'),
  inventory('sovereign.organization_export_parts', 'history', 'operational_excluded'),
  inventory('sovereign.organization_imports', 'history', 'operational_excluded'),
  inventory('sovereign.organization_import_parts', 'history', 'operational_excluded'),
  inventory('sovereign.imported_people', 'people', 'private_excluded'),
  inventory('sovereign.imported_records', 'history', 'private_excluded'),
  inventory('sovereign.imported_definitions', 'history', 'private_excluded'),
  inventory('sovereign.export_epochs', 'history', 'operational_excluded'),
  inventory('sovereign.organization_import_manifests', 'history', 'operational_excluded'),
  inventory('sovereign.organization_import_effects', 'history', 'operational_excluded'),
  inventory('sovereign.imported_archive_files', 'artifacts', 'operational_excluded'),
  inventory('billing.rate_cards', 'history', 'operational_excluded'),
  inventory('billing.rate_card_lines', 'history', 'operational_excluded'),
  inventory('billing.top_up_offers', 'history', 'operational_excluded'),
  inventory('billing.plans', 'history', 'operational_excluded'),
  inventory('billing.plan_versions', 'history', 'operational_excluded'),
  inventory('billing.collection_policies', 'history', 'operational_excluded'),
  inventory('billing.tax_treatments', 'history', 'operational_excluded'),
  inventory('billing.provider_bills', 'history', 'operational_excluded'),
  inventory('billing.operator_actions', 'history', 'operational_excluded'),
  inventory('billing.billing_accounts', 'history', 'operational_excluded'),
  inventory('billing.subscriptions', 'history', 'operational_excluded'),
  inventory('billing.subscription_changes', 'history', 'operational_excluded'),
  inventory('billing.standing_changes', 'history', 'operational_excluded'),
  inventory('billing.billing_periods', 'history', 'operational_excluded'),
  inventory('billing.credit_accounts', 'history', 'operational_excluded'),
  inventory('billing.top_ups', 'history', 'operational_excluded'),
  inventory('billing.credit_ledger', 'history', 'operational_excluded'),
  inventory('billing.invoices', 'history', 'operational_excluded'),
  inventory('billing.invoice_lines', 'history', 'operational_excluded'),
  inventory('billing.payments', 'history', 'operational_excluded'),
  inventory('billing.payment_attempts', 'history', 'operational_excluded'),
  inventory('billing.payment_events', 'history', 'operational_excluded'),
  inventory('billing.payment_webhook_events', 'history', 'operational_excluded'),
  inventory('billing.collection_cases', 'history', 'operational_excluded'),
  inventory('lifecycle.retention_rules', 'history', 'operational_excluded'),
  inventory('lifecycle.retention_runs', 'history', 'operational_excluded'),
  inventory('lifecycle.legal_holds', 'history', 'operational_excluded'),
  inventory('lifecycle.legal_hold_scopes', 'history', 'operational_excluded'),
  inventory('lifecycle.offboardings', 'history', 'operational_excluded'),
  inventory('lifecycle.erasure_log', 'history', 'operational_excluded'),
  inventory('support.coverage_schedules', 'history', 'operational_excluded'),
  inventory('support.tickets', 'history', 'operational_excluded'),
  inventory('support.ticket_messages', 'history', 'operational_excluded'),
  inventory('support.break_glass_requests', 'history', 'operational_excluded'),
  inventory('support.break_glass_log', 'history', 'operational_excluded'),
  inventory('operations.incidents', 'history', 'operational_excluded'),
  inventory('operations.incident_updates', 'history', 'operational_excluded'),
  inventory('operations.drills', 'history', 'operational_excluded'),
  inventory('operations.vulnerability_reports', 'history', 'operational_excluded'),
  inventory('lifecycle.retention_cursors', 'history', 'operational_excluded'),
  inventory('lifecycle.offboarding_agent_stops', 'history', 'operational_excluded'),
  inventory('lifecycle.offboarding_admissions', 'history', 'operational_excluded'),
  inventory('lifecycle.standing_stop_receipts', 'history', 'operational_excluded'),
  inventory('lifecycle.object_restore_debts', 'history', 'operational_excluded'),
  inventory('lifecycle.object_deletion_claims', 'history', 'operational_excluded'),
  // Reviewed 0417/0419/0515 execution and material-cleanup evidence is never portable authority.
  inventory('ai.run_authority_checkpoints', 'agents', 'operational_excluded'),
  inventory('ai.run_read_authorities', 'agents', 'operational_excluded'),
  inventory('ai.delegated_input_receipts', 'agents', 'operational_excluded'),
  inventory('ai.delegated_input_refs', 'agents', 'operational_excluded'),
  inventory('ai.delegated_work_births', 'agents', 'operational_excluded'),
  inventory('knowledge.artifact_authority_receipts', 'artifacts', 'operational_excluded'),
  inventory('knowledge.artifact_authority_refs', 'artifacts', 'operational_excluded'),
  inventory('ai.source_run_closures', 'knowledge', 'operational_excluded'),
  inventory('ai.record_purge_jobs', 'knowledge', 'operational_excluded'),
  inventory('ai.record_run_closures', 'knowledge', 'operational_excluded'),
  inventory('lifecycle.delegated_erasure_receipts', 'history', 'operational_excluded'),
  // Native payment witnesses retain original IDs/hashes, never an imported live credential/route.
  inventory('billing.payment_identity_attestations', 'history', 'operational_excluded'),
  inventory('billing.payment_execution_bindings', 'history', 'operational_excluded'),
  inventory('billing.payment_customer_bindings', 'history', 'operational_excluded'),
  inventory('billing.payment_webhook_bindings', 'history', 'operational_excluded'),
  inventory('billing.payment_webhook_attestations', 'history', 'operational_excluded'),
  // Raw byte/writer debt survives header loss. Import cannot recreate or clear native erasure proof.
  inventory('lifecycle.raw_source_inventories', 'knowledge', 'operational_excluded'),
  inventory('lifecycle.raw_object_writes', 'knowledge', 'operational_excluded'),
  inventory('experience.onboarding_completions', 'policy', 'operational_excluded'),
  inventory('experience.outcome_work_births', 'policy', 'operational_excluded'),
  // 0539 upload writer receipts and 0541 one-transaction tombstone grants are native erasure and
  // writer proof. An archive never carries them, and an import never recreates or clears them.
  inventory('lifecycle.upload_writes', 'history', 'operational_excluded'),
  inventory('lifecycle.erasure_tombstone_grants', 'history', 'operational_excluded'),
  // 0543 restore-debt requalification proofs are bound to this deployment's material generation.
  // An archive never carries them, and an import never recreates or clears restore debt.
  inventory('lifecycle.object_restore_requalifications', 'history', 'operational_excluded'),
  inventory('lifecycle.raw_restore_requalifications', 'knowledge', 'operational_excluded'),
  // 0545 archive restore-debt proofs and raw organization marker re-admissions, bound the same way.
  inventory('lifecycle.archive_restore_requalifications', 'history', 'operational_excluded'),
  inventory('lifecycle.raw_org_restore_requalifications', 'knowledge', 'operational_excluded'),
  // 0548_deleg (ADR-028 open question 12): the deployment's delegation capability ledger. It is global
  // deployment evidence with no tenant column, written only by reviewed migrations; an archive never
  // carries it, and an import can never turn delegated child birth on.
  inventory('ai.delegation_birth_capabilities', 'agents', 'operational_excluded'),
  // 0550 re-proofs of an active source a restore left in raw debt, bound the same way.
  inventory('lifecycle.raw_active_source_requalifications', 'knowledge', 'operational_excluded'),
  // 0551 closure observations of an active source a restore left in raw debt with a missing or
  // changed object, bound the same way. Evidence for its closure only, never a write proof.
  inventory(
    'lifecycle.raw_active_source_closure_observations',
    'knowledge',
    'operational_excluded',
  ),
  // 0560 (ADR-038). A consent attempt names sealed verifiers, codes and clients, and an import must never
  // replay one. Directory groups are the provider's, rebuilt by the next directory pass, never imported.
  inventory('integrations.oauth_authorizations', 'connections', 'credentials_excluded'),
  inventory('integrations.directory_groups', 'connections', 'operational_excluded'),
] as const;

export const PORTABILITY_INVENTORY_PROFILES = {
  [LEGACY_PORTABILITY_INVENTORY_VERSION]: PORTABILITY_INVENTORY_V1,
  [PORTABILITY_INVENTORY_V2_VERSION]: PORTABILITY_INVENTORY_V2,
  [PORTABILITY_INVENTORY_VERSION]: PORTABILITY_INVENTORY,
} as const;

export function matchesPortabilityInventory(
  value: unknown,
  profile: unknown = PORTABILITY_INVENTORY_VERSION,
): boolean {
  if (
    typeof profile !== 'string' ||
    !Object.prototype.hasOwnProperty.call(PORTABILITY_INVENTORY_PROFILES, profile)
  )
    return false;
  const expectedInventory =
    PORTABILITY_INVENTORY_PROFILES[profile as keyof typeof PORTABILITY_INVENTORY_PROFILES];
  if (!Array.isArray(value) || value.length !== expectedInventory.length) return false;
  const seen = new Set<string>();
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(',') !== 'disposition,section,table,version' ||
      typeof entry.table !== 'string' ||
      seen.has(entry.table)
    )
      return false;
    seen.add(entry.table);
    const expected = expectedInventory.find((item) => item.table === entry.table);
    if (
      !expected ||
      entry.section !== expected.section ||
      entry.disposition !== expected.disposition ||
      entry.version !== expected.version
    )
      return false;
  }
  return true;
}

export function assertPortabilitySections(
  sections: readonly string[],
  profile: string = PORTABILITY_INVENTORY_VERSION,
): void {
  const supplied = new Set(sections);
  const required: readonly string[] =
    profile === PORTABILITY_INVENTORY_VERSION
      ? PORTABLE_SOURCE_SECTIONS
      : LEGACY_PORTABLE_SOURCE_SECTIONS;
  if (
    !Object.hasOwn(PORTABILITY_INVENTORY_PROFILES, profile) ||
    supplied.size !== sections.length ||
    sections.some((name) => !(PORTABLE_SOURCE_SECTIONS as readonly string[]).includes(name)) ||
    required.some((name) => !supplied.has(name))
  ) {
    throw new Error('PORTABILITY_INVENTORY_INCOMPLETE');
  }
}

export const EXPORT_MANIFEST_PATH = 'manifest.json.sealed';
export const EXPORT_OBJECT_PREFIX = 'organization-exports/v1/';

/** One sealed part holds at most this much plain text, which also bounds what a worker holds in memory. */
export const MAX_PART_PLAINTEXT_BYTES = 32 * 1024 * 1024;
export const MAX_RECORDS_PER_PART = 5_000;
export const MAX_RECORD_BYTES = 1024 * 1024;
/** Only joined /3 expands this bound for legal immutable custom schemas; older inventories stay1MiB. */
export const MAX_JOINED_RECORD_BYTES = 4 * 1024 * 1024;
export function portableRecordByteLimit(profile: string | null | undefined): number {
  if (profile === PORTABILITY_INVENTORY_VERSION) return MAX_JOINED_RECORD_BYTES;
  if (
    profile === null ||
    profile === undefined ||
    profile === LEGACY_PORTABILITY_INVENTORY_VERSION ||
    profile === PORTABILITY_INVENTORY_V2_VERSION
  )
    return MAX_RECORD_BYTES;
  throw new Error('FORMAT_NOT_SUPPORTED');
}
export const MAX_ARCHIVE_PARTS = 1_000_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IS_UUID = new RegExp(`^${UUID}$`);
const PART = /^([a-z-]+)\/([a-z_]+-\d{6}\.jsonl|[0-9a-f-]{36}\.bin)\.sealed$/;

export const isExportSection = (value: string): value is ExportSection =>
  (EXPORT_SECTIONS as readonly string[]).includes(value);

/** `work/work_units-000001.jsonl.sealed`. Throws on anything that would not read back. */
export function recordPartPath(section: ExportSection, recordKind: string, sequence: number) {
  if (!/^[a-z_]+$/.test(recordKind) || !Number.isInteger(sequence) || sequence < 1) {
    throw new Error('Not a valid part');
  }
  return `${section}/${recordKind}-${String(sequence).padStart(6, '0')}.jsonl.sealed`;
}

/** `artifacts/{id}.bin.sealed`. The artifact's own ID, so a name never reaches a path. */
export function artifactPartPath(artifactId: string) {
  if (!IS_UUID.test(artifactId)) throw new Error('Not a valid part');
  return `artifacts/${artifactId}.bin.sealed`;
}

export function knowledgePartPath(documentId: string) {
  if (!IS_UUID.test(documentId)) throw new Error('Not a valid part');
  return `knowledge/${documentId}.bin.sealed`;
}

/**
 * Whether a path from an archive is one this format makes. An archive is untrusted input, so this is an
 * allowlist rather than a hunt for `..`: a path that is not exactly this shape is refused, whatever it
 * would have meant to a file system.
 */
export function isArchivePath(path: string): boolean {
  if (path === EXPORT_MANIFEST_PATH) return true;
  const match = PART.exec(path);
  if (!match) return false;
  const [, section, file] = match as unknown as [string, string, string];
  if (!isExportSection(section)) return false;
  return file.endsWith('.bin')
    ? (section === 'artifacts' || section === 'knowledge') && IS_UUID.test(file.slice(0, 36))
    : true;
}

export const exportObjectKey = (organizationId: string, exportId: string, path: string) => {
  if (!IS_UUID.test(organizationId) || !IS_UUID.test(exportId) || !isArchivePath(path)) {
    throw new Error('Not a valid export object');
  }
  return `${EXPORT_OBJECT_PREFIX}${organizationId}/${exportId}/${path}`;
};

export const EXPORT_STATUSES = ['requested', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
/** Migration 0301 holds the same list in a trigger, and a test holds the two together. */
export const EXPORT_TRANSITIONS: Record<ExportStatus, readonly ExportStatus[]> = {
  requested: ['running', 'failed'],
  running: ['ready', 'failed'],
  ready: ['expired'],
  failed: [],
  expired: [],
};

export const IMPORT_STATUSES = [
  'requested',
  'running',
  'completed',
  'completed_with_warnings',
  'failed',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const IMPORT_TRANSITIONS: Record<ImportStatus, readonly ImportStatus[]> = {
  requested: ['running', 'failed'],
  // A failed run can be run again: every part it finished is remembered, and is not applied twice.
  running: ['completed', 'completed_with_warnings', 'failed'],
  completed: [],
  completed_with_warnings: [],
  failed: ['running'],
};

/** Why an export stopped. A code, so no text from a store or a record can reach a page or a log. */
export const EXPORT_FAILURE_CODES = [
  'STORE_UNAVAILABLE',
  'BYTES_MISSING',
  'BYTES_CHANGED',
  'RECORD_REFUSED',
  'TOO_MANY_PARTS',
  'SECTION_FAILED',
] as const;
export type ExportFailureCode = (typeof EXPORT_FAILURE_CODES)[number];

export const IMPORT_FAILURE_CODES = [
  'ARCHIVE_UNREADABLE',
  'WRONG_KEY',
  'MANIFEST_INVALID',
  'PART_MISSING',
  'PART_CHANGED',
  'PATH_REFUSED',
  'RECORD_REFUSED',
  'FORMAT_NOT_SUPPORTED',
  'TARGET_NOT_EMPTY',
  'STORE_UNAVAILABLE',
] as const;
export type ImportFailureCode = (typeof IMPORT_FAILURE_CODES)[number];

/** Things the person who imported needs to look at. Recorded with counts, and never as a silent loss. */
export const IMPORT_WARNING_CODES = [
  'RESTRICTED_EXCLUDED_AT_SOURCE',
  'TOMBSTONED_SKIPPED',
  'PERSON_NOT_LINKED',
  'CONNECTION_NEEDS_CREDENTIAL',
  'SECTION_NOT_SUPPORTED',
  'BYTES_MISSING',
  'RELATION_DANGLING',
  'WORK_PAUSED_ON_IMPORT',
  'DEFINITION_REQUIRES_REVIEW',
  'SOURCE_REQUIRES_REINGEST',
  'PROVIDER_RECONNECTION_REQUIRED',
  'CORE_ONLY_ARCHIVE',
  'FILES_AWAIT_REVIEW',
  'FILE_LINK_REQUIRES_REUPLOAD',
] as const;
export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];

/**
 * An import starts nothing. Work that was moving when it was exported has no workflow here, and a pending
 * decision belongs to a context that has gone, so anything in flight waits for a person (ADR-030 D9).
 */
export function importedWorkStatus(status: string): 'queued' | 'ready' | 'blocked' | TerminalWork {
  switch (status) {
    case 'queued':
    case 'ready':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return status;
    default:
      return 'blocked';
  }
}
type TerminalWork = 'completed' | 'failed' | 'cancelled';

/**
 * Records kept as history, read-only, instead of being made live again. An approval or a send that ran
 * elsewhere must never be actionable or repeatable here, and pointing it at whoever imported it would be
 * saying something false about who decided what.
 */
export const IMPORTED_RECORD_TYPES = [
  'approval',
  'approval_decision',
  'work_transition',
  'external_action',
  'external_action_receipt',
  'audit_event',
] as const;
export type ImportedRecordType = (typeof IMPORTED_RECORD_TYPES)[number];
