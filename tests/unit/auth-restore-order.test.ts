// Exact command boundary tests only. No Docker, restore, provider or native-role acceptance claim.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { compose } = vi.hoisted(() => ({ compose: vi.fn() }));
vi.mock('../../infrastructure/scripts/sovereign-backup.mjs', () => ({
  compose,
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
  authRestoreResult,
  fenceRestoredAuthentication,
  restoreServicesToStop,
} from '../../infrastructure/scripts/sovereign-restore.mjs';
const generation = randomUUID(),
  backup_id = randomUUID(),
  manifest_sealed_sha256 = 'a'.repeat(64);
const invalidated = (generation: string) =>
  JSON.stringify({
    event: 'auth_restore.invalidated',
    generation,
    version: 1,
    already_invalidated: false,
    completedAt: '2026-11-08T00:01:00Z',
    emptyBackupCipherSha256: 'b'.repeat(64),
    sessionsRemoved: 1,
    assurancesRemoved: 1,
    verificationsRemoved: 1,
    setupTokensRevoked: 0,
    backupCodeSetsRevoked: 1,
  });
beforeEach(() => compose.mockReset());
describe('restore command admission ordering', () => {
  it('stops overlay replicas, knowledge/agent workers and outbound gateways while retaining only the restore stores', () => {
    const stop = restoreServicesToStop([
      'postgres',
      'objects',
      'web',
      'web-2',
      'proxy',
      'agent-worker',
      'knowledge-worker',
      'worker',
      'dispatcher',
      'connector-worker',
      'egress-gateway',
      'temporal',
    ]);
    expect(stop).toEqual(
      expect.arrayContaining([
        'web',
        'web-2',
        'agent-worker',
        'knowledge-worker',
        'connector-worker',
        'egress-gateway',
      ]),
    );
    expect(stop).not.toContain('postgres');
    expect(stop).not.toContain('objects');
    expect(stop[0]).toBe('proxy');
  });
  it.each([[], ['postgres'], ['objects']])(
    'refuses incomplete actual service inventory %#',
    (services) => expect(() => restoreServicesToStop(services)).toThrow(),
  );
  it('refuses an unknown explicit service or request to stop a restore store', () => {
    expect(() =>
      restoreServicesToStop(['postgres', 'objects', 'web'], ['missing-overlay']),
    ).toThrow();
    expect(() => restoreServicesToStop(['postgres', 'objects', 'web'], ['postgres'])).toThrow();
  });
  it('migrates, commits the auth/material begin, then calls the dedicated native cleanup job with that exact generation', () => {
    compose
      .mockReturnValueOnce(JSON.stringify({ event: 'auth_restore.schema_ready' }))
      .mockReturnValueOnce(JSON.stringify({ event: 'auth_restore.pending', generation }))
      .mockReturnValueOnce(invalidated(generation));
    expect(fenceRestoredAuthentication({}, { backup_id }, { manifest_sealed_sha256 })).toBe(
      generation,
    );
    expect(compose.mock.calls.map((call) => call.slice(1))).toEqual([
      ['run', '--rm', '--no-deps', 'migrate', 'node', 'dist/auth-restore.js', 'migrate'],
      [
        'run',
        '--rm',
        '--no-deps',
        'migrate',
        'node',
        'dist/auth-restore.js',
        'begin',
        '--backup',
        backup_id,
        '--manifest',
        manifest_sealed_sha256,
      ],
      [
        '--profile',
        'ops',
        'run',
        '--rm',
        '--no-deps',
        'auth-restore',
        'node',
        'dist/auth-restore.js',
        'invalidate',
        '--generation',
        generation,
      ],
    ]);
  });
  it('does not attempt native cleanup after a missing or failed material/auth generation hook', () => {
    compose
      .mockReturnValueOnce(JSON.stringify({ event: 'auth_restore.schema_ready' }))
      .mockImplementationOnce(() => {
        throw new Error('missing required helper');
      });
    expect(() =>
      fenceRestoredAuthentication({}, { backup_id }, { manifest_sealed_sha256 }),
    ).toThrow();
    expect(compose).toHaveBeenCalledTimes(2);
  });
  it.each([
    '',
    JSON.stringify({ event: 'other', generation }),
    JSON.stringify({ event: 'auth_restore.pending', generation: 'unknown' }),
    [
      JSON.stringify({ event: 'auth_restore.pending', generation }),
      JSON.stringify({ event: 'auth_restore.pending', generation }),
    ].join('\n'),
  ])('refuses absent, wrong or ambiguous command output %#', (output) =>
    expect(() => authRestoreResult(output, 'auth_restore.pending')).toThrow(),
  );
  it('never accepts cleanup of a different generation', () => {
    compose
      .mockReturnValueOnce(JSON.stringify({ event: 'auth_restore.schema_ready' }))
      .mockReturnValueOnce(JSON.stringify({ event: 'auth_restore.pending', generation }))
      .mockReturnValueOnce(invalidated(randomUUID()));
    expect(() =>
      fenceRestoredAuthentication({}, { backup_id }, { manifest_sealed_sha256 }),
    ).toThrow('AUTH_RESTORE_GENERATION_CHANGED');
  });
  it('refuses an incomplete cleanup report rather than allowing the next material step', () => {
    expect(() =>
      authRestoreResult(
        JSON.stringify({ event: 'auth_restore.invalidated', generation }),
        'auth_restore.invalidated',
      ),
    ).toThrow();
    const unknown = { ...JSON.parse(invalidated(generation)), unreviewedAuthority: 'unknown' };
    expect(() => authRestoreResult(JSON.stringify(unknown), 'auth_restore.invalidated')).toThrow();
  });
});
