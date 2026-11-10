// Deterministic archive integrity only. Runtime callers first apply strict transport schemas.
// Nothing here publishes an imported definition, grants access or certifies an agent's quality.
import { createHash } from 'node:crypto';
import { canonicalJson } from './approval';
import {
  validateObjectSchema,
  validateRecordAttributes,
  type ObjectField,
  type ObjectRelationDefinition,
} from './custom-object';

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function refuse(): never {
  throw new Error('RECORD_REFUSED');
}
export function assertPortableDefinitionIntegrity(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  const record = value as Record<string, unknown>;
  try {
    if (record.kind === 'custom_object_version' || record.kind === 'custom_object_record') {
      const fields = record.fields as readonly ObjectField[],
        relations = record.relations as readonly ObjectRelationDefinition[];
      if (
        typeof record.type_slug !== 'string' ||
        !Array.isArray(fields) ||
        !Array.isArray(relations) ||
        validateObjectSchema({ slug: record.type_slug, fields, relations }).length ||
        record.schema_sha256 !== sha256({ fields, relations })
      )
        refuse();
      if (record.kind === 'custom_object_record') {
        const ranks = ['public', 'internal', 'confidential'],
          actual = ranks.indexOf(record.classification as string),
          floor = ranks.indexOf(record.type_classification as string);
        if (
          actual < 0 ||
          floor < 0 ||
          actual < floor ||
          validateRecordAttributes(fields, record.attributes as Record<string, unknown>).length
        )
          refuse();
      }
    } else if (record.kind === 'process_spec') {
      const spec = record.spec as {
        classification?: unknown;
        steps?: readonly { key: string; after: readonly string[] }[];
      };
      if (
        !spec ||
        spec.classification !== record.classification ||
        record.spec_sha256 !== sha256(spec) ||
        !Array.isArray(spec.steps)
      )
        refuse();
      const byKey = new Map(spec.steps.map((step) => [step.key, step])),
        finished = new Set<string>();
      if (byKey.size !== spec.steps.length) refuse();
      const visit = (key: string, pending: Set<string>): void => {
        if (finished.has(key)) return;
        if (pending.has(key)) refuse();
        const step = byKey.get(key);
        if (!step) refuse();
        pending.add(key);
        for (const dependency of step.after) visit(dependency, pending);
        pending.delete(key);
        finished.add(key);
      };
      for (const key of byKey.keys()) visit(key, new Set());
    } else if (record.kind === 'studio_agent_draft') {
      const answers = record.answers as { ownerMembershipId?: unknown };
      if (!answers || answers.ownerMembershipId !== record.owner_membership_id) refuse();
    }
  } catch {
    refuse();
  }
}
