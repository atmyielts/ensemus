import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { SandboxPolicy } from '@ensemus/domain/sandbox';
import { buildOciSpec, safeSkillPath, SANDBOX_JOB_ID } from './oci';
import type { ContainerRuntime, RawJobResult } from './runner';

type JobFile = { path: string; bytes: Buffer };
const BUNDLE_DIRECTORY = /^job-[A-Za-z0-9]{6}$/;

export async function prepareWorkRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) === parse(path).root) throw new Error('INVALID_WORK_ROOT');
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  ) {
    throw new Error('WORK_ROOT_UNTRUSTED');
  }
  return await realpath(path);
}

export async function clearStaleJobBundles(workRoot: string): Promise<void> {
  const directories = await readdir(workRoot, { withFileTypes: true });
  await Promise.all(
    directories
      .filter((entry) => entry.isDirectory() && BUNDLE_DIRECTORY.test(entry.name))
      .map((entry) => rm(join(workRoot, entry.name), { recursive: true, force: true })),
  );
}

async function writeSkillFile(skillDir: string, file: JobFile): Promise<void> {
  const target = join(skillDir, file.path);
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o444,
  );
  try {
    await handle.writeFile(file.bytes);
  } finally {
    await handle.close();
  }
}

export function validJobFiles(files: readonly JobFile[], entry: string): boolean {
  if (!safeSkillPath(entry) || files.some((file) => !safeSkillPath(file.path))) return false;
  const paths = new Set(files.map((file) => file.path));
  if (!paths.has(entry) || paths.size !== files.length) return false;
  return files.every(({ path }) => {
    const segments = path.split('/');
    return segments.every(
      (_, index) => index === 0 || !paths.has(segments.slice(0, index).join('/')),
    );
  });
}

export async function runWithBundle(input: {
  runtime: ContainerRuntime;
  rootfs: string;
  workRoot: string;
  jobId: string;
  policy: SandboxPolicy;
  files: readonly JobFile[];
  stdin: Buffer;
  signal: AbortSignal;
}): Promise<RawJobResult> {
  if (!SANDBOX_JOB_ID.test(input.jobId) || !validJobFiles(input.files, input.policy.entry)) {
    throw new Error('INVALID_JOB_BUNDLE');
  }
  input.signal.throwIfAborted();
  const bundleDir = await mkdtemp(join(input.workRoot, 'job-'));
  const skillDir = join(bundleDir, 'skill');
  try {
    await mkdir(skillDir, { mode: 0o755 });
    for (const file of input.files) {
      input.signal.throwIfAborted();
      await writeSkillFile(skillDir, file);
    }
    return await input.runtime.run({
      jobId: input.jobId,
      bundleDir,
      spec: buildOciSpec(input.policy, { rootfs: input.rootfs, skillDir }),
      stdin: input.stdin,
      limits: input.policy.limits,
      signal: input.signal,
    });
  } finally {
    await rm(bundleDir, { recursive: true, force: true });
  }
}
