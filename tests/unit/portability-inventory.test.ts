import { describe, expect, it } from 'vitest';
import {
  PORTABILITY_INVENTORY,
  PORTABILITY_INVENTORY_VERSION,
  assertPortabilitySections,
  matchesPortabilityInventory,
} from '@ensemus/domain/portability';
import { extensionRecordSchema } from '@ensemus/contracts/portability-records';
import { inspectOrganizationArchive, portableDefinitionBindings } from '@ensemus/application';
import { testRecipient } from '../helpers/sovereign';
import { buildArchive } from '../integration/fixtures/archive-builder';

const id = '10000000-0000-4000-8000-000000000001';
const at = '2026-11-07T00:00:00.000Z';
const definition = {
  kind: 'agent_definition',
  id,
  slug: 'example-agent',
  name: 'Example',
  owner_membership_id: id,
  service_identity_id: id,
  created_at: at,
};

describe('the versioned portability inventory', () => {
  it('refuses a missing, duplicate or unknown section rather than silently exporting nothing', () => {
    const names = [
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
      'agents',
      'skills',
      'policy',
      'knowledge',
    ];
    expect(() => assertPortabilitySections(names)).not.toThrow();
    for (const changed of [names.slice(1), [...names, 'agents'], [...names, 'unknown']]) {
      expect(() => assertPortabilitySections(changed)).toThrow();
    }
  });

  it('names private and credential state explicitly without making it a record', () => {
    expect(
      PORTABILITY_INVENTORY.find((entry) => entry.table === 'ai.step_payloads')?.disposition,
    ).toBe('private_excluded');
    expect(
      PORTABILITY_INVENTORY.find((entry) => entry.table === 'secrets.sealed_secrets')?.disposition,
    ).toBe('credentials_excluded');
    expect(new Set(PORTABILITY_INVENTORY.map((entry) => entry.table)).size).toBe(
      PORTABILITY_INVENTORY.length,
    );
  });
  it('checks semantic inventory entries independently of JSON property order', () => {
    const reordered = PORTABILITY_INVENTORY.map((item) => ({
      version: item.version,
      disposition: item.disposition,
      table: item.table,
      section: item.section,
    })).reverse();
    expect(matchesPortabilityInventory(reordered)).toBe(true);
    expect(matchesPortabilityInventory([...reordered.slice(1), reordered[1]])).toBe(false);
  });

  it('allows only reviewed columns, including nested definitions', () => {
    expect(extensionRecordSchema.safeParse(definition).success).toBe(true);
    for (const added of [
      { organization_id: id },
      { secret_ref: id },
      { content: 'private transcript' },
      { config: { refresh_token: 'secret' } },
      { published: true },
    ])
      expect(extensionRecordSchema.safeParse({ ...definition, ...added }).success).toBe(false);
    expect(
      extensionRecordSchema.safeParse({ kind: 'step_payload', id, content: 'private' }).success,
    ).toBe(false);
  });
  it('retains all source and structured references for later revocation, rather than one convenient Work', () => {
    const other = '20000000-0000-4000-8000-000000000002';
    const citation = extensionRecordSchema.parse({
      kind: 'artifact_citation',
      id,
      artifact_id: id,
      source_id: other,
      document_id: id,
      chunk_id: id,
      content_sha256: 'a'.repeat(64),
      artifact_start: 0,
      artifact_end: 1,
      created_at: at,
      work_unit_ids: [other, id, other],
    });
    expect(portableDefinitionBindings(citation)).toEqual({
      sources: [other],
      records: [
        { kind: 'work_unit', id },
        { kind: 'work_unit', id: other },
      ],
    });
    const edge = extensionRecordSchema.parse({
      kind: 'graph_edge',
      id,
      created_at: at,
      from_ref: `client:${id}`,
      to_ref: `work_unit:${other}`,
      relation: 'related_to',
      fact_id: null,
    });
    expect(portableDefinitionBindings(edge).records).toEqual([
      { kind: 'client', id },
      { kind: 'work_unit', id: other },
    ]);
  });
});

describe('hostile v2 archive inventories', () => {
  const recipient = testRecipient();
  const build = (
    records: readonly Record<string, unknown>[],
    alter?: (value: Record<string, unknown>) => unknown,
  ) =>
    buildArchive(
      recipient,
      {
        pages: [{ section: 'agents', recordKind: 'agent_definition', records }],
      },
      ({ manifest }) => {
        const value = {
          ...manifest,
          schema_version: 2,
          inventory_version: PORTABILITY_INVENTORY_VERSION,
          inventory: PORTABILITY_INVENTORY,
          generated_bodies_excluded: 0,
        };
        return { manifest: alter ? alter(value) : value };
      },
    );
  it('can inspect a complete explicit inventory without touching a database', async () => {
    const archive = build([definition]);
    expect(await inspectOrganizationArchive(archive.reader, recipient.privateKeyPem)).toMatchObject(
      { ok: true, manifest: { schema_version: 2 } },
    );
  });
  it('refuses an incomplete table inventory before applying records', async () => {
    const archive = build([definition], (value) => ({
      ...value,
      inventory: PORTABILITY_INVENTORY.slice(1),
    }));
    expect(await inspectOrganizationArchive(archive.reader, recipient.privateKeyPem)).toMatchObject(
      { ok: false, code: 'FORMAT_NOT_SUPPORTED' },
    );
  });
  it.each(['missing', 'unknown'] as const)('refuses %s section totals', async (kind) => {
    const archive = build([definition], (value) => {
      const sections = { ...(value.sections as Record<string, unknown>) };
      if (kind === 'missing') delete sections.policy;
      else sections.unknown = { records: 0, parts: 0 };
      return { ...value, sections };
    });
    expect(await inspectOrganizationArchive(archive.reader, recipient.privateKeyPem)).toMatchObject(
      { ok: false, code: 'MANIFEST_INVALID' },
    );
  });
  it('rejects a credential field even in an encrypted, correctly hashed extension part', async () => {
    const archive = build([{ ...definition, secret_ref: id }]);
    expect(await inspectOrganizationArchive(archive.reader, recipient.privateKeyPem)).toMatchObject(
      { ok: false, code: 'RECORD_REFUSED' },
    );
  });
});
