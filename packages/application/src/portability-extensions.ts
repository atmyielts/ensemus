// Reviewed SQL projections for the M3–M5 joined schema. The older M6 checkout intentionally has no
// M4/M5 module imports. Missing tables fail the archive, rather than pretending that a section is empty.
import { createHash } from 'node:crypto';
import {
  extensionRecordSchema,
  EXTENSION_SECTION_KINDS,
  M7_PORTABLE_RECORD_KINDS,
  type ExtensionRecord,
} from '@ensemus/contracts/portability-records';
import {
  PORTABILITY_INVENTORY,
  PORTABILITY_INVENTORY_VERSION,
  MAX_JOINED_RECORD_BYTES,
  type ExportSection,
} from '@ensemus/domain/portability';
import { assertPortableDefinitionIntegrity } from '@ensemus/domain/portable-definition';
import { sql } from 'drizzle-orm';
import { withTenantTx, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import type { ExportPage, ImportScope, PortabilitySection } from './sovereign-ports';
import { RecordRefused } from './portability-sections-import';
import { CORE_PORTABILITY_SECTIONS } from './portability-sections';
import { queryRows } from './portability-sql';
import { M7_PORTABLE_READERS, type PortableReader } from './portability-m7-readers';

const portableId = (text: string) => {
  const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const nullableInstant = (column: string) =>
  `CASE WHEN ${column} IS NULL THEN NULL ELSE ${instant(column)} END`;
const viewer = `sovereign.portable_export_viewer()`;
const readableSource = (column: string) => `${column} IN (SELECT s.id FROM knowledge.sources s
  WHERE s.organization_id=app.current_organization_id() AND s.state='active' AND s.classification<>'restricted'
  AND s.id IN (SELECT knowledge.readable_source_ids(${viewer})))`;
const workReadable = (column: string) => `EXISTS(SELECT 1 FROM work.work_units w WHERE
  w.organization_id=t.organization_id AND w.id=${column} AND w.classification<>'restricted'
  AND knowledge.can_read_work(w.id,${viewer}))`;
const portableRef = (ref: string) => `CASE split_part(${ref},':',1)
  WHEN 'work_unit' THEN EXISTS(SELECT 1 FROM work.work_units prw WHERE prw.organization_id=app.current_organization_id()
    AND prw.id::text=split_part(${ref},':',2) AND prw.classification<>'restricted' AND knowledge.can_read_work(prw.id,${viewer}))
  WHEN 'client' THEN EXISTS(SELECT 1 FROM work.clients prc WHERE prc.organization_id=app.current_organization_id()
    AND prc.id::text=split_part(${ref},':',2) AND prc.classification<>'restricted')
  WHEN 'project' THEN EXISTS(SELECT 1 FROM work.projects prp LEFT JOIN work.clients prc
    ON prc.organization_id=prp.organization_id AND prc.id=prp.client_id WHERE prp.organization_id=app.current_organization_id()
    AND prp.id::text=split_part(${ref},':',2) AND (prp.client_id IS NULL OR prc.classification<>'restricted'))
  WHEN 'knowledge_source' THEN split_part(${ref},':',2)::uuid IN (SELECT prs.id FROM knowledge.sources prs
    WHERE prs.organization_id=app.current_organization_id() AND prs.state='active' AND prs.classification<>'restricted'
    AND prs.id IN(SELECT knowledge.readable_source_ids(${viewer})))
  WHEN 'membership' THEN EXISTS(SELECT 1 FROM org.memberships prm WHERE prm.organization_id=app.current_organization_id() AND prm.id::text=split_part(${ref},':',2))
  WHEN 'team' THEN EXISTS(SELECT 1 FROM org.teams prt WHERE prt.organization_id=app.current_organization_id() AND prt.id::text=split_part(${ref},':',2))
  ELSE false END`;

type Reader = PortableReader;
const common = { id: 't.id', created_at: instant('t.created_at') };
const readers: Readonly<Partial<Record<ExportSection, readonly Reader[]>>> = {
  agents: [
    {
      table: 'org.service_identities',
      kind: 'service_identity',
      fields: { ...common, owner_membership_id: 't.owner_membership_id', purpose: 't.purpose' },
    },
    {
      table: 'ai.agent_definitions',
      kind: 'agent_definition',
      fields: {
        ...common,
        slug: 't.slug',
        name: 't.name',
        owner_membership_id: 't.owner_membership_id',
        service_identity_id: 't.service_identity_id',
      },
    },
    {
      table: 'ai.agent_versions',
      kind: 'agent_version',
      fields: {
        id: 't.id',
        definition_id: 't.definition_id',
        version_number: 't.version_number',
        spec: 't.spec',
        spec_sha256: 't.spec_sha256',
        published_at: instant('t.published_at'),
      },
    },
    {
      table: 'ai.model_profiles',
      kind: 'model_profile',
      fields: {
        ...common,
        alias: 't.alias',
        model_id: 't.model_id',
        provider_kind: 't.provider_kind',
        billing_owner: 't.billing_owner',
        capabilities: 't.capabilities',
        limits: 't.limits',
        allowed_classes: 't.allowed_classes',
        allowed_purposes: 't.allowed_purposes',
      },
    },
    {
      table: 'ai.rate_cards',
      kind: 'rate_card',
      fields: {
        ...common,
        profile_id: 't.profile_id',
        version: 't.version',
        input_micros_per_mtok: 't.input_micros_per_mtok',
        output_micros_per_mtok: 't.output_micros_per_mtok',
        effective_from: instant('t.effective_from'),
      },
    },
    {
      table: 'ai.agent_runs',
      kind: 'agent_run',
      fields: {
        ...common,
        work_unit_id: 't.work_unit_id',
        agent_version_id: 't.agent_version_id',
        status: 't.status',
        effective_classification: 't.effective_classification',
        model_turns: 't.model_turns',
        tool_calls: 't.tool_calls',
        input_tokens: 't.input_tokens',
        output_tokens: 't.output_tokens',
        cost_micros: 't.cost_micros',
      },
      where: `t.effective_classification<>'restricted' AND ${workReadable('t.work_unit_id')}`,
    },
    {
      table: 'ai.execution_steps',
      kind: 'execution_step',
      fields: {
        id: 't.id',
        run_id: 't.run_id',
        work_unit_id:
          '(select r.work_unit_id from ai.agent_runs r where r.organization_id=t.organization_id and r.id=t.run_id)',
        step_number: 't.step_number',
        step_kind: 't.kind',
        state: 't.state',
        label_code: 't.label_code',
        started_at: instant('t.started_at'),
      },
      where: `EXISTS(SELECT 1 FROM ai.agent_runs r WHERE r.organization_id=t.organization_id AND r.id=t.run_id AND r.effective_classification<>'restricted' AND ${workReadable('r.work_unit_id')})`,
    },
    {
      table: 'work.agent_assignments',
      kind: 'agent_assignment',
      key: 't.agent_run_id::text',
      fields: {
        id: 't.agent_run_id',
        work_unit_id: 't.work_unit_id',
        service_identity_id: 't.service_identity_id',
        agent_run_id: 't.agent_run_id',
        created_at: instant('t.created_at'),
      },
      where: workReadable('t.work_unit_id'),
    },
  ],
  policy: [
    {
      table: 'platform.budgets',
      kind: 'budget',
      fields: {
        ...common,
        scope: 't.scope',
        agent_version_id: 't.agent_version_id',
        period: 't.period',
        limit_micros: 't.limit_micros',
      },
    },
    {
      table: 'platform.usage_ledger',
      kind: 'usage_entry',
      fields: {
        ...common,
        work_unit_id: 't.work_unit_id',
        run_id: 't.run_id',
        meter: 't.meter',
        quantity: 't.quantity',
        cost_micros: 't.cost_micros',
        billing_period: 't.billing_period',
        commercial_mode: 't.commercial_mode',
      },
      where: workReadable('t.work_unit_id'),
    },
    {
      table: 'governance.policy_bundles',
      kind: 'policy_definition',
      fields: {
        ...common,
        version: 't.version',
        sha256: 't.sha256',
        document_text: 't.document::text',
      },
    },
  ],
  connections: [
    {
      table: 'integrations.external_resources',
      kind: 'external_resource',
      fields: {
        id: 't.id',
        connection_id: 't.connection_id',
        stream: 't.stream',
        resource_type: 't.resource_type',
        external_id: 't.external_id',
        external_version: 't.external_version',
        display_name: 't.display_name',
        classification: 't.classification',
        first_seen_at: instant('t.first_seen_at'),
      },
      where: `t.classification<>'restricted' AND t.deleted_at IS NULL AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=t.organization_id AND s.external_resource_id=t.id AND ${readableSource('s.id')})`,
    },
    {
      table: 'integrations.external_resource_acl',
      kind: 'external_acl',
      key: `concat_ws(':',t.resource_id,t.principal_kind,t.principal_external_id,t.access)`,
      fields: {
        resource_id: 't.resource_id',
        principal_kind: 't.principal_kind',
        principal_external_id: 't.principal_external_id',
        access: 't.access',
        membership_id: 't.membership_id',
        team_id: 't.team_id',
        updated_at: instant('t.updated_at'),
      },
      where: `EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=t.organization_id AND s.external_resource_id=t.resource_id AND s.classification<>'restricted' AND ${readableSource('s.id')})`,
    },
    {
      table: 'integrations.mcp_tools',
      kind: 'mcp_definition',
      fields: {
        id: 't.id',
        connection_id: 't.connection_id',
        tool_name: 't.tool_name',
        definition_sha256: 't.definition_sha256',
        first_seen_at: instant('t.first_seen_at'),
      },
    },
  ],
  clients: [
    {
      table: 'work.client_readers',
      kind: 'client_reader',
      key: `concat_ws(':',t.client_id,t.membership_id)`,
      fields: {
        client_id: 't.client_id',
        membership_id: 't.membership_id',
        created_at: instant('t.created_at'),
      },
      where: `EXISTS(SELECT 1 FROM work.clients c WHERE c.organization_id=t.organization_id AND c.id=t.client_id AND c.classification<>'restricted')`,
    },
  ],
  history: [
    {
      table: 'integrations.external_action_attempts',
      kind: 'action_attempt',
      fields: {
        id: 't.id',
        external_action_id: 't.external_action_id',
        work_unit_id:
          '(select a.work_unit_id from integrations.external_actions a where a.organization_id=t.organization_id and a.id=t.external_action_id)',
        attempt_no: 't.attempt_no',
        request_hash: 't.request_hash',
        outcome: 't.outcome',
        recorded_at: instant('t.recorded_at'),
        finished_at: nullableInstant('t.finished_at'),
      },
      where: `EXISTS(SELECT 1 FROM integrations.external_actions a WHERE a.organization_id=t.organization_id AND a.id=t.external_action_id AND ${workReadable('a.work_unit_id')})`,
    },
  ],
  knowledge: [
    {
      table: 'knowledge.sources',
      kind: 'knowledge_source',
      fields: {
        ...common,
        source_kind: 't.kind',
        connection_id: 't.connection_id',
        external_resource_id: 't.external_resource_id',
        classification: 't.classification',
        owner_membership_id: 't.owner_membership_id',
      },
      where: `t.state='active' AND t.classification<>'restricted' AND ${readableSource('t.id')}`,
    },
    {
      table: 'knowledge.source_grants',
      kind: 'source_grant',
      fields: {
        ...common,
        source_id: 't.source_id',
        principal_kind: 't.principal_kind',
        membership_id: 't.membership_id',
        team_id: 't.team_id',
      },
      where: `EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=t.organization_id AND s.id=t.source_id AND s.state='active' AND s.classification<>'restricted' AND ${readableSource('s.id')})`,
    },
    {
      table: 'knowledge.documents',
      kind: 'knowledge_document',
      fields: {
        ...common,
        source_id: 't.source_id',
        version_no: 't.version_no',
        title: 't.title',
        content_sha256: 't.content_sha256',
        size_bytes: 't.size_bytes',
        media_type: 't.media_type',
        classification: 't.classification',
        source_version: 't.source_version',
        superseded_at: nullableInstant('t.superseded_at'),
      },
      where: `t.state='searchable' AND t.classification<>'restricted' AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=t.organization_id AND s.id=t.source_id AND s.state='active' AND s.classification<>'restricted' AND ${readableSource('s.id')})`,
    },
    {
      table: 'knowledge.embedding_spaces',
      kind: 'embedding_space',
      fields: {
        ...common,
        model_id: 't.model_id',
        dimension: 't.dimension',
        vector_space_version: 't.vector_space_version',
      },
    },
    {
      table: 'knowledge.facts',
      kind: 'fact_definition',
      fields: {
        ...common,
        subject_ref: 't.subject_ref',
        predicate: 't.predicate',
        claim_text: 't.claim::text',
        classification: 't.classification',
        source_ids: `(select coalesce(jsonb_agg(distinct fe.source_id order by fe.source_id),'[]'::jsonb) from knowledge.fact_evidence fe where fe.organization_id=t.organization_id and fe.fact_id=t.id)`,
      },
      where: `t.classification<>'restricted' AND (${portableRef('t.subject_ref')}) AND NOT EXISTS(SELECT 1 FROM knowledge.fact_evidence e WHERE e.organization_id=t.organization_id AND e.fact_id=t.id AND NOT (${readableSource('e.source_id')}))`,
    },
    {
      table: 'knowledge.fact_evidence',
      kind: 'fact_evidence',
      key: `concat_ws(':',t.fact_id,t.chunk_id)`,
      fields: {
        fact_id: 't.fact_id',
        source_id: 't.source_id',
        chunk_id: 't.chunk_id',
        content_sha256: 't.content_sha256',
        quote_start: 't.quote_start',
        quote_end: 't.quote_end',
        created_at: instant('t.created_at'),
      },
      where: `${readableSource('t.source_id')} AND EXISTS(SELECT 1 FROM knowledge.facts f WHERE f.organization_id=t.organization_id AND f.id=t.fact_id AND f.classification<>'restricted' AND (${portableRef('f.subject_ref')}) AND NOT EXISTS(SELECT 1 FROM knowledge.fact_evidence e WHERE e.organization_id=f.organization_id AND e.fact_id=f.id AND NOT (${readableSource('e.source_id')})))`,
    },
    {
      table: 'knowledge.edges',
      kind: 'graph_edge',
      fields: {
        ...common,
        from_ref: `t.from_type||':'||t.from_id`,
        to_ref: `t.to_type||':'||t.to_id`,
        relation: 't.relation',
        fact_id: 't.fact_id',
      },
      where: `(${portableRef("t.from_type||':'||t.from_id")}) AND (${portableRef("t.to_type||':'||t.to_id")}) AND t.fact_id IS NULL`,
    },
    {
      table: 'knowledge.artifact_citations',
      kind: 'artifact_citation',
      key: `concat_ws(':',t.artifact_id,lpad(t.ordinal::text,10,'0'))`,
      fields: {
        artifact_id: 't.artifact_id',
        source_id: 't.source_id',
        document_id: 't.document_id',
        chunk_id: 't.chunk_id',
        content_sha256: 't.content_sha256',
        work_unit_ids: `(select coalesce(jsonb_agg(distinct wa.work_unit_id order by wa.work_unit_id),'[]'::jsonb) from knowledge.artifact_work_links wa where wa.organization_id=t.organization_id and wa.artifact_id=t.artifact_id)`,
        artifact_start: 't.artifact_start',
        artifact_end: 't.artifact_end',
        created_at: instant('t.created_at'),
      },
      where: `${readableSource('t.source_id')} AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_citations a WHERE a.organization_id=t.organization_id AND a.artifact_id=t.artifact_id AND NOT (${readableSource('a.source_id')})) AND EXISTS(SELECT 1 FROM knowledge.artifact_work_links l WHERE l.organization_id=t.organization_id AND l.artifact_id=t.artifact_id AND ${workReadable('l.work_unit_id')})`,
    },
  ],
};

export async function assertJoinedPortabilitySchema(tx: Tx): Promise<void> {
  const required = PORTABILITY_INVENTORY.map((entry) => entry.table);
  const rows = await queryRows<{ table_name: string | null }>(
    tx,
    sql`select to_regclass(name)::text as table_name
    from unnest(${sql.param(required)}::text[]) as name`,
  );
  if (rows.length !== required.length || rows.some((row) => row.table_name === null))
    throw new RecordRefused();
  const present = await queryRows<{ table_name: string }>(
    tx,
    sql`select schemaname||'.'||tablename as table_name
    from pg_catalog.pg_tables where schemaname NOT LIKE 'pg_%'
      AND schemaname NOT IN ('information_schema','drizzle')`,
  );
  if (present.some((row) => !required.includes(row.table_name))) throw new RecordRefused();
}

async function assertExportViewer(tx: Tx) {
  const rows = await queryRows<{ id: string }>(
    tx,
    sql`select sovereign.portable_export_viewer() as id`,
  );
  if (rows.length !== 1 || !rows[0]?.id) throw new RecordRefused();
}

function exporter(section: ExportSection): PortabilitySection['exportPage'] {
  return async (tx, context, { cursor, limit }): Promise<ExportPage> => {
    await assertJoinedPortabilitySchema(tx);
    await assertExportViewer(tx);
    const list = [...(readers[section] ?? []), ...(M7_PORTABLE_READERS[section] ?? [])];
    if (section === 'skills') return { recordKind: 'skills', records: [], nextCursor: null };
    const state =
      cursor === null
        ? { index: 0, key: null as string | null }
        : (JSON.parse(cursor) as { index: number; key: string | null });
    const reader = list[state.index];
    if (!reader) throw new RecordRefused();
    const key = reader.key ?? 't.id::text';
    const projection = Object.entries(reader.fields)
      .map(([name, value]) => `'${name}',${value}`)
      .join(',');
    const pageSize = Math.min(
      limit,
      reader.kind === 'knowledge_document' || reader.oneAtATime ? 1 : 200,
    );
    const at =
      reader.fields.created_at ??
      reader.fields.published_at ??
      reader.fields.first_seen_at ??
      reader.fields.updated_at ??
      reader.fields.started_at ??
      reader.fields.recorded_at;
    const payload = `jsonb_build_object('kind','${reader.kind}',${projection})`;
    const rows = await queryRows<{ key: string; record: Record<string, unknown> | null }>(
      tx,
      sql`
      select ${sql.raw(key)} as key,CASE WHEN octet_length((${sql.raw(payload)})::text)<${MAX_JOINED_RECORD_BYTES - 256}
        THEN ${sql.raw(payload)} ELSE NULL END as record
      from ${sql.raw(reader.table)} t ${sql.raw(reader.join ?? '')} where t.organization_id=${context.organizationId}::uuid
      and (${sql.raw(reader.where ?? 'true')}) and (${state.key}::text is null or ${sql.raw(key)}>${state.key})
      and ${
        at
          ? sql`${sql.raw(at)}<=(select ${sql.raw(instant('snapshot_at'))} from sovereign.organization_exports
        where organization_id=${context.organizationId}::uuid and id=nullif(current_setting('app.portability_export_id',true),'')::uuid and status='running')`
          : sql`true`
      }
      order by ${sql.raw(key)} limit ${pageSize}`,
    );
    const records = rows.map(({ key, record }) => {
      if (!record) throw new RecordRefused();
      const checked = extensionRecordSchema.parse({
        ...record,
        id: record.id ?? portableId(`${reader.table}:${key}`),
      });
      assertPortableDefinitionIntegrity(checked);
      return checked;
    });
    const last = rows.at(-1);
    const more = rows.length === pageSize && last;
    const nextCursor = more
      ? JSON.stringify({ index: state.index, key: last.key })
      : state.index + 1 < list.length
        ? JSON.stringify({ index: state.index + 1, key: null })
        : null;
    const originals = records.flatMap((record) =>
      record.kind === 'knowledge_document'
        ? [
            {
              documentId: record.id,
              objectKey: `${context.organizationId}/knowledge/${record.id}`,
              sha256: record.content_sha256,
              sizeBytes: record.size_bytes,
            },
          ]
        : [],
    );
    return {
      recordKind: reader.kind,
      records,
      nextCursor,
      ...(originals.length ? { originals } : {}),
    };
  };
}

export async function quarantinePortableRecord(
  tx: Tx,
  context: TenantContext,
  scope: ImportScope,
  record: ExtensionRecord,
) {
  const custodian =
    await tx.execute(sql`select m.id from sovereign.organization_imports i join org.memberships m
    on m.organization_id=i.organization_id and m.id=i.fallback_membership_id
    where i.organization_id=${context.organizationId}::uuid and i.id=${scope.importId}::uuid
    and i.status='running' and m.status='active' and m.role='owner' for share of m`);
  if (custodian.rows.length !== 1) throw new RecordRefused();
  const work = 'work_unit_id' in record ? record.work_unit_id : null;
  const classification =
    'classification' in record
      ? record.classification
      : 'effective_classification' in record
        ? record.effective_classification
        : 'confidential';
  const section = Object.entries(EXTENSION_SECTION_KINDS).find(([, kinds]) =>
    (kinds as readonly string[]).includes(record.kind),
  )?.[0];
  if (!section) throw new RecordRefused();
  // Validate twice at the trust boundary; caller-supplied JSON cannot become an accepted definition.
  const checked = extensionRecordSchema.parse(record);
  if (
    (M7_PORTABLE_RECORD_KINDS as readonly string[]).includes(checked.kind) &&
    scope.inventoryVersion !== PORTABILITY_INVENTORY_VERSION
  )
    throw new RecordRefused();
  assertPortableDefinitionIntegrity(checked);
  const bindings = portableDefinitionBindings(checked);
  await tx.execute(sql`insert into sovereign.imported_definitions
    (organization_id,import_id,section,record_kind,source_id,classification,work_unit_id,record,required_source_ids,required_records)
    values(${context.organizationId}::uuid,${scope.importId}::uuid,${section},${record.kind},${record.id}::uuid,
      ${classification},${work}::uuid,${JSON.stringify(checked)}::jsonb,${sql.param(bindings.sources)}::uuid[],${JSON.stringify(bindings.records)}::jsonb)
      on conflict do nothing`);
  const [match] = await queryRows<{ matches: boolean }>(
    tx,
    sql`select sovereign.imported_definition_matches(
    ${scope.importId}::uuid,${record.kind},${record.id}::uuid,${JSON.stringify(checked)}::jsonb) as matches`,
  );
  if (!match?.matches) throw new RecordRefused();
}

export function portableDefinitionBindings(record: ExtensionRecord) {
  const sources = new Set<string>();
  const records = new Map<
    string,
    { kind: 'work_unit' | 'project' | 'client' | 'object_record'; id: string }
  >();
  const ref = (kind: string, id: string) => {
    if (kind === 'knowledge_source') sources.add(id);
    else if (
      kind === 'work_unit' ||
      kind === 'project' ||
      kind === 'client' ||
      kind === 'object_record'
    )
      records.set(`${kind}:${id}`, { kind, id });
  };
  if ('work_unit_id' in record) ref('work_unit', record.work_unit_id);
  if ('client_id' in record) ref('client', record.client_id);
  if ('source_id' in record) sources.add(record.source_id);
  if (record.kind === 'knowledge_source') sources.add(record.id);
  if (record.kind === 'studio_agent_draft')
    record.answers.knowledgeSourceIds.forEach((id) => sources.add(id));
  if (record.kind === 'custom_object_record') ref('object_record', record.id);
  if (record.kind === 'custom_object_relation') {
    ref('object_record', record.from_record_id);
    ref('object_record', record.to_record_id);
  }
  if (record.kind === 'fact_definition') {
    record.source_ids.forEach((id) => sources.add(id));
    const [kind, id] = record.subject_ref.split(':');
    if (kind && id) ref(kind, id);
  }
  if (record.kind === 'graph_edge')
    for (const value of [record.from_ref, record.to_ref]) {
      const [kind, id] = value.split(':');
      if (kind && id) ref(kind, id);
    }
  if (record.kind === 'artifact_citation')
    record.work_unit_ids.forEach((id) => ref('work_unit', id));
  if (record.kind === 'agent_version')
    for (const scope of record.spec.context.allowed_scopes) {
      const match = /^(work_unit|project|client|knowledge_source):([0-9a-f-]{36})$/.exec(scope);
      if (match) ref(match[1]!, match[2]!);
    }
  return {
    sources: [...sources].sort(),
    records: [...records.values()].sort((a, b) =>
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
    ),
  };
}

/** Actual SQL-only erasure of quarantined PG copies. Root's source/record lifecycle must call this
 * in addition to its document/blob/transcript erasers, and require zero in its final locked check. */
export function createImportedDefinitionPurge(database: AppDatabase) {
  return {
    purge: async (
      context: TenantContext,
      target: {
        kind: 'knowledge_source' | 'work_unit' | 'project' | 'client' | 'object_record';
        id: string;
      },
    ) => {
      if (context.actorType !== 'service') throw new RecordRefused();
      return withTenantTx(database, context, async (tx) => {
        const [row] = await queryRows<{ removed: number }>(
          tx,
          sql`select sovereign.erase_imported_definitions(${target.kind},${target.id}::uuid) as removed`,
        );
        const [remaining] = await queryRows<{ remaining: number }>(
          tx,
          sql`select sovereign.imported_definitions_remaining(${target.kind},${target.id}::uuid) as remaining`,
        );
        if (!row || !remaining) throw new RecordRefused();
        return {
          removed: row.removed,
          remaining: remaining.remaining,
          confirmed: remaining.remaining === 0,
        };
      });
    },
    confirmInTx: async (
      tx: Tx,
      context: TenantContext,
      target: {
        kind: 'knowledge_source' | 'work_unit' | 'project' | 'client' | 'object_record';
        id: string;
      },
    ) => {
      if (context.actorType !== 'service') throw new RecordRefused();
      const [row] = await queryRows<{ remaining: number }>(
        tx,
        sql`select sovereign.imported_definitions_remaining(${target.kind},${target.id}::uuid) as remaining`,
      );
      if (!row) throw new RecordRefused();
      return row;
    },
  };
}

function importer(section: ExportSection): PortabilitySection['importPage'] {
  return async (tx, context, scope, { records }) => {
    if (context.actorType !== 'service') throw new RecordRefused();
    await assertJoinedPortabilitySchema(tx);
    const owner =
      await tx.execute(sql`select m.id from sovereign.organization_imports i join org.memberships m
      on m.organization_id=i.organization_id and m.id=i.fallback_membership_id
      where i.organization_id=${context.organizationId}::uuid and i.id=${scope.importId}::uuid
      and i.status='running' and m.status='active' and m.role='owner' for share of m`);
    if (owner.rows.length !== 1) throw new RecordRefused();
    let applied = 0;
    for (const raw of records) {
      const record = extensionRecordSchema.parse(raw);
      const kinds = EXTENSION_SECTION_KINDS[section as keyof typeof EXTENSION_SECTION_KINDS] as
        readonly string[] | undefined;
      if (!kinds?.includes(record.kind)) throw new RecordRefused();
      if (
        scope.isTombstoned('knowledge_source', 'source_id' in record ? record.source_id : record.id)
      )
        continue;
      if (record.kind === 'knowledge_source' && record.source_kind === 'upload') {
        const owner = scope.membershipFor(
          record.owner_membership_id ?? '00000000-0000-4000-8000-000000000000',
        );
        await tx.execute(sql`insert into knowledge.sources(organization_id,id,kind,classification,owner_membership_id)
          values(${context.organizationId}::uuid,${record.id}::uuid,'upload',${record.classification},${owner}::uuid)
          on conflict do nothing`);
        const grantId = portableId(`import:${scope.importId}:source:${record.id}:custodian`);
        await tx.execute(sql`insert into knowledge.source_grants
          (organization_id,id,source_id,principal_kind,membership_id,granted_by_membership_id)
          values(${context.organizationId}::uuid,${grantId}::uuid,${record.id}::uuid,'membership',${owner}::uuid,${owner}::uuid)
          on conflict do nothing`);
      }
      await quarantinePortableRecord(tx, context, scope, record);
      applied += 1;
    }
    return {
      applied,
      warnings: {
        DEFINITION_REQUIRES_REVIEW: applied,
        ...(records.some((raw) => extensionRecordSchema.parse(raw).kind === 'knowledge_source')
          ? { SOURCE_REQUIRES_REINGEST: applied }
          : {}),
      },
    };
  };
}

export const EXTENDED_PORTABILITY_SECTIONS: readonly PortabilitySection[] = (
  ['agents', 'skills', 'policy', 'knowledge', 'custom-objects'] as const
).map((section) => ({
  section,
  exportPage: exporter(section),
  importPage: importer(section),
  ...(section === 'knowledge'
    ? {
        confirmOriginals: async (tx: Tx, context: TenantContext, ids: readonly string[]) => {
          await assertExportViewer(tx);
          await tx.execute(sql`select s.id from knowledge.sources s where s.organization_id=${context.organizationId}::uuid
      and s.id IN(select d.source_id from knowledge.documents d where d.organization_id=s.organization_id and d.id=ANY(${sql.param([...ids])}::uuid[]))
      order by s.id for share`);
          const rows = await queryRows<{ id: string }>(
            tx,
            sql`select t.id from knowledge.documents t
      where t.organization_id=${context.organizationId}::uuid and t.id=ANY(${sql.param([...ids])}::uuid[])
      and t.state='searchable' and t.classification<>'restricted' and ${sql.raw(readableSource('t.source_id'))}`,
          );
          return rows.length === ids.length;
        },
      }
    : {}),
}));

export const SOURCE_PORTABILITY_SECTIONS: readonly PortabilitySection[] = [
  ...CORE_PORTABILITY_SECTIONS.map(extendCoreSection),
  ...EXTENDED_PORTABILITY_SECTIONS,
];

/** Core sections also own newly introduced, reviewed kinds. They keep their existing core readers first. */
export function extendCoreSection(core: PortabilitySection): PortabilitySection {
  if (core.section !== 'connections' && core.section !== 'clients' && core.section !== 'history')
    return core;
  const extensionExport = exporter(core.section),
    extensionImport = importer(core.section);
  return {
    ...core,
    exportPage: async (tx, context, input) => {
      const state = input.cursor?.startsWith('extension:');
      if (state)
        return extensionExport(tx, context, { ...input, cursor: input.cursor!.slice(10) || null });
      const page = await core.exportPage(tx, context, input);
      return { ...page, nextCursor: page.nextCursor ?? 'extension:' };
    },
    importPage: async (tx, context, scope, input) => {
      const kind = (input.records[0] as { kind?: unknown } | undefined)?.kind;
      const allowed = EXTENSION_SECTION_KINDS[
        core.section as 'connections' | 'clients' | 'history'
      ] as readonly string[];
      return typeof kind === 'string' && allowed.includes(kind)
        ? extensionImport(tx, context, scope, input)
        : core.importPage(tx, context, scope, input);
    },
  };
}

export async function listImportedDefinitions(
  database: AppDatabase,
  context: TenantContext,
  input: { after?: string; limit?: number } = {},
) {
  if (context.actorType !== 'user' || !['owner', 'admin'].includes(context.role))
    throw new RecordRefused();
  return withTenantTx(database, context, async (tx) => {
    const rows = await queryRows<{
      section: string;
      record_kind: string;
      source_id: string;
      record: unknown;
    }>(
      tx,
      sql`
      select section,record_kind,source_id,record from sovereign.imported_definitions
      where organization_id=${context.organizationId}::uuid and (source_id::text||':'||record_kind)>${input.after ?? ''}
      order by source_id::text||':'||record_kind limit ${Math.max(1, Math.min(input.limit ?? 100, 200))}`,
    );
    return rows.map((row) => ({ ...row, record: extensionRecordSchema.parse(row.record) }));
  });
}
