import type { ExtensionRecord } from '@ensemus/contracts/portability-records';
import type { ExportSection } from '@ensemus/domain/portability';

export type PortableReader = {
  table: string;
  kind: ExtensionRecord['kind'];
  fields: Readonly<Record<string, string>>;
  key?: string;
  where?: string;
  join?: string;
  oneAtATime?: boolean;
};
const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const common = { id: 't.id', created_at: instant('t.created_at') };
const viewer = 'sovereign.portable_export_viewer()';
const sourceReadable = (value: string, classification = 't.classification') =>
  `EXISTS(SELECT 1 FROM knowledge.sources source WHERE source.organization_id=t.organization_id AND source.id=${value} AND source.state='active' AND source.classification<>'restricted' AND knowledge.class_rank(source.classification)<=knowledge.class_rank(${classification}) AND source.id IN(SELECT knowledge.readable_source_ids(${viewer})))`;
const objectReadable = (id: string) =>
  `objects.record_readable(${id},${viewer}) AND objects.record_class(${id}) IN('public','internal','confidential')`;
const pinJoin = `JOIN objects.types typ ON typ.organization_id=t.organization_id AND typ.id=t.type_id`;
const shape = {
  type_slug: 'typ.slug',
  fields: 'shape.fields',
  relations: 'shape.relations',
  schema_sha256: 'shape.schema_sha256',
};
const draftWhere = `t.classification<>'restricted' AND t.status<>'archived'`;
const itemVisible = `CASE t.item_kind
 WHEN 'object_type' THEN EXISTS(SELECT 1 FROM objects.types subject WHERE subject.organization_id=t.organization_id AND subject.id=t.item_id AND subject.state='active' AND subject.classification<>'restricted')
 WHEN 'agent_draft' THEN EXISTS(SELECT 1 FROM studio.agent_drafts subject WHERE subject.organization_id=t.organization_id AND subject.id=t.item_id AND subject.classification<>'restricted' AND subject.status<>'archived' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(subject.answers->'knowledgeSourceIds') wanted(id) WHERE NOT (${sourceReadable('wanted.id::uuid', 'subject.classification')})))
 WHEN 'process_draft' THEN EXISTS(SELECT 1 FROM studio.process_drafts subject WHERE subject.organization_id=t.organization_id AND subject.id=t.item_id AND subject.classification<>'restricted' AND subject.status<>'archived')
 WHEN 'process_spec' THEN EXISTS(SELECT 1 FROM studio.process_specs subject WHERE subject.organization_id=t.organization_id AND subject.id=t.item_id AND subject.classification<>'restricted')
 ELSE false END`;

/** Explicit columns only. Imported snapshots are inert review material, never the original live IDs,
 * a simulation result, an approval, a pack activation or executable publication. */
export const M7_PORTABLE_READERS: Readonly<
  Partial<Record<ExportSection, readonly PortableReader[]>>
