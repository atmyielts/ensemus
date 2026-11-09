// The restore's reader check before it replaces any database (0422 begin refuses a connected runtime
// role). Parsing only: no Docker, PostgreSQL or restore runs here.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../infrastructure/scripts/sovereign-backup.mjs', () => ({
  compose: vi.fn(),
  composeArguments: () => [],
  repoRoot: '.',
  say: vi.fn(),
  stop: (code: string) => {
    throw new Error(code);
  },
  loadTool: vi.fn(),
  openStore: vi.fn(),
}));
import {
  RESTORE_READER_ROLES,
  RESTORE_READER_SESSIONS_SQL,
  readersStillConnected,
} from '../../infrastructure/scripts/sovereign-restore.mjs';
import { restoreCommandReason } from '../../workers/workflow/src/auth-restore';

describe('the restore refuses while a runtime role is still connected', () => {
  it('asks about exactly the roles 0422 begin_auth_restore refuses, in the database it fences', () => {
    expect([...RESTORE_READER_ROLES].sort()).toEqual(
      [
        'ensemus_agent',
        'ensemus_app',
        'ensemus_auth',
        'ensemus_dispatcher',
        'ensemus_eraser',
        'ensemus_operator',
        'ensemus_secrets',
        'ensemus_support',
      ].sort(),
    );
    expect(RESTORE_READER_SESSIONS_SQL).toContain("datname = 'ensemus'");
    for (const role of RESTORE_READER_ROLES)
      expect(RESTORE_READER_SESSIONS_SQL).toContain(`'${role}'`);
    expect(RESTORE_READER_SESSIONS_SQL).not.toContain('ensemus_migrator');
  });

  it('names each connected role with its session count, and nothing when none is connected', () => {
    expect(readersStillConnected('ensemus_app|3\nensemus_auth|1\n')).toEqual([
      { role: 'ensemus_app', sessions: 3 },
      { role: 'ensemus_auth', sessions: 1 },
    ]);
    expect(readersStillConnected('')).toEqual([]);
    expect(readersStillConnected('\n\n')).toEqual([]);
  });

  it.each([
    'ensemus_migrator|1',
    'postgres|2',
    'ensemus_app|0',
    'ensemus_app|',
    'ensemus_app 3',
    'psql: error: connection refused',
  ])('refuses an answer it cannot read: %s', (output) => {
    expect(() => readersStillConnected(output)).toThrow('RESTORE_READER_CHECK_UNREADABLE');
  });
});

// The real helpers (the module is mocked above for the restore script's own imports).
const backup = await vi.importActual<
  typeof import('../../infrastructure/scripts/sovereign-backup.mjs')
>('../../infrastructure/scripts/sovereign-backup.mjs');

describe('a failed compose step says which step and why, as codes only', () => {
  it('names the compose command, past a --profile before it', () => {
    expect(backup.composeCommand(['run', '--rm', '--no-deps', 'migrate'])).toBe('run');
    expect(backup.composeCommand(['--profile', 'ops', 'run', '--rm', 'auth-restore'])).toBe('run');
    expect(backup.composeCommand(['--profile', '*', 'config', '--services'])).toBe('config');
    expect(backup.composeCommand(['exec', '-T', 'postgres', 'psql'])).toBe('exec');
    expect(backup.composeCommand([])).toBe('compose');
  });

  it("keeps a one-shot's own refusal code, the last thing it wrote", () => {
    expect(
      backup.composeFailureCode(
        ' Container ensemus-ci-stack-migrate-run-1 Creating\n Container ensemus-ci-stack-migrate-run-1 Created\nINTERACTIVE_GUARD_TARGET_INVALID\n',
      ),
    ).toBe('INTERACTIVE_GUARD_TARGET_INVALID');
    expect(backup.composeFailureCode('AUTH_RESTORE_READERS_STILL_CONNECTED')).toBe(
      'AUTH_RESTORE_READERS_STILL_CONNECTED',
    );
  });

  it.each([
    '',
    undefined,
    'service "migrate" refused to start: /home/runner/work/ensemus/.local/secrets/db_migrator_url',
    'Error response from daemon: network not found',
    'AUTH_RESTORE_COMMAND_REFUSED\npsql: error: connection to server at "postgres" failed',
    'postgres://ensemus_migrator:password@postgres/ensemus',
    'lowercase_code',
  ])('repeats nothing that is not a bare code: %#', (stderr) => {
    expect(backup.composeFailureCode(stderr)).toBeUndefined();
  });
});

describe('the auth-restore one-shot names the database guard that refused it', () => {
  const database = (code: string, message: string) =>
    Object.assign(new Error('Failed query: select identity.begin_auth_restore($1,$2)'), {
      cause: Object.assign(new Error(message), { code }),
    });

  it("reports a guard's fixed code from under the query wrapper", () => {
    expect(restoreCommandReason(database('42501', 'INTERACTIVE_GUARD_TARGET_INVALID'))).toBe(
      'INTERACTIVE_GUARD_TARGET_INVALID',
    );
    expect(restoreCommandReason(database('EN422', 'AUTH_RESTORE_READERS_STILL_CONNECTED'))).toBe(
      'AUTH_RESTORE_READERS_STILL_CONNECTED',
    );
    expect(restoreCommandReason(database('55P03', 'could not obtain lock on row'))).toBe(
      'AUTH_RESTORE_BUSY',
    );
  });

  it.each([
    database(
      '23505',
      'duplicate key value violates unique constraint "scim_tokens_tokenHash_unique"',
    ),
    database('42501', 'permission denied for table scim_tokens'),
    new Error('INTERACTIVE_GUARD_TARGET_INVALID'),
    Object.assign(new Error('NOT_A_DATABASE_CODE'), { code: 'ENOENT' }),
    'INTERACTIVE_GUARD_TARGET_INVALID',
  ])(
    'repeats no database message that is not a fixed code, and nothing without a SQLSTATE: %#',
    (error) => {
      expect(restoreCommandReason(error)).toBe('AUTH_RESTORE_COMMAND_REFUSED');
    },
  );
});
