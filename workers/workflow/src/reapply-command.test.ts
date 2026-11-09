// What needs no database. tests/integration/reapply-command.test.ts runs the command against real
// roles, and tests/stack/restore.test.ts runs it from the image.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReapplyResult } from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { ledgerRef } from '@ensemus/domain/tombstone-ledger';
import { afterAll, describe, expect, it } from 'vitest';
import {
  exitCodeFor,
  reapplyCommand,
  readConfirmFile,
  readRequalifications,
  requalificationLeftToDo,
  runRequalifications,
} from './reapply-command';

const folder = mkdtempSync(join(tmpdir(), 'reapply-command-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const fileWith = (text: string) => {
  const path = join(folder, `${randomUUID()}.txt`);
  writeFileSync(path, text);
  return path;
};

const entry = () =>
  ledgerRef({ organizationId: randomUUID(), targetType: 'artifact', targetId: randomUUID() });

const clean: ReapplyResult = {
  entries: 3,
  tombstonesAdded: 1,
  artifactsRemoved: 1,
  bytesRemoved: 1,
  organizationsMissing: 1,
  invalid: 0,
  unconfirmed: 0,
  failed: 0,
};

describe('the exit status of the re-apply', () => {
  it('is zero when nothing is left to do', () => {
    expect(exitCodeFor(clean)).toBe(0);
  });

  it.each(['failed', 'invalid', 'unconfirmed'] as const)('is not zero for %s', (count) => {
    expect(exitCodeFor({ ...clean, [count]: 1 })).toBe(1);
  });
});

describe('a list of entries to confirm', () => {
  it('reads one exact entry to a line', () => {
    const [first, second] = [entry(), entry()];
    expect(readConfirmFile(fileWith(`${first}\n${second}\n`))).toEqual([first, second]);
    expect(readConfirmFile(fileWith(`${first}\r\n${second}`))).toEqual([first, second]);
  });

  const organization = randomUUID();
  const file = randomUUID();
  it.each([
    ['a wildcard for the file', `${organization}:artifact:*`],
    ['a wildcard for the tenant', `*:artifact:${file}`],
    ['all of a tenant', organization],
    ['a tenant and a type', `${organization}:artifact`],
    ['a tenant and a type, ending in a colon', `${organization}:artifact:`],
    ['the word all', 'all'],
    ['an object key', `tombstone-ledger/v1/${organization}/artifact/${file}.json`],
    ['an unknown type', `${organization}:user:${file}`],
    ['capitals', `${organization}:artifact:${file}`.toUpperCase()],
    ['an entry with something after it', `${organization}:artifact:${file}:more`],
    ['a space before it', ` ${organization}:artifact:${file}`],
    ['a space after it', `${organization}:artifact:${file} `],
    ['a comment', `# ${organization}:artifact:${file}`],
    ['a blank line in the middle', ''],
  ])('refuses the whole file for %s', (_name, line) => {
    const path = fileWith(`${entry()}\n${line}\n${entry()}\n`);
    expect(() => readConfirmFile(path)).toThrow('NOT_A_LEDGER_ENTRY');
  });

  it('refuses a file that names nothing', () => {
    expect(() => readConfirmFile(fileWith(''))).toThrow('CONFIRM_FILE_EMPTY');
    expect(() => readConfirmFile(fileWith('\n\n'))).toThrow('NOT_A_LEDGER_ENTRY');
  });

  it('refuses a file it cannot read, as a directory left by a mistyped mount would be', () => {
    expect(() => readConfirmFile(join(folder, 'not-there'))).toThrow('CONFIRM_FILE_UNREADABLE');
    expect(() => readConfirmFile(folder)).toThrow('CONFIRM_FILE_UNREADABLE');
  });
});

describe('refusing to start', () => {
  /** Anything that touches either of these has started, which is what must not happen. */
  const untouchable = new Proxy(
    {},
    {
      get() {
        throw new Error('Touched something');
      },
    },
  );
  const refusedBy = (...args: string[]) =>
    reapplyCommand(args, {
      database: untouchable as AppDatabase,
      store: untouchable as Parameters<typeof reapplyCommand>[1]['store'],
    });

  it.each([
    ['a mistyped entry', ['--confirm', 'nope']],
    ['a mistyped entry to quarantine', ['--quarantine', 'nope']],
    ['a mistyped option', ['--confirm-files', 'list.txt']],
    ['a file with nothing after it', ['--confirm-file']],
    ['a word that is no option', ['all']],
    ['a file that is not there', ['--confirm-file', join(folder, 'not-there')]],
    ['a re-proof of every tenant', ['--requalify-organization', 'all']],
    ['a re-proof naming a pattern', ['--requalify-artifact', `${randomUUID()}/*`]],
    ['a re-proof missing its object', ['--requalify-source', randomUUID()]],
    [
      'a re-proof with an ID too many',
      ['--requalify-artifact', `${randomUUID()}/${randomUUID()}/${randomUUID()}`],
    ],
    [
      'a re-proof in capitals',
      ['--requalify-archive', `${randomUUID()}/${randomUUID()}/${randomUUID()}`.toUpperCase()],
    ],
  ])('for %s, before anything is done', async (_name, args) => {
    await expect(refusedBy(...args)).resolves.toBe(2);
  });

  it('for a bad list, even with good entries and other work beside it', async () => {
    await expect(
      refusedBy('--confirm', entry(), '--confirm-file', fileWith('*\n'), '--quarantine', entry()),
    ).resolves.toBe(2);
  });
});

describe('re-proving restore debt (0543, 0545)', () => {
  const org = randomUUID(),
    id = randomUUID(),
    other = randomUUID();
  const none = {
    'requalify-artifact': [],
    'requalify-archive': [],
    'requalify-source': [],
    'requalify-organization': [],
  };

  it('reads each option as exactly one object, the organization first', () => {
    expect(
      readRequalifications({
        ...none,
        'requalify-artifact': [`${org}/${id}`],
        'requalify-archive': [`${org}/${id}/${other}`],
        'requalify-source': [`${org}/${other}`],
        'requalify-organization': [org],
      }),
    ).toEqual([
      { kind: 'organization', organizationId: org },
      { kind: 'artifact', organizationId: org, artifactId: id },
      { kind: 'archive', organizationId: org, importId: id, sourceArtifactId: other },
      { kind: 'source', organizationId: org, sourceId: other },
    ]);
    expect(readRequalifications(none)).toEqual([]);
  });

  it('asks the service of the named tenant, and reports what was not recorded', async () => {
    const asked: string[] = [];
    const answer =
      (value: unknown) =>
      async (_db: unknown, ...rest: unknown[]) => {
        const context = (rest.length === 1 ? rest[0] : rest[1]) as {
          organizationId: string;
          actorType: string;
        };
        asked.push(`${context.actorType}:${context.organizationId}`);
        if (value instanceof Error) throw value;
        return value;
      };
    const outcomes = await runRequalifications(
      {} as AppDatabase,
      {},
      readRequalifications({
        ...none,
        'requalify-artifact': [`${org}/${id}`],
        'requalify-source': [`${org}/${other}`],
        'requalify-organization': [org],
      }),
      {
        requalify: {
          organization: answer({ state: 'requalified' }),
          artifact: answer(Object.assign(new Error('refused'), { code: 'EN850' })),
          archive: answer({ state: 'unconfirmed' }),
          source: answer({ state: 'present', documentIds: [id] }),
        } as never,
      },
    );
    expect(asked).toEqual([`service:${org}`, `service:${org}`, `service:${org}`]);
    expect(outcomes.map((outcome) => outcome.state)).toEqual(['requalified', 'refused', 'present']);
    expect(outcomes[1]).toMatchObject({ errorCode: 'EN850' });
    expect(outcomes[2]).toMatchObject({ documentIds: [id] });
    expect(outcomes.map(requalificationLeftToDo)).toEqual([false, true, true]);
  });
});

describe('the operator command', () => {
  it('exits with what the command answers, and nothing of its own', () => {
    const source = readFileSync(new URL('./reapply-ledger.ts', import.meta.url), 'utf8');
    expect(source).toContain('reapplyCommand(process.argv.slice(2)');
    expect(source).toContain('process.exit(code)');
  });

  it('gives the re-apply the production generated-file lifecycle', () => {
    const source = readFileSync(new URL('./reapply-ledger.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      'derivedArtifacts: createObjectDeletionLifecycle({ database: db, store }).derived',
    );
  });
});
