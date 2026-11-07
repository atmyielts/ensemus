// ADR-030 D8: an archive is hostile input. Each way of being wrong is a named failure, with nothing thrown raw and
// nothing written. No database here: the runner goes against a small double that only remembers what it was told
// to write, which is enough to see what was written and what was not. The rows themselves, under real roles and
// real triggers, are tests/integration/organization-import.test.ts.
import { createHash, randomUUID } from 'node:crypto';
import {
  CORE_PORTABILITY_SECTIONS,
  inspectOrganizationArchive,
  objectKey,
  parentsFirst,
  runOrganizationImport,
  type ImportRunDeps,
} from '@ensemus/application';
import {
  domainEvents,
  importedPeople,
  memberships,
  organizationImportParts,
  organizationImports,
  type AppDatabase,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  EXPORT_MANIFEST_PATH,
  MAX_RECORD_BYTES,
  recordPartPath,
  PORTABILITY_INVENTORY,
} from '@ensemus/domain/portability';
import { ledgerKeyFor, serializeLedgerEntry } from '@ensemus/domain/tombstone-ledger';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  archiveReader,
  buildArchive,
  buildTar,
  jsonLines,
  sealManifest,
  sealPart,
  sourceTenant,
  type ArchiveSpec,
  manifestFor,
} from '../integration/fixtures/archive-builder';
import { testRecipient } from '../helpers/sovereign';

const recipient = testRecipient();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const inspect = (bytes: Buffer) =>
  inspectOrganizationArchive(archiveReader(bytes), recipient.privateKeyPem);

/** A small honest archive, for damaging one thing at a time. */
const clientsOnly = (records: readonly Record<string, unknown>[]): ArchiveSpec => ({
  pages: [{ section: 'clients', recordKind: 'clients', records }],
});
const goodClient = () => ({
  kind: 'client',
  id: randomUUID(),
  display_name: 'A client',
  classification: 'internal',
  created_at: '2026-01-02T03:04:05.000Z',
});

/** The archive, and what its one extra file would look like, with a manifest listing what it is told to. */
const withReplacedRecords = (section: 'clients' | 'work', lines: Buffer, records: number) => {
  const path = recordPartPath(section, section === 'clients' ? 'clients' : 'work_units', 1);
  const { file, part } = sealPart(recipient, section, path, lines, records);
  const honest = buildArchive(recipient, clientsOnly([]));
  const manifest = { ...honest.manifest, ...manifestFor(recipient, [part], {}) };
  return buildTar([sealManifest(recipient, manifest), file]);
};

