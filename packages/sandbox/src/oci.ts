import type { SandboxPolicy } from '@ensemus/domain/sandbox';
import { SANDBOX_SECCOMP } from './seccomp';

export const SANDBOX_JOB_ENVIRONMENT = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp'] as const;

export type OciJobPaths = {
  rootfs: string;
  skillDir: string;
};

const FORBIDDEN_PROC_PATHS = [
  '/proc/acpi',
  '/proc/config.gz',
  '/proc/kcore',
  '/proc/keys',
  '/proc/latency_stats',
  '/proc/sched_debug',
  '/proc/scsi',
  '/proc/timer_list',
];

const READONLY_PROC_PATHS = [
  '/proc/asound',
  '/proc/bus',
  '/proc/fs',
  '/proc/irq',
  '/proc/sys',
  '/proc/sysrq-trigger',
];

const ID_MAP = [{ containerID: 0, hostID: 65532, size: 2 }];
const MEBIBYTE = 1024 ** 2;

function rlimit(type: string, limit: number) {
  return { type, hard: limit, soft: limit };
}

/** The native probe is required separately to verify enforcement by the configured runtime. */
export function buildOciSpec(policy: SandboxPolicy, paths: OciJobPaths) {
  const memoryBytes = policy.limits.memoryMb * MEBIBYTE;
  const cpuSeconds = Math.ceil(policy.limits.cpuMs / 1000);
  return {
    ociVersion: '1.0.2',
    process: {
      terminal: false,
      user: { uid: 1, gid: 1, additionalGids: [] as number[] },
      args: ['/usr/local/bin/node', '--', '/skill/' + policy.entry],
      env: SANDBOX_JOB_ENVIRONMENT,
      cwd: '/skill',
      capabilities: {
        bounding: [],
        effective: [],
        inheritable: [],
        permitted: [],
        ambient: [],
      },
      rlimits: [
        rlimit('RLIMIT_CPU', cpuSeconds),
        rlimit('RLIMIT_NOFILE', 128),
        rlimit('RLIMIT_CORE', 0),
      ],
      noNewPrivileges: true,
    },
    root: { path: paths.rootfs, readonly: true },
    hostname: 'skill',
    mounts: [
      {
        destination: '/proc',
        type: 'proc',
        source: 'proc',
        options: ['nosuid', 'nodev', 'noexec'],
      },
      {
        destination: '/dev',
        type: 'tmpfs',
        source: 'tmpfs',
        options: ['nosuid', 'noexec', 'mode=755', 'size=65536'],
      },
      {
        destination: '/skill',
        type: 'bind',
        source: paths.skillDir,
        options: ['rbind', 'ro', 'nosuid', 'nodev', 'noexec'],
      },
      {
        destination: '/tmp',
        type: 'tmpfs',
        source: 'tmpfs',
        options: [
          'nosuid',
          'nodev',
          'noexec',
          'mode=1777',
          'size=' + policy.limits.tmpfsMb * MEBIBYTE,
        ],
      },
    ],
    linux: {
      namespaces: ['pid', 'network', 'ipc', 'uts', 'mount', 'user', 'cgroup'].map((type) => ({
        type,
      })),
      // A user namespace cannot privatize inherited mounts on newer runc versions.
      // One-way slave propagation keeps the job's mount operations from reaching the host.
      rootfsPropagation: 'rslave',
      uidMappings: ID_MAP,
      gidMappings: ID_MAP,
      resources: {
        memory: { limit: memoryBytes, swap: memoryBytes },
        pids: { limit: policy.limits.pids },
        cpu: { quota: 10000, period: 10000 },
      },
      maskedPaths: FORBIDDEN_PROC_PATHS,
      readonlyPaths: READONLY_PROC_PATHS,
      seccomp: SANDBOX_SECCOMP,
    },
  } as const;
}

export type OciSpec = ReturnType<typeof buildOciSpec>;

export const SANDBOX_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Matches skillPathSchema at the runner boundary without importing manifest parsing into the runner.
export function safeSkillPath(path: string): boolean {
  return (
    path.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(path)
  );
}
