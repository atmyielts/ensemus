import { AppError } from '@ensemus/application';
import {
  objectFieldSchema,
  objectRelationSchema,
  type ObjectFieldBody,
} from '@ensemus/contracts/custom-objects';
import type { ObjectField } from '@ensemus/domain/custom-object';

export type ObjectFormState = {
  code?: string;
  values?: Record<string, string>;
  revision?: number;
  notice?: 'field_added' | 'relation_added';
  reauthHref?: string;
};
/** Omit absent contract options rather than widening the domain to explicit undefined. */
export function objectFieldsInput(fields: readonly ObjectFieldBody[]): ObjectField[] {
  return fields.map((f) => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    required: f.required,
    indexed: f.indexed,
    ...(f.options === undefined ? {} : { options: f.options }),
    ...(f.maxLength === undefined ? {} : { maxLength: f.maxLength }),
  }));
}
export const objectText = (form: FormData, key: string) =>
  typeof form.get(key) === 'string' ? String(form.get(key)) : '';
export function objectFormValues(form: FormData) {
  // React's action response rejects null-prototype objects. Every retained key below has a fixed
  // safe name or a field/attribute prefix, so none can replace a plain object's prototype.
  const values: Record<string, string> = {};
  let bytes = 0;
  const retained =
    /^(organizationId|typeId|recordId|version|requestKey|displayName|slug|classification|intent|fieldRows|relationRows|field_\d{1,2}_(key|label|kind|required|indexed|options|maxLength)|relation_\d{1,2}_(key|label|toTypeSlug|cardinality)|attribute_[a-z][a-z0-9_]{0,62})$/;
  for (const [key, value] of form)
    if (retained.test(key) && typeof value === 'string') {
      bytes += key.length + value.length;
      if (bytes > 300000) throw new AppError('INVALID_INPUT');
      if (key === 'intent' && !['save', 'add-field', 'add-relation'].includes(value))
        throw new AppError('INVALID_INPUT');
      values[key] = value;
    }
  return values;
}
export function objectShapeInput(form: FormData) {
  const fields = [],
    relations = [];
  for (const [key, value] of form)
    if (key.startsWith('field_') || key.startsWith('relation_')) {
      const match =
        /^(field|relation)_(\d+)_(key|label|kind|required|indexed|options|maxLength|toTypeSlug|cardinality)$/.exec(
          key,
        );
      if (
        !match ||
        Number(match[2]) >= (match[1] === 'field' ? 64 : 16) ||
        typeof value !== 'string'
      )
        throw new AppError('OBJECT_SCHEMA_INVALID');
    }
  for (let i = 0; i < 64; i++) {
    const prefix = `field_${i}_`;
    const key = objectText(form, prefix + 'key');
    if (!key) {
      if (objectText(form, prefix + 'label')) throw new AppError('OBJECT_SCHEMA_INVALID');
      continue;
    }
    const kind = objectText(form, prefix + 'kind'),
      length = objectText(form, prefix + 'maxLength');
    const value = objectFieldSchema.safeParse({
      key,
      label: objectText(form, prefix + 'label'),
      kind,
      required: objectText(form, prefix + 'required') === 'on',
      indexed: objectText(form, prefix + 'indexed') === 'on',
      ...(kind === 'enum'
        ? {
            options: objectText(form, prefix + 'options')
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
      ...(length ? { maxLength: Number(length) } : {}),
    });
    if (!value.success) throw new AppError('OBJECT_SCHEMA_INVALID');
    fields.push(...objectFieldsInput([value.data]));
  }
  for (let i = 0; i < 16; i++) {
    const prefix = `relation_${i}_`,
      key = objectText(form, prefix + 'key');
    if (!key) {
      if (objectText(form, prefix + 'label')) throw new AppError('OBJECT_SCHEMA_INVALID');
      continue;
    }
    const value = objectRelationSchema.safeParse({
      key,
      label: objectText(form, prefix + 'label'),
      toTypeSlug: objectText(form, prefix + 'toTypeSlug'),
      cardinality: objectText(form, prefix + 'cardinality'),
    });
    if (!value.success) throw new AppError('OBJECT_SCHEMA_INVALID');
    relations.push(value.data);
  }
  return { fields, relations };
}
/** A blank optional value is absent, never a fabricated 0/false/date. Unknown submitted fields refuse. */
export function objectAttributeInput(
  form: FormData,
  fields: readonly ObjectField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of form)
    if (
      key.startsWith('attribute_') &&
      (!fields.some((f) => key === `attribute_${f.key}`) || typeof value !== 'string')
    )
      throw new AppError('OBJECT_RECORD_INVALID');
  for (const f of fields) {
    const raw = objectText(form, `attribute_${f.key}`);
    if (raw === '') continue;
    if (f.kind === 'number') {
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw)))
        throw new AppError('OBJECT_RECORD_INVALID');
      Object.defineProperty(result, f.key, {
        value: Number(raw),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else if (f.kind === 'boolean') {
      if (raw !== 'true' && raw !== 'false') throw new AppError('OBJECT_RECORD_INVALID');
      Object.defineProperty(result, f.key, {
        value: raw === 'true',
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else
      Object.defineProperty(result, f.key, {
        value: raw,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return result;
}