describe('a hostile archive is a named failure', () => {
  it('accepts an honest one, so that none of these pass by refusing everything', async () => {
    const { spec } = sourceTenant();
    const result = await inspect(buildArchive(recipient, spec).bytes);
    expect(result).toMatchObject({ ok: true });
  });

  it('path traversal in a tar name', async () => {
    const built = buildArchive(recipient, clientsOnly([goodClient()]), ({ files }) => ({
      files: [...files, { path: '../../etc/passwd', bytes: Buffer.from('x') }],
    }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'PATH_REFUSED' });
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a path inside a section', 'clients/../../x-000001.jsonl.sealed'],
    ['a backslash', 'clients\\clients-000001.jsonl.sealed'],
    ['a section that does not exist', 'nope/clients-000001.jsonl.sealed'],
    ['bytes outside the artifacts folder', `clients/${randomUUID()}.bin.sealed`],
    ['a file with no seal', 'clients/clients-000001.jsonl'],
  ])('a path that is not one the format makes: %s', async (_name, path) => {
    const built = buildArchive(recipient, clientsOnly([]), ({ files }) => ({
      files: [...files, { path, bytes: Buffer.from('x') }],
    }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'PATH_REFUSED' });
  });

  it('a symbolic link', async () => {
    const built = buildArchive(recipient, clientsOnly([]), ({ files }) => ({
      files: [
        ...files,
        { path: recordPartPath('clients', 'clients', 2), bytes: Buffer.alloc(0), linkTo: true },
      ],
    }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'ARCHIVE_UNREADABLE' });
  });

  it('a truncated archive', async () => {
    const { bytes } = buildArchive(recipient, clientsOnly([goodClient()]));
    for (const keep of [0, 100, 512, bytes.length - 1024, bytes.length - 2000]) {
      expect(await inspect(bytes.subarray(0, keep))).toMatchObject({
        ok: false,
        code: expect.stringMatching(/^(ARCHIVE_UNREADABLE|MANIFEST_INVALID)$/),
      });
    }
    expect(await inspect(bytes.subarray(0, bytes.length - 1024))).toMatchObject({
      code: 'ARCHIVE_UNREADABLE',
    });
  });

  it('something that is not a tar at all, and a reader that fails', async () => {
    expect(await inspect(Buffer.from('not a tar'.repeat(200)))).toMatchObject({
      code: 'ARCHIVE_UNREADABLE',
    });
    const broken = {
      totalBytes: 4096,
      readAt: async () => {
        throw new Error('disk');
      },
    };
    expect(await inspectOrganizationArchive(broken, recipient.privateKeyPem)).toMatchObject({
      code: 'ARCHIVE_UNREADABLE',
    });
  });

  it('a manifest listing a part that is absent', async () => {
    const built = buildArchive(recipient, clientsOnly([goodClient()]), () => ({ files: [] }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'PART_MISSING' });
  });

  it('an extra entry', async () => {
    const built = buildArchive(recipient, clientsOnly([goodClient()]), ({ files }) => ({
      files: [
        ...files,
        { path: recordPartPath('clients', 'clients', 2), bytes: Buffer.from('more') },
      ],
    }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'MANIFEST_INVALID' });
  });

  it('a duplicate entry', async () => {
    const built = buildArchive(recipient, clientsOnly([goodClient()]), ({ files }) => ({
      files: [...files, ...files],
    }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'MANIFEST_INVALID' });
  });

  it('a part listed twice, and a part said to be in another section', async () => {
    const twice = buildArchive(recipient, clientsOnly([goodClient()]), ({ manifest }) => ({
      manifest: { ...manifest, parts: [...manifest.parts, ...manifest.parts] },
    }));
    expect(await inspect(twice.bytes)).toMatchObject({ code: 'MANIFEST_INVALID' });
    const moved = buildArchive(recipient, clientsOnly([goodClient()]), ({ manifest }) => ({
      manifest: {
        ...manifest,
        parts: manifest.parts.map((part) => ({ ...part, section: 'work' })),
      },
    }));
    expect(await inspect(moved.bytes)).toMatchObject({ code: 'MANIFEST_INVALID' });
  });

  it('no manifest', async () => {
    const bytes = buildTar([
      { path: recordPartPath('clients', 'clients', 1), bytes: Buffer.from('x') },
    ]);
    expect(await inspect(bytes)).toMatchObject({ code: 'MANIFEST_INVALID' });
  });

  it('a manifest that is not JSON, and one with an extra field', async () => {
    const notJson = buildTar([
      {
        path: EXPORT_MANIFEST_PATH,
        bytes: sealPart(recipient, 'clients', 'x', Buffer.from('{not json'), 0).file.bytes,
      },
    ]);
    expect(await inspect(notJson)).toMatchObject({ code: 'MANIFEST_INVALID' });
    const extra = buildArchive(recipient, clientsOnly([]), ({ manifest }) => ({
      manifest: { ...manifest, signed_by_someone: true },
    }));
    expect(await inspect(extra.bytes)).toMatchObject({ code: 'MANIFEST_INVALID' });
  });

  it('a manifest naming another recipient than the one who could open it', async () => {
    const built = buildArchive(recipient, clientsOnly([]), ({ manifest }) => ({
      manifest: {
        ...manifest,
        encryption: { ...manifest.encryption, recipient_key_id: testRecipient().keyId },
      },
    }));
    expect(await inspect(built.bytes)).toMatchObject({ code: 'MANIFEST_INVALID' });
  });

  it('a sealed hash that differs', async () => {
    const built = buildArchive(recipient, clientsOnly([goodClient()]), ({ manifest }) => ({
      manifest: {
        ...manifest,
        parts: manifest.parts.map((part) => ({ ...part, sealed_sha256: '0'.repeat(64) })),
      },
    }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'PART_CHANGED' });
  });

  it('a size that differs, before anything that large would be read', async () => {
    const built = buildArchive(recipient, clientsOnly([goodClient()]), ({ manifest }) => ({
      manifest: {
        ...manifest,
        parts: manifest.parts.map((part) => ({ ...part, sealed_bytes: part.sealed_bytes + 1 })),
      },
    }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'PART_CHANGED' });
  });

  it('a byte changed inside a part, with the hashes changed to suit it', async () => {
    const built = buildArchive(recipient, clientsOnly([goodClient()]), ({ manifest, files }) => {
      const damaged = Buffer.from((files[0] as { bytes: Buffer }).bytes);
      damaged[damaged.length - 1] = (damaged[damaged.length - 1] as number) ^ 1;
      return {
        files: [{ path: (files[0] as { path: string }).path, bytes: damaged }],
        manifest: {
          ...manifest,
          parts: manifest.parts.map((part) => ({ ...part, sealed_sha256: sha256(damaged) })),
        },
      };
    });
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'PART_CHANGED' });
  });

  it('a plain hash that differs', async () => {
    const built = buildArchive(recipient, clientsOnly([goodClient()]), ({ manifest }) => ({
      manifest: {
        ...manifest,
        parts: manifest.parts.map((part) => ({ ...part, plaintext_sha256: 'f'.repeat(64) })),
      },
    }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'PART_CHANGED' });
  });

  it('a part sealed to another key, naming that key', async () => {
    const other = testRecipient();
    const lines = jsonLines([goodClient()]);
    const path = recordPartPath('clients', 'clients', 1);
    const { file, part } = sealPart(other, 'clients', path, lines, 1);
    const honest = buildArchive(recipient, clientsOnly([]));
    const bytes = buildTar([
      sealManifest(recipient, { ...honest.manifest, ...manifestFor(recipient, [part], {}) }),
      file,
    ]);
    expect(await inspect(bytes)).toEqual({
      ok: false,
      code: 'WRONG_KEY',
      archiveKeyId: other.keyId,
    });
  });

  it('the wrong key for the whole archive, naming which key it is for', async () => {
    const { bytes } = buildArchive(recipient, clientsOnly([]));
    const other = testRecipient();
    expect(await inspectOrganizationArchive(archiveReader(bytes), other.privateKeyPem)).toEqual({
      ok: false,
      code: 'WRONG_KEY',
      archiveKeyId: recipient.keyId,
    });
  });

  it('a file that is no key at all, naming which key it is for', async () => {
    const { bytes } = buildArchive(recipient, clientsOnly([]));
    expect(await inspectOrganizationArchive(archiveReader(bytes), 'not a key')).toEqual({
      ok: false,
      code: 'WRONG_KEY',
      archiveKeyId: recipient.keyId,
    });
  });

  it('a record with an extra field', async () => {
    const built = buildArchive(
      recipient,
      clientsOnly([{ ...goodClient(), organization_id: randomUUID() }]),
    );
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'RECORD_REFUSED' });
  });

  it('a credential has nowhere to sit in a connection', async () => {
    const built = buildArchive(recipient, {
      pages: [
        {
          section: 'connections',
          recordKind: 'connections',
          records: [
            {
              kind: 'connection',
              id: randomUUID(),
              connector_type: 'test_connector',
              display_name: 'A connection',
              granted_scopes: [],
              created_at: '2026-01-02T03:04:05.000Z',
              credential: 'not-a-real-credential',
            },
          ],
        },
      ],
    });
    expect(await inspect(built.bytes)).toMatchObject({ code: 'RECORD_REFUSED' });
  });

  it('a record in the wrong section', async () => {
    const built = buildArchive(recipient, {
      pages: [
        {
          section: 'clients',
          recordKind: 'clients',
          records: [
            {
              kind: 'tombstone',
              target_type: 'artifact',
              target_id: randomUUID(),
              deleted_at: '2026-01-02T03:04:05.000Z',
            },
          ],
        },
      ],
    });
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'RECORD_REFUSED' });
  });

  it('a part with two kinds of record in it', async () => {
    const built = buildArchive(recipient, {
      pages: [
        {
          section: 'relations',
          recordKind: 'work_dependencies',
          records: [
            {
              kind: 'work_dependency',
              prerequisite_id: randomUUID(),
              dependent_id: randomUUID(),
            },
            { kind: 'team_membership', team_id: randomUUID(), membership_id: randomUUID() },
          ],
        },
      ],
    });
    expect(await inspect(built.bytes)).toMatchObject({ code: 'RECORD_REFUSED' });
  });

  it('restricted work, which `standard` scope cannot hold at either end', async () => {
    const built = buildArchive(
      recipient,
      clientsOnly([{ ...goodClient(), classification: 'restricted' }]),
    );
    expect(await inspect(built.bytes)).toMatchObject({ code: 'RECORD_REFUSED' });
  });

  it('an ID in capitals, which would pass a tombstone it should have matched', async () => {
    const built = buildArchive(
      recipient,
      clientsOnly([{ ...goodClient(), id: randomUUID().toUpperCase() }]),
    );
    expect(await inspect(built.bytes)).toMatchObject({ code: 'RECORD_REFUSED' });
  });

  it('a record over MAX_RECORD_BYTES', async () => {
    const line = JSON.stringify({ ...goodClient(), display_name: 'x'.repeat(MAX_RECORD_BYTES) });
    expect(
      await inspect(withReplacedRecords('clients', Buffer.from(`${line}\n`), 1)),
    ).toMatchObject({ ok: false, code: 'RECORD_REFUSED' });
  });

  it.each([
    ['not JSON', Buffer.from('{not json}\n'), 1],
    ['bytes that are not UTF-8', Buffer.from([0xff, 0xfe, 0x0a]), 1],
    ['a blank line in the middle', Buffer.from(`${JSON.stringify(goodClient())}\n\n{}\n`), 3],
    ['fewer lines than the manifest says', jsonLines([goodClient()]), 2],
    ['more lines than the manifest says', jsonLines([goodClient(), goodClient()]), 1],
    ['nesting deep enough to hurt', Buffer.from(`${'['.repeat(200_000)}\n`), 1],
  ])('%s', async (_name, lines, records) => {
    expect(await inspect(withReplacedRecords('clients', lines, records))).toMatchObject({
      ok: false,
      code: 'RECORD_REFUSED',
    });
  });

  it('a schema version from the future', async () => {
    const built = buildArchive(recipient, clientsOnly([]), ({ manifest }) => ({
      manifest: { ...manifest, schema_version: 3, a_new_field: true },
    }));
    expect(await inspect(built.bytes)).toMatchObject({ ok: false, code: 'FORMAT_NOT_SUPPORTED' });
  });

  it('bytes that do not match what a file says of itself', async () => {
    const { spec, ids } = sourceTenant();
    const built = buildArchive(recipient, {
      ...spec,
      files: { [ids.keptFile]: Buffer.from('other bytes') },
    });
    expect(await inspect(built.bytes)).toMatchObject({ code: 'PART_CHANGED' });
  });
});

