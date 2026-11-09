import { describe, expect, it } from 'vitest';
import {
  EXPORT_SECTIONS,
  PORTABILITY_INVENTORY,
  PORTABILITY_INVENTORY_VERSION,
  assertPortabilitySections,
  matchesPortabilityInventory,
  PORTABILITY_INVENTORY_V1,
  LEGACY_PORTABILITY_INVENTORY_VERSION,
  PORTABILITY_INVENTORY_V2,
  PORTABILITY_INVENTORY_V2_VERSION,
} from '@ensemus/domain/portability';
import {
  exportManifestSchema,
  extensionRecordSchema,
} from '@ensemus/contracts/portability-records';
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

describe('the manifest inventory wire bound', () => {
  const manifest = {
    format: 'ensemus.organization_export',
    schema_version: 2,
    export_id: id,
    organization_id: id,
    exported_at: at,
    snapshot_at: at,
    tombstones_through: at,
    initiated_by_membership_id: id,
    source_release: 'generated-ci-fixture',
    scope: 'standard',
    excluded: { restricted_work: 0, restricted_artifacts: 0, restricted_clients: 0 },
    sections: Object.fromEntries(EXPORT_SECTIONS.map((name) => [name, { records: 0, parts: 0 }])),
    parts: [],
    encryption: { scheme: 'ensemus.sealed/v1', recipient_key_id: 'a'.repeat(32) },
    inventory_version: PORTABILITY_INVENTORY_VERSION,
    record_max_bytes: 4 * 1024 * 1024,
    generated_bodies_excluded: 0,
    inventory: PORTABILITY_INVENTORY,
  };
  it('accepts the complete current explicit inventory', () => {
    expect(PORTABILITY_INVENTORY.length).toBeGreaterThan(200);
    expect(exportManifestSchema.safeParse(manifest).success).toBe(true);
  });
  it('still rejects an oversized inventory before archive processing', () => {
    const result = exportManifestSchema.safeParse({
      ...manifest,
      inventory: Array.from({ length: 257 }, () => PORTABILITY_INVENTORY[0]),
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(
        result.error.issues.some(
          (issue) => issue.code === 'too_big' && issue.path.join('.') === 'inventory',
        ),
      ).toBe(true);
  });
});

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
      'custom-objects',
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
  it('requires every joined material and payment witness without importing execution authority', () => {
    const tables = [
      'ai.run_authority_checkpoints',
      'ai.run_read_authorities',
      'ai.delegated_input_receipts',
      'ai.delegated_input_refs',
      'ai.delegated_work_births',
      'knowledge.artifact_authority_receipts',
      'knowledge.artifact_authority_refs',
      'ai.source_run_closures',
      'ai.record_purge_jobs',
      'ai.record_run_closures',
      'lifecycle.delegated_erasure_receipts',
      'billing.payment_identity_attestations',
      'billing.payment_execution_bindings',
      'billing.payment_customer_bindings',
      'billing.payment_webhook_bindings',
      'billing.payment_webhook_attestations',
      'lifecycle.raw_source_inventories',
      'lifecycle.raw_object_writes',
    ];
    for (const table of tables) {
      const entries = PORTABILITY_INVENTORY.filter((entry) => entry.table === table);
      expect(entries, table).toHaveLength(1);
      expect(entries[0]?.disposition, table).toBe('operational_excluded');
      expect(
        PORTABILITY_INVENTORY_V2.some((entry) => entry.table === table),
        table,
      ).toBe(false);
      expect(
        matchesPortabilityInventory(PORTABILITY_INVENTORY.filter((entry) => entry.table !== table)),
        table,
      ).toBe(false);
      expect(
        matchesPortabilityInventory(
          PORTABILITY_INVENTORY.map((entry) =>
            entry.table === table ? { ...entry, disposition: 'records' } : entry,
          ),
        ),
        table,
      ).toBe(false);
      expect(
        extensionRecordSchema.safeParse({ kind: table.split('.')[1], id }).success,
        table,
      ).toBe(false);
    }
  });
  it('versions the new execution metadata without copying private lineage or reactivating writers', () => {
    expect(PORTABILITY_INVENTORY_VERSION).toBe('ensemus.m3-m7/3');
    expect(PORTABILITY_INVENTORY_V2).toHaveLength(PORTABILITY_INVENTORY_V1.length + 3);
    expect(
      matchesPortabilityInventory(PORTABILITY_INVENTORY_V2, PORTABILITY_INVENTORY_V2_VERSION),
    ).toBe(true);
    expect(
      PORTABILITY_INVENTORY.filter((entry) =>
        ['ai.run_input_checkpoints', 'ai.run_output_writes'].includes(entry.table),
      ).map((entry) => entry.disposition),
    ).toEqual(['operational_excluded', 'operational_excluded']);
    expect(
      PORTABILITY_INVENTORY.find((entry) => entry.table === 'ai.run_input_observations')
        ?.disposition,
    ).toBe('private_excluded');
    expect(
      matchesPortabilityInventory(PORTABILITY_INVENTORY_V1, LEGACY_PORTABILITY_INVENTORY_VERSION),
    ).toBe(true);
    expect(matchesPortabilityInventory(PORTABILITY_INVENTORY_V1)).toBe(false);
    expect(
      matchesPortabilityInventory(PORTABILITY_INVENTORY, LEGACY_PORTABILITY_INVENTORY_VERSION),
    ).toBe(false);
    expect(
      matchesPortabilityInventory([
        ...PORTABILITY_INVENTORY,
        {
          table: 'ai.future_authority',
          section: 'agents',
          disposition: 'operational_excluded',
          version: 1,
        },
      ]),
    ).toBe(false);
    for (const kind of ['run_input_checkpoint', 'run_input_observation', 'run_output_write'])
      expect(
        extensionRecordSchema.safeParse({
          kind,
          id,
          run_id: id,
          content: 'never portable',
          fence_generation: 1,
        }).success,
      ).toBe(false);
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
          record_max_bytes: 4194304,
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
  it('reads an explicit legacy /1 inventory as inert records, without inferring new execution state', async () => {
    const archive = build([definition], (value) => ({
      ...value,
      inventory_version: LEGACY_PORTABILITY_INVENTORY_VERSION,
      inventory: PORTABILITY_INVENTORY_V1,
      record_max_bytes: undefined,
    }));
    expect(await inspectOrganizationArchive(archive.reader, recipient.privateKeyPem)).toMatchObject(
      { ok: true, manifest: { inventory_version: LEGACY_PORTABILITY_INVENTORY_VERSION } },
    );
  });
  it('names an unsupported future inventory version', async () => {
    const archive = build([definition], (value) => ({
      ...value,
      inventory_version: 'ensemus.m3-m5/3',
    }));
    expect(await inspectOrganizationArchive(archive.reader, recipient.privateKeyPem)).toMatchObject(
      { ok: false, code: 'FORMAT_NOT_SUPPORTED' },
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
