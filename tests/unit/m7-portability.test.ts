import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  PORTABILITY_INVENTORY,
  PORTABILITY_INVENTORY_VERSION,
  PORTABILITY_INVENTORY_V2,
  PORTABILITY_INVENTORY_V2_VERSION,
} from '@ensemus/domain/portability';
import {
  extensionRecordSchema,
  validatePortableRecord,
} from '@ensemus/contracts/portability-records';
import {
  encodeExportPage,
  inspectOrganizationArchive,
  portableDefinitionBindings,
} from '@ensemus/application';
import { testRecipient } from '../helpers/sovereign';
import { buildArchive } from '../integration/fixtures/archive-builder';

const id = '10000000-0000-4000-8000-000000000001',
  other = '10000000-0000-4000-8000-000000000002',
  at = '2026-11-07T00:00:00.000Z';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const fields = [
    { key: 'note', label: 'Note', kind: 'text', required: false, indexed: false, maxLength: 100 },
  ],
  relations: never[] = [];
const record = {
  kind: 'custom_object_record',
  id,
  type_id: other,
  type_version_number: 1,
  display_name: 'Example',
  classification: 'internal',
  type_classification: 'internal',
  owner_membership_id: id,
  version: 1,
  created_at: at,
  updated_at: at,
  type_slug: 'customer_note',
  fields,
  relations,
  schema_sha256: hash({ fields, relations }),
  attributes: { note: 'Example' },
};
const recipient = testRecipient();
const archive = (value: Record<string, unknown>, profile = PORTABILITY_INVENTORY_VERSION) =>
  buildArchive(
    recipient,
    {
      pages: [{ section: 'custom-objects', recordKind: 'custom_object_record', records: [value] }],
    },
    ({ manifest }) => ({
      manifest: {
        ...manifest,
        schema_version: 2,
        inventory_version: profile,
        inventory:
          profile === PORTABILITY_INVENTORY_VERSION
            ? PORTABILITY_INVENTORY
            : PORTABILITY_INVENTORY_V2,
        generated_bodies_excluded: 0,
        ...(profile === PORTABILITY_INVENTORY_VERSION ? { record_max_bytes: 4194304 } : {}),
      },
    }),
  );
describe('actual scripted /3 transport boundary (no database or model acceptance)', () => {
  it('reads an encrypted, correctly hashed pinned custom record', async () =>
    expect(
      await inspectOrganizationArchive(archive(record).reader, recipient.privateKeyPem),
    ).toMatchObject({ ok: true }));
  it('refuses a fabricated pinned schema even in a correctly encrypted part', async () =>
    expect(
      await inspectOrganizationArchive(
        archive({ ...record, schema_sha256: '0'.repeat(64) }).reader,
        recipient.privateKeyPem,
      ),
    ).toMatchObject({ ok: false, code: 'RECORD_REFUSED' }));
  it('refuses restricted body fields and live execution fields', () => {
    for (const extra of [
      { classification: 'restricted' },
      { run_id: id },
      { active: true },
      { grants: [] },
    ])
      expect(extensionRecordSchema.safeParse({ ...record, ...extra }).success).toBe(false);
  });
  it('does not change legacy /2 meaning to include object bodies', () =>
    expect(() =>
      validatePortableRecord('custom-objects', record, PORTABILITY_INVENTORY_V2_VERSION),
    ).toThrow());
  it('refuses object parts declared under legacy /2', async () =>
    expect(
      await inspectOrganizationArchive(
        archive(record, PORTABILITY_INVENTORY_V2_VERSION).reader,
        recipient.privateKeyPem,
      ),
    ).toMatchObject({ ok: false }));
  it('retains both endpoint IDs for later quarantine privacy checks', () => {
    const relation = extensionRecordSchema.parse({
      kind: 'custom_object_relation',
      id,
      created_at: at,
      classification: 'internal',
      relation_key: 'related',
      from_record_id: id,
      to_record_id: other,
    });
    expect(portableDefinitionBindings(relation).records).toEqual([
      { kind: 'object_record', id },
      { kind: 'object_record', id: other },
    ]);
  });
  it('carries legal pinned schemas above the old 1MiB boundary without truncation', async () => {
    const largeFields = Array.from({ length: 64 }, (_, i) => ({
      key: `field_${i}`,
      label: `Field ${i}`,
      kind: 'enum',
      required: false,
      indexed: false,
      options: Array.from({ length: 64 }, (_, j) => `${j}`.padEnd(120, '界')),
    }));
    const value = {
      ...record,
      fields: largeFields,
      attributes: {},
      schema_sha256: hash({ fields: largeFields, relations }),
    };
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(1048576);
    expect(encodeExportPage('custom-objects', [value])).toMatchObject({ ok: true, count: 1 });
    expect(
      await inspectOrganizationArchive(archive(value).reader, recipient.privateKeyPem),
    ).toMatchObject({ ok: true });
  });
  it('visibly excludes private native and runtime admission metadata', () => {
    for (const table of [
      'studio.simulation_inputs',
      'identity.session_assurances',
      'ai.model_workload_approvals',
      'ai.model_call_inputs',
    ]) {
      const entry = PORTABILITY_INVENTORY.find((row) => row.table === table);
      expect(entry).toBeDefined();
      expect(entry?.disposition).toMatch(/excluded$/);
    }
    for (const kind of ['simulation_input', 'session_assurance', 'model_workload_approval'])
      expect(extensionRecordSchema.safeParse({ kind, id }).success).toBe(false);
  });
});
