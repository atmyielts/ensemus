import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { canonicalJson } from './approval';
import { assertPortableDefinitionIntegrity } from './portable-definition';
import {
  portableRecordByteLimit,
  PORTABILITY_INVENTORY_VERSION,
  PORTABILITY_INVENTORY_V2_VERSION,
  LEGACY_PORTABILITY_INVENTORY_VERSION,
} from './portability';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fields = [
  { key: 'note', label: 'Note', kind: 'text', required: true, indexed: false, maxLength: 100 },
];
const shape = { fields, relations: [] };
const object = () => ({
  kind: 'custom_object_record',
  type_slug: 'customer_note',
  ...shape,
  schema_sha256: hash(shape),
  classification: 'internal',
  type_classification: 'internal',
  attributes: { note: 'A generated example' },
});
const process = (steps: unknown[]) => {
  const spec = { schemaVersion: 1, classification: 'internal', steps };
  return { kind: 'process_spec', classification: 'internal', spec, spec_sha256: hash(spec) };
};
const step = (key: string, after: string[] = []) => ({
  key,
  after,
  kind: 'work_item',
  label: 'A generated example',
  labelCode: null,
});
describe('deterministic portable definition integrity (not model quality)', () => {
  it('validates the exact pinned custom schema and attributes', () =>
    expect(() => assertPortableDefinitionIntegrity(object())).not.toThrow());
  it('refuses a changed schema with the original hash', () =>
    expect(() =>
      assertPortableDefinitionIntegrity({
        ...object(),
        fields: [{ ...fields[0], required: false }],
      }),
    ).toThrow('RECORD_REFUSED'));
  it('refuses an attribute absent from the pinned schema', () =>
    expect(() =>
      assertPortableDefinitionIntegrity({
        ...object(),
        attributes: { note: 'valid', secret: 'not in schema' },
      }),
    ).toThrow('RECORD_REFUSED'));
  it('refuses missing required values', () =>
    expect(() => assertPortableDefinitionIntegrity({ ...object(), attributes: {} })).toThrow(
      'RECORD_REFUSED',
    ));
  it('refuses lowering a record below its current type floor', () =>
    expect(() =>
      assertPortableDefinitionIntegrity({ ...object(), type_classification: 'confidential' }),
    ).toThrow('RECORD_REFUSED'));
  it('refuses restricted values in a standard projection', () =>
    expect(() =>
      assertPortableDefinitionIntegrity({ ...object(), classification: 'restricted' }),
    ).toThrow('RECORD_REFUSED'));
  it('checks a valid compiled acyclic graph and its exact hash', () =>
    expect(() =>
      assertPortableDefinitionIntegrity(process([step('first'), step('second', ['first'])])),
    ).not.toThrow());
  it('refuses a changed compiled spec even when its graph is valid', () =>
    expect(() =>
      assertPortableDefinitionIntegrity({
        ...process([step('first')]),
        spec_sha256: '0'.repeat(64),
      }),
    ).toThrow('RECORD_REFUSED'));
  it('refuses a cycle even if an attacker recomputes the hash', () =>
    expect(() =>
      assertPortableDefinitionIntegrity(
        process([step('first', ['second']), step('second', ['first'])]),
      ),
    ).toThrow('RECORD_REFUSED'));
  it('refuses missing predecessors and duplicate step keys', () => {
    for (const steps of [[step('first', ['absent'])], [step('first'), step('first')]])
      expect(() => assertPortableDefinitionIntegrity(process(steps))).toThrow('RECORD_REFUSED');
  });
  it('refuses mismatched draft ownership', () =>
    expect(() =>
      assertPortableDefinitionIntegrity({
        kind: 'studio_agent_draft',
        owner_membership_id: 'one',
        answers: { ownerMembershipId: 'another' },
      }),
    ).toThrow('RECORD_REFUSED'));
  it('preserves old byte limits while declaring the new bound explicitly', () => {
    for (const profile of [
      undefined,
      LEGACY_PORTABILITY_INVENTORY_VERSION,
      PORTABILITY_INVENTORY_V2_VERSION,
    ])
      expect(portableRecordByteLimit(profile)).toBe(1048576);
    expect(portableRecordByteLimit(PORTABILITY_INVENTORY_VERSION)).toBe(4194304);
    expect(() => portableRecordByteLimit('future')).toThrow();
  });
});
