// The stage 2 security review's fixes (ADR-038 D6): a file's class follows the file and not the account
// that read it, a formula that would fetch or link is refused and every formula is shown, a new file's
// folder is named, and migration 0565 holds a member's own consent to the member who started it. No
// database: the pure parts are called and the migration is read as text. Generated values only.
import { suiteOutputClass } from '@ensemus/application/suite-reads';
import { onedriveCreateFileArgsSchema, suiteFormulaRefusal } from '@ensemus/contracts/suite-tools';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  columnName,
  FORMULA_EXAMPLES,
  formulaCells,
  rangeStart,
  suiteActionView,
  type SuiteViewFacts,
  type ViewField,
} from '../../apps/web/src/lib/suite-action-view';
import { repoRoot } from '../helpers/stack';

const CONNECTION = '6f1c2c6e-9999-4999-8999-999999999999';
const facts: SuiteViewFacts = {
  connection: {
    connectorType: 'google_workspace',
    displayName: 'Generated workspace',
    ownerKind: 'organization',
    ownerName: null,
  },
  memberAddresses: new Set(),
};
const warning = (fields: readonly ViewField[], label: string) =>
  fields.find((each) => each.kind === 'warning' && each.label === label) as
    Extract<ViewField, { kind: 'warning' }> | undefined;

describe('a suite read’s class', () => {
  it('is the strongest of the handler’s, the run’s and every synced copy’s, never weaker', () => {
    expect(
      suiteOutputClass({
        handlerClass: 'confidential',
        runClass: 'internal',
        sourceClasses: ['internal', 'restricted'],
      }),
    ).toBe('restricted');
    expect(
      suiteOutputClass({ handlerClass: 'confidential', runClass: 'internal', sourceClasses: [] }),
    ).toBe('confidential');
    expect(
      suiteOutputClass({
        handlerClass: 'internal',
        runClass: 'confidential',
        sourceClasses: ['public'],
      }),
    ).toBe('confidential');
  });
});

describe('a formula that would fetch, link or import', () => {
  const sheet = (values: unknown[][]) => ({
    spreadsheet_id: 'sheet1',
    range: 'A1',
    values,
    value_input: 'raw',
  });

  it('is refused in a sheet or a workbook, however it is spelled', () => {
    for (const cell of [
      '=IMPORTXML("https://example.invalid", "//a")',
      ' =importdata ("https://example.invalid")',
      '+IMPORTHTML("https://example.invalid","table",1)',
      '=IMPORTFEED(A1)',
      '=IMPORTRANGE("x","A1")',
      '=IMAGE("https://example.invalid/p.png")',
      '@HYPERLINK("https://example.invalid", "x")',
      '=WEBSERVICE("https://example.invalid")',
      '=SUM(1)&IMPORTXML(A1,"//a")',
    ]) {
      expect(suiteFormulaRefusal('sheets.write_range', sheet([[cell]])), cell).toBe(
        'FORMULA_REFUSED',
      );
      expect(suiteFormulaRefusal('excel.write_range', { values: [['x', cell]] }), cell).toBe(
        'FORMULA_REFUSED',
      );
    }
  });

  it('lets an ordinary formula, text naming a function, and other tools through', () => {
    expect(suiteFormulaRefusal('sheets.write_range', sheet([['=SUM(A1:A3)', 5, null]]))).toBeNull();
    expect(suiteFormulaRefusal('sheets.write_range', sheet([['Use IMPORTXML( here']]))).toBeNull();
    expect(suiteFormulaRefusal('docs.edit', { values: [['=IMAGE(1)']] })).toBeNull();
  });
});

describe('the approval page’s formula warnings', () => {
  it('names cells by address from the range’s first cell', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
    expect(rangeStart("'My Sheet'!C5:D9")).toEqual({ sheet: "'My Sheet'", column: 2, row: 5 });
    expect(rangeStart('B:D')).toEqual({ sheet: null, column: 1, row: 1 });
    expect(rangeStart('3:4')).toEqual({ sheet: null, column: 0, row: 3 });
  });

  it('counts every formula cell in the whole payload, beyond the table, and shows the first few in full', () => {
    const long = `=SUM(${'A1,'.repeat(300)}A1)`;
    const values = Array.from({ length: 80 }, (_, r) =>
      Array.from({ length: 30 }, (_, c) => (r === 70 && c === 25 ? long : c === 0 ? '-1' : 'x')),
    );
    const found = formulaCells('Sheet1!B2', values);
    expect(found.count).toBe(81);
    expect(found.first).toHaveLength(FORMULA_EXAMPLES);
    expect(found.first[0]).toEqual({ address: 'Sheet1!B2', value: '-1' });
    const view = suiteActionView(
      'sheets.write_range',
      CONNECTION,
      {
        spreadsheet_id: 'sheet1',
        range: 'B2',
        values: [['plain', long]],
        value_input: 'user_entered',
      },
      facts,
    )!;
    const formulas = warning(view.fields, 'Formulas')!;
    expect(formulas.text).toContain('One cell starts');
    expect(formulas.items).toEqual([`C2: ${long}`]);
    expect(warning(view.fields, 'Read as typed')).toBeDefined();
  });

  it('warns for a sheet read as typed with no formula, and not for one stored as written', () => {
    const typed = suiteActionView(
      'sheets.write_range',
      CONNECTION,
      { spreadsheet_id: 's', range: 'A1', values: [['1/2/2026']], value_input: 'user_entered' },
      facts,
    )!;
    expect(warning(typed.fields, 'Read as typed')).toBeDefined();
    expect(warning(typed.fields, 'Formulas')).toBeUndefined();
    const raw = suiteActionView(
      'sheets.write_range',
      CONNECTION,
      { spreadsheet_id: 's', range: 'A1', values: [['=A2']], value_input: 'raw' },
      facts,
    )!;
    expect(warning(raw.fields, 'Read as typed')).toBeUndefined();
    expect(warning(raw.fields, 'Formulas')?.text).toContain('stored as text');
  });

  it('warns for a workbook formula, since Excel reads its values as typed', () => {
    const view = suiteActionView(
      'excel.write_range',
      CONNECTION,
      {
        drive_id: 'b!d',
        item_id: 'i',
        worksheet: 'Sheet1',
        range: 'A1:B1',
        values: [[1, '=A1*2']],
      },
      facts,
    )!;
    expect(warning(view.fields, 'Formulas')?.items).toEqual(['B1: =A1*2']);
  });
});