> = {
  agents: [
    {
      table: 'studio.agent_drafts',
      kind: 'studio_agent_draft',
      fields: {
        ...common,
        name: 't.name',
        owner_membership_id: 't.owner_membership_id',
        classification: 't.classification',
        answers: 't.answers',
        spec_sha256: 't.spec_sha256',
        version: 't.version',
        updated_at: instant('t.updated_at'),
      },
      where: `${draftWhere} AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(t.answers->'knowledgeSourceIds') wanted(id) WHERE NOT (${sourceReadable('wanted.id::uuid')}))`,
      oneAtATime: true,
    },
    {
      table: 'studio.process_drafts',
      kind: 'studio_process_draft',
      fields: {
        ...common,
        name: 't.name',
        owner_membership_id: 't.owner_membership_id',
        classification: 't.classification',
        graph: 't.graph',
        spec_sha256: 't.spec_sha256',
        version: 't.version',
        updated_at: instant('t.updated_at'),
      },
      where: draftWhere,
      oneAtATime: true,
    },
    {
      table: 'studio.process_specs',
      kind: 'process_spec',
      fields: {
        id: 't.id',
        created_at: instant('t.published_at'),
        process_key: 't.process_key',
        version_number: 't.version_number',
        name: 't.name',
        classification: 't.classification',
        spec: 't.spec',
        spec_sha256: 't.spec_sha256',
        source: 't.source',
        source_ref: 't.source_ref',
      },
      where: `t.classification<>'restricted'`,
      oneAtATime: true,
    },
    {
      table: 'packs.installations',
      kind: 'pack_installation',
      fields: {
        ...common,
        pack_key: 't.pack_key',
        pack_version: 't.pack_version',
        manifest_sha256: 't.manifest_sha256',
      },
    },
    {
      table: 'packs.installed_items',
      kind: 'pack_item',
      key: `concat_ws(':',t.installation_id,t.item_kind,t.item_key)`,
      fields: {
        installation_id: 't.installation_id',
        item_kind: 't.item_kind',
        item_key: 't.item_key',
        item_id: 't.item_id',
        created_at: instant('t.created_at'),
      },
      where: itemVisible,
    },
  ],
  policy: [
    {
      table: 'org.security_policies',
      kind: 'security_settings',
      key: 't.organization_id::text',
      fields: {
        id: 't.organization_id',
        created_at: instant('t.updated_at'),
        classification: `'confidential'`,
        mfa_for_administration: 't.mfa_for_administration',
        mfa_max_age_seconds: 't.mfa_max_age_seconds',
        sso_enforcement: 't.sso_enforcement',
      },
    },
  ],
  'custom-objects': [
    {
      table: 'objects.types',
      kind: 'custom_object_type',
      fields: {
        ...common,
        slug: 't.slug',
        display_name: 't.display_name',
        classification: 't.classification',
        current_version_number: 't.current_version_number',
      },
      where: `t.state='active' AND t.classification<>'restricted'`,
    },
    {
      table: 'objects.type_versions',
      kind: 'custom_object_version',
      join: pinJoin,
      key: `t.type_id::text||':'||lpad(t.version_number::text,10,'0')`,
      fields: {
        type_id: 't.type_id',
        version_number: 't.version_number',
        classification: 'typ.classification',
        type_slug: 'typ.slug',
        fields: 't.fields',
        relations: 't.relations',
        schema_sha256: 't.schema_sha256',
        created_at: instant('t.created_at'),
      },
      where: `typ.state='active' AND typ.classification<>'restricted'`,
      oneAtATime: true,
    },
    {
      table: 'objects.records',
      kind: 'custom_object_record',
      join: `${pinJoin} JOIN objects.type_versions shape ON shape.organization_id=t.organization_id AND shape.type_id=t.type_id AND shape.version_number=t.type_version_number`,
      fields: {
        ...common,
        type_id: 't.type_id',
        type_version_number: 't.type_version_number',
        display_name: 't.display_name',
        classification: 'objects.record_class(t.id)',
        type_classification: 'typ.classification',
        owner_membership_id: 't.owner_membership_id',
        version: 't.version',
        updated_at: instant('t.updated_at'),
        ...shape,
        attributes: 't.attributes',
      },
      where: `${objectReadable('t.id')} AND typ.state='active' AND t.deleted_at IS NULL`,
      oneAtATime: true,
    },
    {
      table: 'objects.relations',
      kind: 'custom_object_relation',
      fields: {
        ...common,
        relation_key: 't.relation_key',
        from_record_id: 't.from_record_id',
        to_record_id: 't.to_record_id',
        classification: `CASE WHEN knowledge.class_rank(objects.record_class(t.from_record_id))>=knowledge.class_rank(objects.record_class(t.to_record_id)) THEN objects.record_class(t.from_record_id) ELSE objects.record_class(t.to_record_id) END`,
      },
      where: `(${objectReadable('t.from_record_id')}) AND (${objectReadable('t.to_record_id')})`,
    },
  ],
};
