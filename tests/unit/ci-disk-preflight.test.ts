import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  assertCiDiskCleanupTarget,
  prepareHostedCiDisk,
  UNUSED_CI_ANDROID_DIRECTORY,
} from '../../infrastructure/scripts/ci-disk-preflight.mjs';
import { MINIMUM_BUILD_FREE_BYTES } from '../../infrastructure/scripts/disk-headroom.mjs';

const workspace = '/home/runner/work/ensemus/ensemus';
const directory = (extra = {}) => ({
  dev: 1,
  isDirectory: () => true,
  isSymbolicLink: () => false,
  ...extra,
});
function fixture(free = [MINIMUM_BUILD_FREE_BYTES - 1n, MINIMUM_BUILD_FREE_BYTES]) {
  let at = 0;
  return {
    platform: 'linux',
    env: {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Linux',
      GITHUB_WORKSPACE: workspace,
    },
    repositoryRoot: workspace,
    readOsRelease: vi.fn(() => 'ID=ubuntu\nVERSION_ID="24.04"\n'),
    lstat: vi.fn(() => directory()),
    realpath: vi.fn((path: string) => path),
    statfs: vi.fn(() => ({ bavail: free[Math.min(at++, free.length - 1)]!, bsize: 1n })),
    remove: vi.fn(),
    effectiveUid: vi.fn(() => 0),
    log: vi.fn(),
  };
}

describe('disk preparation only on disposable hosted Ubuntu runners', () => {
  it.each([
    ['win32', 'true', 'github-hosted', 'Windows'],
    ['darwin', 'true', 'github-hosted', 'macOS'],
    ['linux', undefined, 'github-hosted', 'Linux'],
    ['linux', 'false', 'github-hosted', 'Linux'],
    ['linux', 'true', undefined, 'Linux'],
    ['linux', 'true', 'self-hosted', 'Linux'],
    ['linux', 'true', 'github-hosted', 'Windows'],
  ])(
    'refuses context %j/%j/%j/%j before filesystem inspection',
    (platform, actions, runner, os) => {
      const value = fixture();
      expect(() =>
        prepareHostedCiDisk({
          ...value,
          platform,
          env: { ...value.env, GITHUB_ACTIONS: actions, RUNNER_ENVIRONMENT: runner, RUNNER_OS: os },
        }),
      ).toThrow('CI_DISK_GITHUB_HOSTED_LINUX_REQUIRED');
      expect(value.readOsRelease).not.toHaveBeenCalled();
      expect(value.lstat).not.toHaveBeenCalled();
      expect(value.statfs).not.toHaveBeenCalled();
      expect(value.remove).not.toHaveBeenCalled();
    },
  );

  it.each([
    'ID=debian\nVERSION_ID="24.04"',
    'ID=ubuntu\nVERSION_ID="22.04"',
    'ID_LIKE=ubuntu\nVERSION_ID="24.04"',
  ])('refuses another actual operating system', (release) => {
    const value = fixture();
    value.readOsRelease.mockReturnValue(release);
    expect(() => prepareHostedCiDisk(value)).toThrow('CI_DISK_UBUNTU_24_REQUIRED');
    expect(value.remove).not.toHaveBeenCalled();
    expect(value.statfs).not.toHaveBeenCalled();
  });

  it('leaves all tools untouched at exactly16GiB available', () => {
    const value = fixture([MINIMUM_BUILD_FREE_BYTES]);
    expect(prepareHostedCiDisk(value)).toEqual({
      before: MINIMUM_BUILD_FREE_BYTES,
      after: MINIMUM_BUILD_FREE_BYTES,
      removed: false,
    });
    expect(value.remove).not.toHaveBeenCalled();
    expect(value.lstat).toHaveBeenCalledTimes(1);
    expect(value.effectiveUid).not.toHaveBeenCalled();
  });

  it('reclaims only the exact verified Android directory, then checks actual remaining space', () => {
    const value = fixture();
    expect(prepareHostedCiDisk(value)).toEqual({
      before: MINIMUM_BUILD_FREE_BYTES - 1n,
      after: MINIMUM_BUILD_FREE_BYTES,
      removed: true,
    });
    expect(value.remove).toHaveBeenCalledExactlyOnceWith(UNUSED_CI_ANDROID_DIRECTORY, {
      recursive: true,
      force: false,
      maxRetries: 0,
    });
    expect(value.statfs).toHaveBeenCalledTimes(2);
    expect(value.remove.mock.invocationCallOrder[0]).toBeLessThan(
      value.statfs.mock.invocationCallOrder[1]!,
    );
  });

  it('refuses nonprivileged cleanup before choosing a removal target', () => {
    const value = fixture();
    value.effectiveUid.mockReturnValue(1001);
    expect(() => prepareHostedCiDisk(value)).toThrow('CI_DISK_PRIVILEGED_HOSTED_STEP_REQUIRED');
    expect(value.remove).not.toHaveBeenCalled();
  });

  it.each([
    '/',
    '/usr/local/lib',
    '/usr/local/lib/android-extra',
    '/usr/local/lib/android/..',
    'android',
    '/usr/local/lib/android\0',
  ])('refuses unsafe candidate %j', (target) => {
    const value = fixture();
    expect(() => assertCiDiskCleanupTarget(target, workspace, value)).toThrow(
      'CI_DISK_CLEANUP_TARGET_REFUSED',
    );
    expect(value.lstat).not.toHaveBeenCalled();
    expect(value.remove).not.toHaveBeenCalled();
  });

  it.each(['/usr/local/lib/android', '/usr/local/lib/android/repository', '/usr/local/lib', '/'])(
    'refuses workspace overlap %j',
    (protectedPath) => {
      const value = fixture();
      expect(() =>
        assertCiDiskCleanupTarget(UNUSED_CI_ANDROID_DIRECTORY, protectedPath, value),
      ).toThrow('CI_DISK_CLEANUP_TARGET_REFUSED');
      expect(value.remove).not.toHaveBeenCalled();
    },
  );

  it.each(['/', '/usr', '/usr/local', '/usr/local/lib', UNUSED_CI_ANDROID_DIRECTORY])(
    'refuses target or ancestor symlink %j',
    (symlink) => {
      const value = fixture();
      value.lstat.mockImplementation((path: string) =>
        directory({ isSymbolicLink: () => path === symlink }),
      );
      expect(() => prepareHostedCiDisk(value)).toThrow('CI_DISK_CLEANUP_SYMLINK_OR_NON_DIRECTORY');
      expect(value.remove).not.toHaveBeenCalled();
    },
  );

  it('refuses a redirected real path even if a metadata adapter missed a symlink', () => {
    const value = fixture();
    value.realpath.mockImplementation((path: string) =>
      path === UNUSED_CI_ANDROID_DIRECTORY ? '/another-volume/android' : path,
    );
    expect(() => prepareHostedCiDisk(value)).toThrow('CI_DISK_CLEANUP_REALPATH_REFUSED');
    expect(value.remove).not.toHaveBeenCalled();
  });

  it('refuses an SDK on a different filesystem that cannot free workspace space', () => {
    const value = fixture();
    value.lstat.mockImplementation((path: string) =>
      directory({ dev: path === UNUSED_CI_ANDROID_DIRECTORY ? 2 : 1 }),
    );
    expect(() => prepareHostedCiDisk(value)).toThrow('CI_DISK_CLEANUP_DIFFERENT_FILESYSTEM');
    expect(value.remove).not.toHaveBeenCalled();
  });

  it.each(['relative/workspace', '/home/runner/work/ensemus/../ensemus', '/different/checkout'])(
    'refuses a workspace not matching the actual repository %j',
    (path) => {
      const value = fixture();
      expect(() =>
        prepareHostedCiDisk({ ...value, env: { ...value.env, GITHUB_WORKSPACE: path } }),
      ).toThrow('CI_DISK_WORKSPACE_REFUSED');
      expect(value.remove).not.toHaveBeenCalled();
    },
  );

  it('fails if the allowlisted tool is missing; it does not try another directory', () => {
    const value = fixture();
    value.lstat.mockImplementation((path: string) => {
      if (path === UNUSED_CI_ANDROID_DIRECTORY) throw new Error('ENOENT');
      return directory();
    });
    expect(() => prepareHostedCiDisk(value)).toThrow('ENOENT');
    expect(value.remove).not.toHaveBeenCalled();
  });

  it('keeps the16GiB gate after cleanup rather than treating attempted reclamation as success', () => {
    const value = fixture([10n * 1024n ** 3n, 15n * 1024n ** 3n]);
    expect(() => prepareHostedCiDisk(value)).toThrow('CI_DISK_HEADROOM_STILL_LOW');
    expect(value.remove).toHaveBeenCalledOnce();
    expect(value.statfs).toHaveBeenCalledTimes(2);
  });

  it('fails on unavailable statistics or cleanup errors without fallback targets', () => {
    const value = fixture();
    value.statfs.mockImplementationOnce(() => {
      throw new Error('STATFS_FAILED');
    });
    expect(() => prepareHostedCiDisk(value)).toThrow('STATFS_FAILED');
    expect(value.remove).not.toHaveBeenCalled();
    value.remove.mockImplementationOnce(() => {
      throw new Error('REMOVE_FAILED');
    });
    expect(() => prepareHostedCiDisk(value)).toThrow('REMOVE_FAILED');
    expect(value.remove).toHaveBeenCalledExactlyOnceWith(UNUSED_CI_ANDROID_DIRECTORY, {
      recursive: true,
      force: false,
      maxRetries: 0,
    });
  });
});

