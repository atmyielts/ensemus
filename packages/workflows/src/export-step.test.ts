// What an organization export decides at each step (COMM-05, ADR-030 D7), and what it refuses to write, without
// Temporal or a database. tests/integration/organization-export.test.ts does the rest on real roles.
import { encodeExportPage, tarEntryBytes, type ExportStep } from '@ensemus/application';
import { MAX_PART_PLAINTEXT_BYTES, MAX_RECORD_BYTES } from '@ensemus/domain/portability';
import { describe, expect, it } from 'vitest';
import { exportFailureFor, exportResult, nextExportMove } from './export-step';

const goingOn: ExportStep = { state: 'continue', parts: 2, records: 7 };
const finished: ExportStep = { state: 'finished', parts: 3, records: 9 };
const failed: ExportStep = { state: 'failed', code: 'RECORD_REFUSED' };

describe('nextExportMove', () => {
  it('keeps taking batches while there are any', () => {
    expect(nextExportMove('batch', goingOn, false)).toEqual({ kind: 'batch' });
  });

  it('goes on to finishing when the batches are done, and never reports ready from a batch', () => {
    expect(nextExportMove('batch', finished, false)).toEqual({ kind: 'finish' });
  });

  it('keeps finishing while a large tenant has more tombstones to read', () => {
    expect(nextExportMove('finish', goingOn, false)).toEqual({ kind: 'finish' });
  });

  it('reports ready only when finishing says so, with its count', () => {
    expect(nextExportMove('finish', finished, false)).toEqual({ kind: 'ready', parts: 3 });
  });

  it.each(['batch', 'finish'] as const)('stops on a failure during %s, with its code', (phase) => {
    expect(nextExportMove(phase, failed, false)).toEqual({ kind: 'fail', code: 'RECORD_REFUSED' });
    // Long history is no reason to carry on past a failure.
    expect(nextExportMove(phase, failed, true)).toEqual({ kind: 'fail', code: 'RECORD_REFUSED' });
  });

  it.each(['batch', 'finish'] as const)('starts over when history is long, during %s', (phase) => {
    expect(nextExportMove(phase, goingOn, true)).toEqual({ kind: 'continue_as_new' });
  });

  it('does not start over when the next move ends it anyway', () => {
    expect(nextExportMove('finish', finished, true)).toEqual({ kind: 'ready', parts: 3 });
    expect(nextExportMove('batch', finished, true)).toEqual({ kind: 'finish' });
  });
});

describe('exportFailureFor', () => {
  it('says the store stayed down only when that is what failed', () => {
    expect(exportFailureFor('STORE_UNAVAILABLE')).toBe('STORE_UNAVAILABLE');
  });

  it.each(['AppError', 'TenantAccessDenied', 'Error', '', null, undefined])(
    'calls anything else a section failure: %s',
    (type) => {
      expect(exportFailureFor(type)).toBe('SECTION_FAILED');
    },
  );
});

describe('exportResult', () => {
  it('carries only an ID, an outcome and a counter', () => {
    expect(Object.keys(exportResult('id', 'ready', 1)).sort()).toEqual([
      'exportId',
      'outcome',
      'parts',
    ]);
  });
});

const client = (overrides: Record<string, unknown> = {}) => ({
  kind: 'client',
  id: '6f1c2c6e-1111-4111-8111-111111111111',
  display_name: 'Test Client',
  classification: 'internal',
  created_at: '2027-01-01T00:00:00.000Z',
  ...overrides,
});

describe('encodeExportPage', () => {
  it('writes one line of JSON for each record', () => {
    const page = encodeExportPage('clients', [client(), client({ display_name: 'Other' })]);
    if (!page.ok) throw new Error('Should have encoded');
    expect(page.count).toBe(2);
    const lines = page.body.toString('utf8').trimEnd().split('\n');
    expect(
      lines.map((line) => (JSON.parse(line) as { display_name: string }).display_name),
    ).toEqual(['Test Client', 'Other']);
  });

  it('writes nothing for an empty page', () => {
    const page = encodeExportPage('clients', []);
    if (!page.ok) throw new Error('Should have encoded');
    expect(page.count).toBe(0);
    expect(page.body.length).toBe(0);
  });

  it('refuses a restricted record, so a slip fails the export instead of copying it', () => {
    expect(encodeExportPage('clients', [client({ classification: 'restricted' })])).toEqual({
      ok: false,
      why: 'refused',
    });
  });

  it('refuses a field the schema has no place for, such as a credential', () => {
    expect(
      encodeExportPage('connections', [
        {
          kind: 'connection',
          id: '6f1c2c6e-1111-4111-8111-111111111111',
          connector_type: 'email_smtp',
          display_name: 'Test mail',
          granted_scopes: [],
          created_at: '2027-01-01T00:00:00.000Z',
          config: { api_key: 'generated-test-value' },
        },
      ]),
    ).toEqual({ ok: false, why: 'refused' });
  });

  it('refuses a record naming a tenant', () => {
    expect(encodeExportPage('clients', [client({ organization_id: client().id })])).toEqual({
      ok: false,
      why: 'refused',
    });
  });

  it('never repeats a record in what it answers', () => {
    const answer = JSON.stringify(
      encodeExportPage('clients', [
        client({ display_name: 'CANARY', classification: 'restricted' }),
      ]),
    );
    expect(answer).not.toContain('CANARY');
  });

  it('refuses one record over the limit, which no smaller page could fit', () => {
    const big = { kind: 'anything', text: 'x'.repeat(MAX_RECORD_BYTES) };
    expect(encodeExportPage('knowledge', [big])).toEqual({ ok: false, why: 'refused' });
  });

  it('says a page is too big when each record fits, so the caller can read fewer', () => {
    const record = { kind: 'anything', text: 'x'.repeat(MAX_RECORD_BYTES - 100) };
    const count = Math.ceil(MAX_PART_PLAINTEXT_BYTES / MAX_RECORD_BYTES) + 1;
    expect(
      encodeExportPage(
        'knowledge',
        Array.from({ length: count }, () => record),
      ),
    ).toEqual({
      ok: false,
      why: 'too_big',
    });
  });

  it('holds a later section to the rules no section may break', () => {
    const refused = { ok: false, why: 'refused' };
    expect(encodeExportPage('knowledge', [{ classification: 'restricted' }])).toEqual(refused);
    expect(encodeExportPage('knowledge', [{ organization_id: 'x' }])).toEqual(refused);
    expect(encodeExportPage('knowledge', ['not an object'])).toEqual(refused);
    expect(encodeExportPage('knowledge', [{ kind: 'source', id: 'x' }]).ok).toBe(true);
  });
});

describe('tarEntryBytes', () => {
  // A 512 byte header, then the file, then zeros up to a whole block.
  it.each([
    [0, 512],
    [1, 1024],
    [511, 1024],
    [512, 1024],
    [513, 1536],
    [4096, 4608],
  ])('counts a %d byte file as %d', (size, total) => {
    expect(tarEntryBytes(size)).toBe(total);
  });
});
