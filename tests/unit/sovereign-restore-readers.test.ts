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
