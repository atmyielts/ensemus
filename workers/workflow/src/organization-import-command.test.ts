// What needs no database. tests/integration/organization-import.test.ts runs an import against real roles.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, type ImportRunResult } from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { afterAll, describe, expect, it } from 'vitest';
import { exitCodeFor, organizationImportCommand, type ImportCommandDeps } from './organization-import-command';

const folder = mkdtempSync(join(tmpdir(), 'organization-import-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const fileWith = (text: string | Buffer) => {
  const path = join(folder, randomUUID());
  writeFileSync(path, text);
  return path;
};

/** Anything that touches this has started, which is what a refusal must not do. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('Touched something');
    },
  },
);

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) },
  };
};

const depsWith = (io: ImportCommandDeps['io'], run?: ImportCommandDeps['run']) => ({
  database: untouchable as AppDatabase,
  store: untouchable as ImportCommandDeps['store'],
  sections: [],
  io,
  ...(run ? { run } : {}),
});

const organization = randomUUID();
const importId = randomUUID();
const goodArguments = (archive: string, key: string) => [
  '--organization',
  organization,
  '--import',
  importId,
  '--archive',
  archive,
  '--key-file',
  key,
];

const finished: ImportRunResult = {
  status: 'completed_with_warnings',
  failureCode: null,
  appliedCounts: { work_unit: 3 },
  warningCounts: { PERSON_NOT_LINKED: 2 },
  archiveKeyId: null,
};

describe('the exit status of an import', () => {
  it.each([
    ['completed', 0],
    ['completed_with_warnings', 0],
    ['failed', 1],
  ] as const)('%s exits %i', (status, code) => {
    expect(exitCodeFor({ status })).toBe(code);
  });
});

describe('refusing to start', () => {
  const missing = () => join(folder, 'not-there');
  it.each([
    ['nothing at all', () => []],
    ['a word that is no option', () => ['all']],
    ['a mistyped option', () => ['--organisation', organization]],
    ['no organization', () => ['--import', importId, '--archive', 'a', '--key-file', 'k']],
    [
      'an organization that is no ID',
      () => ['--organization', 'x', '--import', importId, '--archive', 'a', '--key-file', 'k'],
    ],
    ['no import', () => ['--organization', organization, '--archive', 'a', '--key-file', 'k']],
    ['no archive', () => ['--organization', organization, '--import', importId, '--key-file', 'k']],
    ['no key file', () => ['--organization', organization, '--import', importId, '--archive', 'a']],
    ['a key on the command line', () => [...goodArguments('a', 'k'), '--key', 'PEM']],
    [
      'files with --interrupted',
      () => [...goodArguments('a', 'k'), '--interrupted'],
    ],
    ['a key file that is not there', () => goodArguments(fileWith('archive'), missing())],
    ['a key file that is a folder', () => goodArguments(fileWith('archive'), folder)],
    ['an archive that is not there', () => goodArguments(missing(), fileWith('key'))],
  ])('for %s, before anything is done', async (_name, args) => {
    const { io, out } = capture();
    await expect(organizationImportCommand(args(), depsWith(io))).resolves.toBe(2);
    expect(out).toEqual([]);
  });
});

describe('running', () => {
  it('hands the key and the archive to the import, and prints only counts and IDs', async () => {
    const secret = 'A-GENERATED-TEST-VALUE-THAT-MUST-NOT-BE-PRINTED';
    const archive = fileWith('tar bytes');
    const seen: { key?: string; total?: number; read?: string } = {};
    const { io, out, err } = capture();
    const code = await organizationImportCommand(
      goodArguments(archive, fileWith(secret)),
      depsWith(io, async (_database, context, input) => {
        expect(context.actorType).toBe('service');
        expect(context.organizationId).toBe(organization);
        seen.key = input.recipientPrivateKeyPem;
        seen.total = input.archive.totalBytes;
        seen.read = (await input.archive.readAt(4, 5)).toString();
        return finished;
      }),
    );
    expect(code).toBe(0);
    expect(seen).toEqual({ key: secret, total: 'tar bytes'.length, read: 'bytes' });
    expect(JSON.parse(out[0] as string)).toEqual({
      import_id: importId,
      status: 'completed_with_warnings',
      failure_code: null,
      applied: { work_unit: 3 },
      warnings: { PERSON_NOT_LINKED: 2 },
    });
    expect([...out, ...err].join()).not.toContain(secret);
    expect([...out, ...err].join()).not.toContain(archive);
  });

  it('exits non-zero on a failure, and says which key the archive is for', async () => {
    const { io, err } = capture();
    const keyId = 'a'.repeat(32);
    const code = await organizationImportCommand(
      goodArguments(fileWith('tar'), fileWith('key')),
      depsWith(io, async () => ({
        ...finished,
        status: 'failed',
        failureCode: 'WRONG_KEY',
        archiveKeyId: keyId,
      })),
    );
    expect(code).toBe(1);
    expect(err.join()).toContain(keyId);
  });

  it('says plainly when an archive does not say which key it is for', async () => {
    const { io, err } = capture();
    await organizationImportCommand(
      goodArguments(fileWith('tar'), fileWith('key')),
      depsWith(io, async () => ({
        ...finished,
        status: 'failed',
        failureCode: 'WRONG_KEY',
        archiveKeyId: null,
      })),
    );
    expect(err.join()).toContain('does not say which key');
  });

  it('reports a refusal from the import by its code, with no text from anywhere else', async () => {
    const { io, err } = capture();
    const code = await organizationImportCommand(
      goodArguments(fileWith('tar'), fileWith('key')),
      depsWith(io, async () => {
        throw new AppError('INVALID_STATE');
      }),
    );
    expect(code).toBe(1);
    expect(err.join()).toContain('INVALID_STATE');
  });
});

describe('the operator command', () => {
  it('exits with what the command answers, and nothing of its own', () => {
    const source = readFileSync(new URL('./organization-import.ts', import.meta.url), 'utf8');
    expect(source).toContain('organizationImportCommand(process.argv.slice(2)');
    expect(source).toContain('process.exit(code)');
  });
});