describe('a new file’s folder on the approval page', () => {
  const file = { name: 'notes.txt', media_type: 'text/plain', text: 'x', parent_id: 'folder1' };

  it('names the folder by its synced name, else by its ID as one not known here', () => {
    const named = suiteActionView('drive.create_file', CONNECTION, file, {
      ...facts,
      parentFolderName: 'Board papers',
    })!;
    expect(named.fields).toContainEqual({
      kind: 'text',
      label: 'Folder',
      text: '“Board papers”, the folder with ID folder1',
    });
    const unknown = suiteActionView('drive.create_file', CONNECTION, file, facts)!;
    expect(unknown.fields).toContainEqual({
      kind: 'text',
      label: 'Folder',
      text: 'The folder with ID folder1, a folder not known here',
    });
    const onedrive = suiteActionView(
      'onedrive.create_file',
      CONNECTION,
      { ...file, drive_id: 'b!d' },
      facts,
    )!;
    expect(onedrive.fields).toContainEqual({ kind: 'text', label: 'Drive', text: 'b!d' });
  });

  it('takes a OneDrive folder’s drive only with the folder itself', () => {
    const base = { connection_id: CONNECTION, name: 'a.txt', media_type: 'text/plain', text: '' };
    expect(onedriveCreateFileArgsSchema.safeParse({ ...base, parent_id: 'f' }).success).toBe(true);
    expect(
      onedriveCreateFileArgsSchema.safeParse({ ...base, parent_id: 'f', drive_id: 'b!d' }).success,
    ).toBe(true);
    expect(onedriveCreateFileArgsSchema.safeParse({ ...base, drive_id: 'b!d' }).success).toBe(
      false,
    );
  });
});

describe('migration 0565', () => {
  const sql = readFileSync(
    join(repoRoot, 'packages/database/migrations/0565_suite_review_fixes.sql'),
    'utf8',
  );
  const earlier = (name: string, start: string, end?: string) => {
    const text = readFileSync(join(repoRoot, 'packages/database/migrations', name), 'utf8');
    const from = text.indexOf(start);
    return text.slice(from, end ? text.indexOf(end, from) : undefined).trim();
  };
  const strip = (text: string, line: string) => text.replace(`${line}\n`, '');

  it('is flagged for a person’s review', () => {
    expect(sql.split(/\r?\n/)[0]).toBe('-- FLAGGED FOR HUMAN SECURITY REVIEW');
  });

  it('is 0563’s consent start exactly, with the owner held to the starter', () => {
    const start = 'CREATE OR REPLACE FUNCTION integrations.check_new_oauth_authorization()';
    const added = '      IF NEW.owner_membership_id IS DISTINCT FROM NEW.started_by_membership_id';
    const ours = earlier('0565_suite_review_fixes.sql', start, '--> statement-breakpoint');
    expect(ours).toContain(added);
    expect(
      strip(ours, added).replace(
        '        OR cardinality(NEW.requested_capabilities)=0',
        '      IF cardinality(NEW.requested_capabilities)=0',
      ),
    ).toBe(earlier('0563_suite_tools.sql', start, '--> statement-breakpoint'));
  });

  it('is 0564’s connection guard exactly, with the exchange’s owner held to its creator', () => {
    const start = 'CREATE OR REPLACE FUNCTION integrations.guard_connection_management()';
    const added =
      '        AND (NEW.owner_membership_id IS NULL OR NEW.owner_membership_id=NEW.created_by_membership_id)';
    const ours = earlier('0565_suite_review_fixes.sql', start, '--> statement-breakpoint');
    expect(ours).toContain(added);
    expect(strip(ours, added)).toBe(earlier('0564_suite_upkeep_and_own_revoke.sql', start));
  });
});
