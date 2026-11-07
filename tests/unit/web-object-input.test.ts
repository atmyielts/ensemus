import { describe, it, expect } from 'vitest';
import {
  objectAttributeInput,
  objectShapeInput,
  objectFormValues,
  objectFieldsInput,
} from '../../apps/web/src/lib/object-input';
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
});
