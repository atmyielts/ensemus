import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rmdir,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { SandboxJobEnding } from '@ensemus/domain/sandbox';
import { SANDBOX_JOB_ID } from './oci';
import type { ContainerRuntime, RawJobResult } from './runner';

const execute = promisify(execFile);
const CGROUP_ROOT = '/sys/fs/cgroup';
const MANAGED_ID_PREFIX = 'ensemus-sandbox-';
const CONTROL_FILE_MAX_BYTES = 4096;
const CONTROL_TIMEOUT_MS = 5_000;
const CPU_CHECK_INTERVAL_MS = 10;

type CgroupStats = { cpuMs: number; peakMemoryKb: number; oom: boolean };

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function cgroupExists(cgroup: string): Promise<boolean> {
  try {
    await access(cgroup);
    return true;
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
}

function numberMetric(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error('CGROUP_METRIC_UNAVAILABLE');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('CGROUP_METRIC_UNAVAILABLE');
  return number;
}

async function usage(cgroup: string): Promise<number> {
  const data = await readFile(join(cgroup, 'cpu.stat'), 'utf8');
  return numberMetric(/^usage_usec (\d+)$/m.exec(data)?.[1]) / 1000;
}

async function cgroupStats(cgroup: string): Promise<CgroupStats> {
  const [cpuMs, peak, events] = await Promise.all([
    usage(cgroup),
    readFile(join(cgroup, 'memory.peak'), 'utf8'),
    readFile(join(cgroup, 'memory.events'), 'utf8'),
  ]);
  return {
    cpuMs,
    peakMemoryKb: Math.ceil(numberMetric(peak.trim()) / 1024),
    oom: numberMetric(/^oom_kill (\d+)$/m.exec(events)?.[1]) > 0,
  };
}

async function killCgroup(cgroup: string): Promise<void> {
  const control = await open(
    join(cgroup, 'cgroup.kill'),
    constants.O_WRONLY | constants.O_NOFOLLOW,
  );
  try {
    await control.writeFile('1');
  } finally {
    await control.close();
  }
}

/** Supports runc on a dedicated Linux x64 host with native cgroup v2. */
export function createOciCliRuntime(config: {
  binary: string;
  stateDir: string;
  /** Only the synthetic native fixture supplies this callback. */
  onBootError?: (error: unknown, runtimeLog: string) => void;
}): ContainerRuntime {
  let initialization: Promise<string> | undefined;
  let unavailable = false;

  async function control(args: string[]) {
    const { stdout } = await execute(config.binary, args, {
      env: {},
      encoding: 'utf8',
      timeout: CONTROL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: CONTROL_FILE_MAX_BYTES,
    });
    return stdout;
  }

  function runcArgs(...args: string[]): string[] {
    return ['--root', config.stateDir, '--log', '/dev/null', ...args];
  }

  function containerPath(id: string): string {
    return join(CGROUP_ROOT, id);
  }

  async function cleanup(id: string): Promise<void> {
    const cgroup = containerPath(id);
    if (await cgroupExists(cgroup)) await killCgroup(cgroup);
    // A failed start may leave only a cgroup. runc delete is allowed to report an absent state entry.
    try {
      await control(runcArgs('delete', '--force', id));
    } catch {
      if (await cgroupExists(join(config.stateDir, id))) throw new Error('RUNTIME_CLEANUP_FAILED');
    }
    try {
      await rmdir(cgroup);
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
  }

  async function initialize(): Promise<string> {
    if (
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      process.getuid?.() !== 0 ||
      !isAbsolute(config.binary) ||
      !isAbsolute(config.stateDir)
    ) {
      throw new Error('RUNTIME_PLATFORM_UNSUPPORTED');
    }
    const binary = await lstat(await realpath(config.binary));
    if ((await realpath(config.binary)) !== resolve(config.binary)) {
      throw new Error('RUNTIME_BINARY_UNTRUSTED');
    }
    if (!binary.isFile() || binary.uid !== 0 || (binary.mode & 0o022) !== 0) {
      throw new Error('RUNTIME_BINARY_UNTRUSTED');
    }
    if ((await statfs(CGROUP_ROOT)).type !== 0x63677270) throw new Error('CGROUP_V2_REQUIRED');
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const state = await lstat(config.stateDir);
    if ((await realpath(config.stateDir)) !== resolve(config.stateDir)) {
      throw new Error('RUNTIME_STATE_DIRECTORY_UNTRUSTED');
    }
    if (!state.isDirectory() || state.uid !== 0 || (state.mode & 0o077) !== 0) {
      throw new Error('RUNTIME_STATE_DIRECTORY_UNTRUSTED');
    }
    const version = /^runc version ([0-9][A-Za-z0-9.+_-]{0,62})$/m.exec(
      await control(['--version']),
    )?.[1];
    if (!version) throw new Error('RUNTIME_UNSUPPORTED');
    for (const id of await readdir(config.stateDir)) {
      if (
        id.startsWith(MANAGED_ID_PREFIX) &&
        SANDBOX_JOB_ID.test(id.slice(MANAGED_ID_PREFIX.length))
      ) {
        await cleanup(id);
      }
    }
    return version;
  }

  async function version(): Promise<string> {
    if (unavailable) throw new Error('RUNTIME_UNAVAILABLE');
    return await (initialization ??= initialize());
  }

  return {
    name: 'runc',
    version,
    async run({ jobId, bundleDir, spec, stdin, limits, signal }): Promise<RawJobResult> {
      await version();
      if (!SANDBOX_JOB_ID.test(jobId) || !isAbsolute(bundleDir))
        throw new Error('INVALID_RUNC_JOB');
      signal.throwIfAborted();
      const rootfs = await realpath(spec.root.path);
      const root = await lstat(rootfs);
      if (
        rootfs === '/' ||
        !root.isDirectory() ||
        root.uid !== 0 ||
        (root.mode & 0o022) !== 0 ||
        rootfs !== resolve(spec.root.path)
      ) {
        throw new Error('RUNTIME_ROOTFS_UNTRUSTED');
      }
      const id = MANAGED_ID_PREFIX + jobId;
      const cgroup = containerPath(id);
      const pidFile = join(bundleDir, 'runtime.pid');
      const configPath = join(bundleDir, 'config.json');
      const diagnosticLog = config.onBootError ? join(bundleDir, 'runtime.log') : null;
      // An existing directory must never be reused, including after a caller retries a job ID.
      await mkdir(cgroup, { mode: 0o700 });
      try {
        await Promise.all([
          access(join(cgroup, 'cgroup.kill'), constants.W_OK),
          cgroupStats(cgroup),
          writeFile(
            configPath,
            JSON.stringify({
              ...spec,
              linux: { ...spec.linux, cgroupsPath: '/' + id },
            }),
            { mode: 0o600, flag: 'wx' },
          ),
        ]);
        signal.throwIfAborted();
        const started = performance.now();
        const child = spawn(
          config.binary,
          [
            '--root',
            config.stateDir,
            '--log',
            diagnosticLog ?? '/dev/null',
            'run',
            '--bundle',
            bundleDir,
            '--keep',
            '--pid-file',
            pidFile,
            id,
          ],
          {
            env: {},
            cwd: bundleDir,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let stopping: Promise<void> | undefined;
        let ending: SandboxJobEnding | undefined;
        let failure: unknown;
        let completed = false;
        let signalName: NodeJS.Signals | null = null;
        const closed = new Promise<number | null>((resolve) => {
          child.once('error', (error) => {
            failure = error;
          });
          child.once('close', (code, exitSignal) => {
            completed = true;
            signalName = exitSignal;
            resolve(code);
          });
        });
        const stop = (reason: SandboxJobEnding) => {
          ending ??= reason;
          stopping ??= killCgroup(cgroup).catch((error: unknown) => {
            failure ??= error;
            child.kill('SIGKILL');
          });
        };
        const abort = () => stop('cancelled');
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        const wallTimer = setTimeout(
          () => stop('wall_limit'),
          Math.max(1, limits.wallMs - (performance.now() - started)),
        );
        // An interrupted runc initialization is bounded separately. Final cleanup kills the full cgroup.
        const stopFallback = setInterval(() => {
          if (stopping && !completed) child.kill('SIGKILL');
        }, 100);
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const maxOutput = limits.outputKb * 1024;
        child.stdout.on('data', (chunk: Buffer) => {
          const remaining = maxOutput - stdoutBytes;
          if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
          stdoutBytes += chunk.length;
          if (stdoutBytes + stderrBytes > maxOutput) stop('output_limit');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stdoutBytes + stderrBytes > maxOutput) stop('output_limit');
        });
        child.stdin.on('error', () => {
          // An entry may exit without reading its input.
        });
        child.stdin.end(stdin);
        const monitorCpu = async () => {
          try {
            while (!completed && !ending) {
              if ((await usage(cgroup)) >= limits.cpuMs) stop('cpu_limit');
              if (!completed && !ending) await delay(CPU_CHECK_INTERVAL_MS);
            }
          } catch (error) {
            failure ??= error;
            stop('cancelled');
          }
        };
        const monitor = monitorCpu();
        let exitCode: number | null;
        try {
          exitCode = await closed;
        } finally {
          clearTimeout(wallTimer);
          clearInterval(stopFallback);
          signal.removeEventListener('abort', abort);
          await monitor;
          await stopping;
        }
        if (failure) throw failure;
        const wallMs = Math.ceil(performance.now() - started);
        const stats = await cgroupStats(cgroup);
        if (!ending) {
          if (stats.oom) ending = 'memory_limit';
          else if (stats.cpuMs >= limits.cpuMs || signalName === 'SIGXCPU') ending = 'cpu_limit';
          else {
            // Distinguish a runtime setup error from a program returning nonzero.
            await access(pidFile, constants.R_OK);
            ending = 'exited';
          }
        }
        return {
          ending,
          exitCode: ending === 'exited' ? exitCode : null,
          wallMs,
          cpuMs: Math.ceil(stats.cpuMs),
          peakMemoryKb: stats.peakMemoryKb,
          stdout: Buffer.concat(stdout),
          stdoutBytes,
          stderrBytes,
        };
      } catch (error) {
        if (diagnosticLog && config.onBootError) {
          const log = await readFile(diagnosticLog, 'utf8').catch(() => '');
          config.onBootError(error, log.slice(0, CONTROL_FILE_MAX_BYTES));
        }
        throw error;
      } finally {
        await cleanup(id).catch((error: unknown) => {
          unavailable = true;
          throw new Error('RUNTIME_CLEANUP_FAILED', { cause: error });
        });
      }
    },
  };
}
