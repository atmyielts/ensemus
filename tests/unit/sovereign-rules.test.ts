// ADR-030: lists that exist in code, in reviewed SQL and in the API contract. These keep every copy the same.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exportStatusSchema,
  importStatusSchema,
  licenseStandingSchema,
  supportStatusSchema,
} from '@ensemus/contracts/sovereign';
import { ADVISORY_SEVERITIES, LICENSE_NOTICES } from '@ensemus/domain/license';
import {
  CORE_EXPORT_SECTIONS,
  EXPORT_STATUSES,
  EXPORT_TRANSITIONS,
  IMPORT_STATUSES,
  IMPORT_TRANSITIONS,
  IMPORTED_RECORD_TYPES,
} from '@ensemus/domain/portability';
import { spec } from '../helpers/openapi';
import { repoRoot } from '../helpers/stack';

const read = (name: string) =>
  readFileSync(join(repoRoot, 'packages/database/migrations', name), 'utf8');
const security = read('0301_sovereign_security.sql');
const tables = read('0300_sovereign.sql');

/** The `WHEN from THEN NEW.status IN (...)` table of one trigger function. */
function transitionsIn(functionName: string) {
  const start = security.indexOf(`CREATE FUNCTION sovereign.${functionName}`);
  const end = security.indexOf('END $$', start);
  const body = security.slice(start, end);
  const found: Record<string, string[]> = {};
  for (const [, from, to] of body.matchAll(/WHEN '([a-z_]+)' THEN NEW\.status IN \(([^)]+)\)/g)) {
    found[from as string] = (to as string).split(',').map((s) => s.trim().replaceAll("'", ''));
  }
  for (const [, from, to] of body.matchAll(/WHEN '([a-z_]+)' THEN NEW\.status = '([a-z_]+)'/g)) {
    found[from as string] = [to as string];
  }
  return found;
}

const withoutEmpty = (table: Record<string, readonly string[]>) =>
  Object.fromEntries(Object.entries(table).filter(([, to]) => to.length > 0));

const schema = (name: string) =>
  spec.components.schemas[name] as unknown as { properties: Record<string, { enum?: string[] }> };

describe('the same list everywhere', () => {
  it('has one export state machine, in the domain and in the trigger', () => {
    expect(transitionsIn('check_export_change')).toEqual(withoutEmpty(EXPORT_TRANSITIONS));
  });

  it('has one import state machine, in the domain and in the trigger', () => {
    expect(transitionsIn('check_import_change')).toEqual(withoutEmpty(IMPORT_TRANSITIONS));
  });

  it('has one list of statuses in the domain, the contract, the table and the spec', () => {
    expect(exportStatusSchema.options).toEqual([...EXPORT_STATUSES]);
    expect(importStatusSchema.options).toEqual([...IMPORT_STATUSES]);
    expect(schema('OrganizationExport').properties.status?.enum).toEqual([...EXPORT_STATUSES]);
    expect(schema('OrganizationImport').properties.status?.enum).toEqual([...IMPORT_STATUSES]);
    for (const status of [...EXPORT_STATUSES, ...IMPORT_STATUSES]) {
      expect(tables).toContain(`'${status}'`);
    }
  });

  it('has one list of notices and standings in the domain, the contract and the spec', () => {
    const status = schema('LicenseStatus') as unknown as {
      properties: {
        notices: { items: { enum: string[] } };
        standing: { enum: string[] };
        maintenance: { properties: { status: { enum: string[] } } };
      };
    };
    expect(status.properties.notices.items.enum).toEqual([...LICENSE_NOTICES]);
    expect(status.properties.standing.enum).toEqual(licenseStandingSchema.options);
    expect(status.properties.maintenance.properties.status.enum).toEqual(
      supportStatusSchema.options,
    );
    expect(schema('Advisory').properties.severity?.enum).toEqual([...ADVISORY_SEVERITIES]);
  });

  it('has one list of what is kept as history, in the domain and the table', () => {
    const check = /imported_records_type_check" CHECK \([^(]*\(([^)]+)\)/.exec(tables)?.[1] ?? '';
    expect(check.split(',').map((s) => s.trim().replaceAll("'", ''))).toEqual([
      ...IMPORTED_RECORD_TYPES,
    ]);
  });

  it('keeps tombstones in the core sections, since an import reads them first', () => {
    expect(CORE_EXPORT_SECTIONS).toContain('tombstones');
  });
});

describe('the reviewed SQL', () => {
  it('forces RLS over the whole schema, and creates no role', () => {
    expect(security).toContain('FORCE ROW LEVEL SECURITY');
    expect(security).toContain(`WHERE schemaname = 'sovereign'`);
    expect(security).not.toMatch(/CREATE ROLE|BYPASSRLS/i);
    expect(security.startsWith('-- REVIEWED SECURITY SQL')).toBe(true);
  });

  it('grants the schema to the application role and nobody else', () => {
    const grants = [...security.matchAll(/GRANT [^;]+? TO ([a-z_]+);/gs)].map((m) => m[1]);
    expect(new Set(grants)).toEqual(new Set(['ensemus_app']));
  });

  it('lets nothing change who an export is sealed for, or who asked', () => {
    const update = /GRANT UPDATE \(([^)]+)\)\s+ON sovereign\.organization_exports/.exec(security);
    expect(update?.[1]).toBeDefined();
    for (const fixed of [
      'recipient_public_key',
      'recipient_key_id',
      'requested_by_membership_id',
    ]) {
      expect(update?.[1]).not.toContain(fixed);
    }
  });
});