describe('CI disk preparation preserves the full Linux gate workflow', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  ).replaceAll('\r\n', '\n');
  const jobs = [...workflow.matchAll(/^ {2}([a-z-]+):\n/gm)].filter(
    (match) => match.index! > workflow.indexOf('\njobs:'),
  );
  it('prepares all four build jobs without changing the seven existing jobs', () => {
    expect(jobs.map((match) => match[1])).toEqual([
      'quality',
      'integration',
      'proxy',
      'stack',
      'connectors',
      'browser',
      'upgrade',
    ]);
    expect(workflow.match(/infrastructure\/scripts\/ci-disk-preflight\.mjs/g)).toHaveLength(4);
    for (const name of ['stack', 'connectors', 'browser', 'upgrade']) {
      const at = jobs.findIndex((match) => match[1] === name);
      const section = workflow.slice(jobs[at]!.index, jobs[at + 1]?.index);
      const preflight = section.indexOf('infrastructure/scripts/ci-disk-preflight.mjs');
      const build = section.indexOf(
        name === 'upgrade' ? 'node infrastructure/scripts/upgrade-gate.mjs' : 'pnpm stack:secrets',
      );
      expect(preflight).toBeGreaterThan(0);
      expect(preflight).toBeLessThan(build);
    }
  });
  it('cancels an obsolete PR run while retaining independent branches', () => {
    expect(workflow).toContain(
      'group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(workflow).toContain('cancel-in-progress: true');
  });
});