describe('finding work parents an order', () => {
  const unit = (id: string, parent: string | null) => ({ id, parent_id: parent });

  it('puts every parent ahead of its children, wherever they started', () => {
    const { ordered, broken } = parentsFirst([
      unit('c', 'b'),
      unit('b', 'a'),
      unit('a', null),
      unit('d', 'elsewhere'),
    ]);
    expect(ordered.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd']);
    expect(broken.size).toBe(0);
  });

  it('breaks a loop by naming the record that closes it, and a record its own parent', () => {
    const loop = parentsFirst([unit('a', 'b'), unit('b', 'a'), unit('self', 'self')]);
    expect(loop.ordered).toHaveLength(3);
    expect(loop.broken.has('self')).toBe(true);
    expect([...loop.broken].filter((id) => id !== 'self')).toHaveLength(1);
  });
});

/**
 * Just enough of a database to run the runner: it remembers what it was told to write, and answers a select from
 * what it holds. It is no check on SQL, roles or triggers, which the integration test is for.
 */
function fakeDatabase(row: Record<string, unknown>) {
  // Explicit scripted metadata port only. It checks parser/registration ordering; SQL admission,
  // one-use effects, rollback and artifact provenance are real-role gates, not simulated here.
  const scope = new Map<string, string>();
  let manifest: Record<string, unknown> | undefined;
  const parts = new Map<string, { hash: string; records: unknown[] }>();
  let verified = false;
  let lastQuery = '';
  const writes: { table: string; values: Record<string, unknown> }[] = [];
  const updates: { table: string; set: Record<string, unknown> }[] = [];
  const nameOf = getTableConfigName;
  const chain = (result: () => unknown[]): unknown =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
              try {
                resolve(result());
              } catch (error) {
                reject(error);
              }
            };
          }
          return () => chain(result);
        },
      },
    );
  const rowsOf = (table: PgTable) => {
    if (table === organizationImports) return [row];
    if (table === organizationImportParts) {
      return writes.filter((write) => write.table === nameOf(table)).map((write) => write.values);
    }
    if (table === importedPeople) {
      return writes
        .filter((write) => write.table === nameOf(table))
        .map((write) => ({ source: write.values.sourceMembershipId, target: null }));
    }
    if (table === memberships) return [{ n: 1, id: row.fallbackMembershipId }];
    // A count of nothing, and an `id` for anything looked up, so that links are found.
    return [{ n: 0, id: 'found' }];
  };
  const tx = {
    execute: async (query: SQL) => {
      const compiled = new PgDialect().sqlToQuery(query),
        text = compiled.sql,
        params = compiled.params;
      lastQuery = text;
      if (text.includes('current_setting(name,true)'))
        return {
          rows: (params[0] as string[]).map((name) => ({ name, value: scope.get(name) ?? null })),
        };
      if (text.includes('set_config')) {
        scope.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (text.includes('register_import_manifest')) {
        const body = JSON.parse((params[2] as Buffer).toString()) as Record<string, unknown>;
        if (row.archiveSha256 && row.archiveSha256 !== params[1])
          throw new Error('TEST_ARCHIVE_CHANGED');
        manifest = body;
        Object.assign(row, {
          archiveSha256: params[1],
          sourceExportId: body.export_id,
          sourceOrganizationId: body.organization_id,
          sourceRelease: body.source_release,
          exportedAt: new Date(body.exported_at as string),
        });
        return { rows: [] };
      }
      if (text.includes('register_import_part')) {
        const part = (
            manifest?.parts as
              { path: string; records: number; plaintext_sha256: string }[] | undefined
          )?.find((part) => part.path === params[1]),
          plain = params[2] as Buffer;
        if (!part || sha256(plain) !== part.plaintext_sha256) throw new Error('TEST_PART_CHANGED');
        parts.set(part.path, {
          hash: part.plaintext_sha256,
          records:
            part.records && !part.path.endsWith('.bin.sealed')
              ? plain
                  .toString()
                  .trimEnd()
                  .split('\n')
                  .map((line) => JSON.parse(line) as unknown)
              : [],
        });
        return { rows: [] };
      }
      if (text.includes('complete_import_verification')) {
        if (
          !(manifest?.parts as { path: string }[] | undefined)?.every((part) =>
            parts.has(part.path),
          )
        )
          throw new Error('TEST_PART_MISSING');
        verified = true;
        return { rows: [] };
      }
      if (text.includes('prepare_import_effect')) {
        const source = JSON.parse(params[2] as string) as unknown,
          part = parts.get(scope.get('app.portability_part_path') ?? '');
        if (
          !verified ||
          scope.get('app.portability_import_id') !== row.id ||
          part?.hash !== scope.get('app.portability_part_sha256') ||
          !part.records.some((record) => canonicalJson(record) === canonicalJson(source))
        )
          throw new Error('TEST_UNVERIFIED_EFFECT');
        return { rows: [{ target: 'scripted' }] };
      }
      if (text.includes('to_regclass'))
        return { rows: PORTABILITY_INVENTORY.map((entry) => ({ table_name: entry.table })) };
      if (text.includes('pg_catalog.pg_tables'))
        return {
          rows: PORTABILITY_INVENTORY.filter((entry) =>
            /^(ai|knowledge|integrations)\./.test(entry.table),
          ).map((entry) => ({ table_name: entry.table })),
        };
      if (text.includes("'knowledge_source' as kind")) return { rows: [] };
      throw new Error(
        'This unit fixture has no answer for that SQL; use the real-role integration gate.',
      );
    },
    select: () => ({ from: (table: PgTable) => chain(() => rowsOf(table)) }),
    insert: (table: PgTable) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table: nameOf(table), values });
        return chain(() => [{ id: 'new' }]);
      },
    }),
    update: (table: PgTable) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table: nameOf(table), set });
        if (table === organizationImports) Object.assign(row, set);
        return chain(() => [row]);
      },
    }),
    delete: () => chain(() => []),
    transaction: (fn: (inner: unknown) => Promise<unknown>) => fn(tx),
  };
  const database = {
    transaction: (_bindings: unknown, fn: (inner: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as AppDatabase;
  return { database, writes, updates, lastQuery: () => lastQuery };
}

const memoryStore = (ledgerEntries: Readonly<Record<string, Buffer>> = {}) => {
  const objects = new Map<string, Buffer>();
  const deps: Pick<ImportRunDeps, 'ledger' | 'store'> = {
    store: {
      put: async (key, body) => void objects.set(key, body),
      exists: async (key) => objects.has(key),
      delete: async (key) => void objects.delete(key),
    },
    ledger: {
      async *listPages(prefix: string) {
        yield Object.keys(ledgerEntries).filter((key) => key.startsWith(prefix));
      },
      get: async (key) => ledgerEntries[key] as Buffer,
    },
  };
  return { objects, deps };
};

const importRow = (organizationId: string, overrides: Record<string, unknown> = {}) => {
  const fallback = randomUUID();
  return {
    organizationId,
    id: randomUUID(),
    status: 'requested',
    requestedByMembershipId: randomUUID(),
    fallbackMembershipId: fallback,
    // What the importers select it as.
    fallback,
    version: 1,
    appliedCounts: {},
    warningCounts: {},
    ...overrides,
  };
};

/** Where a failed run is allowed to write: its own row, and the facts that say it finished. */
const ALLOWED_ON_FAILURE = new Set([
  'sovereign.organization_imports',
  'platform.domain_events',
  'platform.outbox_events',
  'governance.audit_events',
  'platform.notifications',
]);

describe('the runner', () => {
  const organizationId = randomUUID();
  const context = createServiceContext(organizationId);
  const sections = CORE_PORTABILITY_SECTIONS;

  const run = (
    fake: ReturnType<typeof fakeDatabase>,
    row: { id: string },
    bytes: Buffer,
    deps = memoryStore().deps,
    pem = recipient.privateKeyPem,
  ) =>
    runOrganizationImport(
      fake.database,
      context,
      { importId: row.id, archive: archiveReader(bytes), recipientPrivateKeyPem: pem },
      { sections, ...deps },
    );

  it.each([
    [
      'path traversal',
      () =>
        buildArchive(recipient, clientsOnly([goodClient()]), ({ files }) => ({
          files: [...files, { path: '../x', bytes: Buffer.from('x') }],
        })).bytes,
      'PATH_REFUSED',
    ],
    [
      'an absent part',
      () => buildArchive(recipient, clientsOnly([goodClient()]), () => ({ files: [] })).bytes,
      'PART_MISSING',
    ],
    [
      'a bad record at the very end of an otherwise good archive',
      () => {
        const { spec } = sourceTenant();
        return buildArchive(recipient, {
          ...spec,
          pages: [...spec.pages, ...clientsOnly([{ ...goodClient(), extra: 1 }]).pages],
        }).bytes;
      },
      'RECORD_REFUSED',
    ],
    [
      'a future version',
      () =>
        buildArchive(recipient, clientsOnly([]), ({ manifest }) => ({
          manifest: { ...manifest, schema_version: 99 },
        })).bytes,
      'FORMAT_NOT_SUPPORTED',
    ],
  ])('fails on %s with nothing written', async (_name, make, code) => {
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const result = await run(fake, row, make());
    expect(result).toMatchObject({ status: 'failed', failureCode: code });
    expect(row.status).toBe('failed');
    for (const { table } of [...fake.writes, ...fake.updates]) {
      expect(ALLOWED_ON_FAILURE).toContain(table);
    }
  });

  it('refuses to begin unless the import is requested or failed', async () => {
    for (const status of ['running', 'completed', 'completed_with_warnings']) {
      const row = importRow(organizationId, { status });
      const fake = fakeDatabase(row);
      await expect(
        run(fake, row, buildArchive(recipient, clientsOnly([])).bytes),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(fake.writes).toEqual([]);
      expect(fake.updates).toEqual([]);
    }
  });

  it('names the key an archive is for, and the key that opened nothing goes nowhere', async () => {
    const other = testRecipient();
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const result = await run(
      fake,
      row,
      buildArchive(recipient, clientsOnly([])).bytes,
      memoryStore().deps,
      other.privateKeyPem,
    );
    expect(result).toMatchObject({
      status: 'failed',
      failureCode: 'WRONG_KEY',
      archiveKeyId: recipient.keyId,
    });
    const everything = JSON.stringify([fake.writes, fake.updates, result, row]);
    expect(everything).not.toContain('PRIVATE KEY');
    expect(everything).not.toContain(other.privateKeyPem.split('\n')[1]);
  });

  it('never reads a key out of an error, whatever was in the file', async () => {
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const secret = 'THIS-IS-A-GENERATED-TEST-VALUE-NOT-A-KEY';
    const result = await run(
      fake,
      row,
      buildArchive(recipient, clientsOnly([])).bytes,
      memoryStore().deps,
      secret,
    );
    expect(result.failureCode).toBe('WRONG_KEY');
    expect(JSON.stringify([fake.writes, fake.updates, result, row])).not.toContain(secret);
  });

  it('starts nothing, and writes what is history only as history', async () => {
    const { spec, ids, kept } = sourceTenant();
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const { objects, deps } = memoryStore();
    const built = buildArchive(recipient, spec);
    const result = await run(fake, row, built.bytes, deps);
    expect(result.status, fake.lastQuery()).toBe('completed_with_warnings');
    expect(result.failureCode).toBeNull();

    const tables = new Set(fake.writes.map(({ table }) => table));
    // Never live again, whatever the archive holds.
    for (const never of [
      'work.approvals',
      'work.approval_decisions',
      'work.work_transitions',
      'integrations.external_actions',
      'integrations.external_action_attempts',
      'integrations.external_action_receipts',
      'identity.users',
      'org.memberships',
      'secrets.sealed_secrets',
    ]) {
      expect(tables).not.toContain(never);
    }

    const work = fake.writes.filter(({ table }) => table === 'work.work_units');
    const statusOf = (id: string) => work.find(({ values }) => values.id === id)?.values.status;
    expect(statusOf(ids.parentWork)).toBe('ready');
    expect(statusOf(ids.childWork)).toBe('completed');
    expect(statusOf(ids.movingWork)).toBe('blocked');
    expect(statusOf(ids.pendingWork)).toBe('blocked');
    for (const { values } of work) {
      expect(values).not.toHaveProperty('runId');
      expect(values).not.toHaveProperty('runRequestedAt');
      expect(values).not.toHaveProperty('runRequestedByMembershipId');
      expect(values).not.toHaveProperty('planReviewerMembershipId');
      expect(values.ownerMembershipId).toBe(row.fallbackMembershipId);
      // Saying the stand-in made it would be false.
      expect(values.createdByMembershipId).toBeNull();
    }
    expect(result.warningCounts.WORK_PAUSED_ON_IMPORT).toBe(2);

    const [connection] = fake.writes.filter(({ table }) => table === 'integrations.connections');
    expect(connection?.values).toMatchObject({ state: 'disabled', credentialSecretId: null });
    expect(connection?.values).not.toHaveProperty('config');
    expect(result.warningCounts.CONNECTION_NEEDS_CREDENTIAL).toBe(1);

    // The only events are ones that keep a deletion deleted, and the import's own end.
    const events = fake.writes
      .filter(({ table }) => table === getTableConfigName(domainEvents))
      .map(({ values }) => values.eventType);
    expect(new Set(events)).toEqual(
      new Set(['tombstone.recorded', 'organization_import.finished']),
    );

    expect(objects.get(objectKey(organizationId, ids.keptFile))).toEqual(kept);
    expect(objects.size).toBe(1);
  });

  it('counts what it applied the same as the manifest says', async () => {
    const { spec } = sourceTenant();
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const built = buildArchive(recipient, spec);
    const result = await run(fake, row, built.bytes);
    const expected: Record<string, number> = {};
    for (const page of spec.pages) {
      const kind = (page.records[0] as { kind: string }).kind;
      expected[kind] = (expected[kind] ?? 0) + page.records.length;
    }
    expect(result.appliedCounts).toEqual(expected);
  });

  it('keeps a tombstoned file out, row and bytes, from the archive', async () => {
    const { spec, ids } = sourceTenant();
    const body = Buffer.from('revoked bytes');
    const deletedRecord = {
      kind: 'artifact',
      id: ids.deletedFile,
      name: 'Revoked.txt',
      sha256: sha256(body),
      mime_type: 'text/plain',
      size_bytes: body.length,
      classification: 'internal',
      created_by_membership_id: null,
      created_at: '2026-01-02T03:04:05.000Z',
    };
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const { objects, deps } = memoryStore();
    const built = buildArchive(recipient, {
      ...spec,
      pages: spec.pages.map((page) =>
        page.recordKind === 'artifacts'
          ? { ...page, records: [...page.records, deletedRecord] }
          : page,
      ),
      files: { ...spec.files, [ids.deletedFile]: body },
    });
    const result = await run(fake, row, built.bytes, deps);
    expect(result.warningCounts.TOMBSTONED_SKIPPED).toBe(1);
    expect(objects.has(objectKey(organizationId, ids.deletedFile))).toBe(false);
    expect(
      fake.writes.filter(
        ({ table, values }) => table === 'work.artifacts' && values.id === ids.deletedFile,
      ),
    ).toEqual([]);
    expect(
      fake.writes.filter(
        ({ table, values }) =>
          table === 'platform.tombstones' && values.targetId === ids.deletedFile,
      ),
    ).toHaveLength(1);
  });

  it('keeps a file out when only the source ledger knows it was deleted', async () => {
    const { spec, ids, kept } = sourceTenant();
    const entry = {
      organizationId: ids.organization,
      targetType: 'artifact',
      targetId: ids.keptFile,
      deletedAt: new Date('2026-02-02T00:00:00.000Z'),
    };
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const { objects, deps } = memoryStore({ [ledgerKeyFor(entry)]: serializeLedgerEntry(entry) });
    const result = await run(fake, row, buildArchive(recipient, spec).bytes, deps);
    expect(result.warningCounts.TOMBSTONED_SKIPPED).toBe(1);
    expect(objects.size).toBe(0);
    expect([...objects.values()]).not.toContainEqual(kept);
    const events = fake.writes.filter(
      ({ table, values }) =>
        table === getTableConfigName(domainEvents) &&
        values.eventType === 'tombstone.recorded' &&
        values.aggregateId === ids.keptFile,
    );
    expect(events).toHaveLength(1);
  });

  it('fails rather than guessing when the ledger cannot be read', async () => {
    const { spec } = sourceTenant();
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const { deps } = memoryStore();
    const result = await run(fake, row, buildArchive(recipient, spec).bytes, {
      ...deps,
      ledger: {
        listPages: () => ({
          [Symbol.asyncIterator]: () => {
            throw new Error('store down');
          },
        }),
        get: deps.ledger.get,
      },
    });
    expect(result).toMatchObject({ status: 'failed', failureCode: 'STORE_UNAVAILABLE' });
    expect(fake.writes.map(({ table }) => table)).not.toContain('work.work_units');
  });

  it('fails with a code when the store will not take bytes, and writes no row for them', async () => {
    const { spec } = sourceTenant();
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const { deps } = memoryStore();
    const result = await run(fake, row, buildArchive(recipient, spec).bytes, {
      ...deps,
      store: {
        ...deps.store,
        put: async () => {
          throw new Error('store down');
        },
      },
    });
    expect(result).toMatchObject({ status: 'failed', failureCode: 'STORE_UNAVAILABLE' });
    expect(fake.writes.map(({ table }) => table)).not.toContain('work.artifacts');
  });

  it('refuses a legacy archive claiming an unimplemented extension, with nothing applied', async () => {
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const built = buildArchive(recipient, {
      pages: [
        {
          section: 'knowledge',
          recordKind: 'knowledge_sources',
          records: [{ kind: 'knowledge_source', id: randomUUID() }],
        },
      ],
    });
    const result = await run(fake, row, built.bytes);
    expect(result).toMatchObject({
      status: 'failed',
      failureCode: 'MANIFEST_INVALID',
      appliedCounts: {},
    });
  });

  it('counts what was excluded at the source, so nothing is missing silently', async () => {
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const built = buildArchive(recipient, {
      ...clientsOnly([]),
      excluded: { restricted_work: 2, restricted_artifacts: 1, restricted_clients: 0 },
    });
    const result = await run(fake, row, built.bytes);
    expect(result.warningCounts.RESTRICTED_EXCLUDED_AT_SOURCE).toBe(3);
  });

  it('after a failure, runs again only with the same archive', async () => {
    const { spec } = sourceTenant();
    const row = importRow(organizationId);
    const fake = fakeDatabase(row);
    const first = buildArchive(recipient, spec);
    const { deps } = memoryStore();
    let puts = 0;
    const failing = await run(fake, row, first.bytes, {
      ...deps,
      store: {
        ...deps.store,
        put: async () => {
          puts += 1;
          throw new Error('store down');
        },
      },
    });
    expect(failing.failureCode).toBe('STORE_UNAVAILABLE');
    expect(puts).toBe(1);
    const appliedBefore = fake.writes.filter(({ table }) => table === 'work.work_units').length;
    expect(appliedBefore).toBeGreaterThan(0);

    const another = await run(
      fake,
      row,
      buildArchive(recipient, { ...spec, exportId: randomUUID() }).bytes,
    );
    expect(another).toMatchObject({ status: 'failed', failureCode: 'TARGET_NOT_EMPTY' });

    // The same archive carries on where it stopped: nothing applied before is applied again.
    const resumed = await run(fake, row, first.bytes);
    expect(resumed.status).toBe('completed_with_warnings');
    expect(fake.writes.filter(({ table }) => table === 'work.work_units')).toHaveLength(
      appliedBefore,
    );
  });
});

function getTableConfigName(table: PgTable) {
  const { schema, name } = getTableConfig(table);
  return `${schema}.${name}`;
}
