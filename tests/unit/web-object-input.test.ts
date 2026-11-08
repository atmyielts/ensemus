import { describe, it, expect } from 'vitest';
import {
  objectAttributeInput,
  objectShapeInput,
  objectFormValues,
  objectFieldsInput,
} from '../../apps/web/src/lib/object-input';
import { objectEditorRows, withGeneratedObjectKeys } from '../../apps/web/src/lib/object-editor';
describe('native custom object inputs', () => {
  it('omits absent contract options from the normalized domain field', () => {
    const f = objectFieldsInput([
      {
        key: 'text',
        label: 'Text',
        kind: 'text',
        required: false,
        indexed: false,
        options: undefined,
        maxLength: undefined,
      },
    ])[0];
    expect(f).toEqual({
      key: 'text',
      label: 'Text',
      kind: 'text',
      required: false,
      indexed: false,
    });
    expect(Object.hasOwn(f ?? {}, 'options')).toBe(false);
  });
  const fields = [
    { key: 'count', label: 'Count', kind: 'number', indexed: true, required: false },
    { key: 'ok', label: 'OK', kind: 'boolean', indexed: false, required: false },
  ] as const;
  it('preserves zero/false and omits blanks', () => {
    const form = new FormData();
    form.set('attribute_count', '0');
    form.set('attribute_ok', 'false');
    expect(objectAttributeInput(form, fields)).toEqual({ count: 0, ok: false });
    form.set('attribute_count', '');
    expect(objectAttributeInput(form, fields)).toEqual({ ok: false });
  });
  it('refuses coercion and undeclared fields', () => {
    const form = new FormData();
    form.set('attribute_count', 'Infinity');
    expect(() => objectAttributeInput(form, fields)).toThrow();
    form.set('attribute_count', '0x10');
    expect(() => objectAttributeInput(form, fields)).toThrow();
    form.delete('attribute_count');
    form.set('attribute_extra', 'secret');
    expect(() => objectAttributeInput(form, fields)).toThrow();
  });
  it('treats legal constructor keys as data without prototype mutation', () => {
    const form = new FormData();
    form.set('attribute_constructor', 'saved');
    const shape = [
      { key: 'constructor', label: 'Constructor', kind: 'text', required: false, indexed: false },
    ] as const;
    expect(Object.hasOwn(objectAttributeInput(form, shape), 'constructor')).toBe(true);
  });
  it('refuses a label without a key and parses explicit indexed optional fields', () => {
    const form = new FormData();
    form.set('field_0_label', 'Label');
    expect(() => objectShapeInput(form)).toThrow();
    form.set('field_0_key', 'label');
    form.set('field_0_kind', 'text');
    form.set('field_0_indexed', 'on');
    expect(objectShapeInput(form).fields).toEqual([
      { key: 'label', label: 'Label', kind: 'text', required: false, indexed: true },
    ]);
  });
  it('refuses extra field rows instead of silently truncating a submitted shape', () => {
    const form = new FormData();
    form.set('field_64_key', 'ignored');
    expect(() => objectShapeInput(form)).toThrow();
  });
  it('preserves only form data, never framework action metadata', () => {
    const form = new FormData();
    form.set('displayName', 'Own draft');
    form.set('$ACTION_REF_0', 'opaque-action');
    form.set('role', 'owner');
    expect(objectFormValues(form)).toEqual({ displayName: 'Own draft' });
  });
  it('generates native-editor keys without changing explicit keys or weakening the strict parser', () => {
    const form = new FormData();
    form.set('field_0_label', 'Name');
    form.set('field_0_kind', 'text');
    form.set('field_1_label', 'Name');
    form.set('field_1_kind', 'text');
    form.set('field_2_label', 'Known');
    form.set('field_2_key', 'name');
    form.set('field_2_kind', 'text');
    expect(() => objectShapeInput(form)).toThrow();
    const normalized = withGeneratedObjectKeys(form);
    expect(objectShapeInput(normalized).fields.map((field) => field.key)).toEqual([
      'name_2',
      'name_3',
      'name',
    ]);
    expect(form.has('field_0_key')).toBe(false);
  });
  it('keeps multilingual labels and creates valid bounded unique keys', () => {
    const form = new FormData();
    for (const [index, label] of [
      'Серийный номер',
      '42 appareils',
      'é'.repeat(70),
      'é'.repeat(70),
    ].entries()) {
      form.set(`field_${index}_label`, label);
      form.set(`field_${index}_kind`, 'text');
    }
    const fields = objectShapeInput(withGeneratedObjectKeys(form)).fields;
    expect(fields.map((field) => field.label)).toEqual([
      'Серийный номер',
      '42 appareils',
      'é'.repeat(70),
      'é'.repeat(70),
    ]);
    expect(new Set(fields.map((field) => field.key)).size).toBe(4);
    for (const field of fields) expect(field.key).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
  });
  it('retains blank added rows, entered values and the original version through a refused form', () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({
      version: '3',
      fieldRows: '3',
      relationRows: '1',
      field_0_label: 'Pending name',
      field_0_kind: 'text',
      field_2_kind: 'number',
      relation_0_cardinality: 'many',
    }))
      form.set(key, value);
    const retained = objectFormValues(form);
    expect(objectEditorRows(retained, 1, 0)).toEqual({ fields: 3, relations: 1 });
    expect(retained.version).toBe('3');
    expect(retained.field_0_label).toBe('Pending name');
    expect(objectEditorRows({ fieldRows: '99', relationRows: '99' })).toEqual({
      fields: 64,
      relations: 16,
    });
  });
});
