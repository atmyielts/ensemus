// Only the disposable GitHub-hosted Ubuntu image's unused Android SDK may be reclaimed here.
// Local machines, self-hosted runners, Docker state and workspace contents are never cleanup targets.
import { lstatSync, readFileSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { MINIMUM_BUILD_FREE_BYTES } from './disk-headroom.mjs';

export const UNUSED_CI_ANDROID_DIRECTORY = '/usr/local/lib/android';
const ancestors = ['/', '/usr', '/usr/local', '/usr/local/lib', UNUSED_CI_ANDROID_DIRECTORY];
const gibibytes = (bytes) => (Number(bytes) / 1024 ** 3).toFixed(1);

function assertHostedUbuntuContext(platform, env) {
  if (
    platform !== 'linux' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.RUNNER_OS !== 'Linux'
  )
    throw new Error('CI_DISK_GITHUB_HOSTED_LINUX_REQUIRED');
}

function absolute(path) {
  return (
    typeof path === 'string' &&
    !path.includes('\0') &&
    posix.isAbsolute(path) &&
    posix.normalize(path) === path
  );
}

function overlaps(left, right) {
  const nested = (relative) =>
    relative === '' ||
    (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative));
  return nested(posix.relative(left, right)) || nested(posix.relative(right, left));
}

/** Exact fixed allowlist, real paths and all ancestors are checked before recursive removal. */
export function assertCiDiskCleanupTarget(
  target,
  workspace,
  { lstat = lstatSync, realpath = realpathSync } = {},
) {
  if (
    target !== UNUSED_CI_ANDROID_DIRECTORY ||
    !absolute(target) ||
    !absolute(workspace) ||
    overlaps(target, workspace)
  )
    throw new Error('CI_DISK_CLEANUP_TARGET_REFUSED');
  let targetStat;
  for (const path of ancestors) {
    const stat = lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('CI_DISK_CLEANUP_SYMLINK_OR_NON_DIRECTORY');
    if (path === target) targetStat = stat;
  }
  if (realpath(target) !== target) throw new Error('CI_DISK_CLEANUP_REALPATH_REFUSED');
  return targetStat;
}

function availableBytes(statfs, workspace) {
  const stats = statfs(workspace, { bigint: true });
  if (
    typeof stats.bavail !== 'bigint' ||
    stats.bavail < 0n ||
    typeof stats.bsize !== 'bigint' ||
    stats.bsize <= 0n
  )
    throw new Error('CI_DISK_STATISTICS_INVALID');
  return stats.bavail * stats.bsize;
}

export function prepareHostedCiDisk({
  platform = process.platform,
  env = process.env,
  repositoryRoot = fileURLToPath(new URL('../..', import.meta.url)),
  readOsRelease = () => readFileSync('/etc/os-release', 'utf8'),
  lstat = lstatSync,
  realpath = realpathSync,
  statfs = statfsSync,
  remove = rmSync,
  effectiveUid = () => process.geteuid?.() ?? -1,
  log = console.log,
} = {}) {
  // Refuse a local/Windows/self-hosted invocation before even inspecting its filesystem.
  assertHostedUbuntuContext(platform, env);
  const osRelease = readOsRelease();
  if (
    !/^ID=(?:ubuntu|"ubuntu")$/m.test(osRelease) ||
    !/^VERSION_ID=(?:24\.04|"24\.04")$/m.test(osRelease)
  )
    throw new Error('CI_DISK_UBUNTU_24_REQUIRED');
  const workspace = env.GITHUB_WORKSPACE;
  if (
    !absolute(workspace) ||
    realpath(workspace) !== workspace ||
    realpath(posix.resolve(repositoryRoot)) !== workspace
  )
    throw new Error('CI_DISK_WORKSPACE_REFUSED');
  const workspaceStat = lstat(workspace);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory())
    throw new Error('CI_DISK_WORKSPACE_REFUSED');
  const before = availableBytes(statfs, workspace);
  if (before >= MINIMUM_BUILD_FREE_BYTES) {
    log(
      JSON.stringify({
        event: 'ci.disk_headroom',
        minimumGiB: 16,
        freeGiB: gibibytes(before),
        androidRemoved: false,
      }),
    );
    return { before, after: before, removed: false };
  }
  if (effectiveUid() !== 0) throw new Error('CI_DISK_PRIVILEGED_HOSTED_STEP_REQUIRED');
  const targetStat = assertCiDiskCleanupTarget(UNUSED_CI_ANDROID_DIRECTORY, workspace, {
    lstat,
    realpath,
  });
  if (targetStat.dev !== workspaceStat.dev) throw new Error('CI_DISK_CLEANUP_DIFFERENT_FILESYSTEM');
  remove(UNUSED_CI_ANDROID_DIRECTORY, { recursive: true, force: false, maxRetries: 0 });
  const after = availableBytes(statfs, workspace);
  log(
    JSON.stringify({
      event: 'ci.disk_headroom',
      minimumGiB: 16,
      freeGiB: gibibytes(after),
      androidRemoved: true,
    }),
  );
  if (after < MINIMUM_BUILD_FREE_BYTES)
    throw new Error(
      `CI_DISK_HEADROOM_STILL_LOW: ${gibibytes(after)} GiB available; at least 16 GiB required.`,
    );
  return { before, after, removed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('CI_DISK_ARGUMENTS_REFUSED');
    prepareHostedCiDisk();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'CI_DISK_PREFLIGHT_FAILED');
    process.exitCode = 1;
  }
}
