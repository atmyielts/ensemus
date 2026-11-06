// Owned by the sandbox-policy slice (EXP-05). See docs/06-delivery/m11b-slices.md and ADR-034 D3. Turns a compiled
// policy into an OCI runtime configuration. Pure, so every rule can be tested without a runtime. This file
// writing a limit down does not mean a limit holds: only a real runtime, on a real boundary, can prove that.
import type { SandboxPolicy } from '@ensemus/domain/sandbox';

/** The part of the OCI runtime specification this uses. Anything it does not name stays at its strict default. */
export type OciSpec = {
  ociVersion: '1.0.2';
  process: {
    terminal: false;
    user: { uid: number; gid: number };
    args: readonly string[];
    env: readonly string[];
    cwd: string;
    capabilities: {
      bounding: readonly string[];
      effective: readonly string[];
      inheritable: readonly string[];
      permitted: readonly string[];
      ambient: readonly string[];
    };
    rlimits: ReadonlyArray<{ type: string; hard: number; soft: number }>;
    noNewPrivileges: true;
  };
  root: { path: string; readonly: true };
  hostname: string;
  mounts: ReadonlyArray<{
    destination: string;
    type: string;
    source: string;
    options: readonly string[];
  }>;
  linux: {
    namespaces: ReadonlyArray<{ type: string }>;
    resources: {
      memory: { limit: number; swap: number };
      pids: { limit: number };
      cpu: { quota: number; period: number };
    };
    maskedPaths: readonly string[];
    readonlyPaths: readonly string[];
    seccomp: {
      defaultAction: 'SCMP_ACT_ERRNO';
      architectures: readonly string[];
      syscalls: ReadonlyArray<{ names: readonly string[]; action: 'SCMP_ACT_ALLOW' }>;
    };
  };
};

export type OciJobPaths = {
  /** A read-only root filesystem holding the runtime, prepared by the image and shared by every job. */
  rootfs: string;
  /** This job's files, written by the runner and mounted read-only at /skill. */
  skillDir: string;
};

/**
 * The rules, each with a test: every namespace including an empty network one and a user one, a read-only
 * root, /skill read-only, the only writable place a size-limited tmpfs at /tmp with noexec and nosuid, the
 * environment exactly `PATH` and `HOME=/tmp` and nothing from the runner, no capabilities, no new privileges,
 * a seccomp allowlist, memory equal to swap, pids and open files limited, RLIMIT_CPU from the policy, and
 * /proc masked as a container's is. The arguments run the entry, with nothing interpolated into a shell.
 */
export function buildOciSpec(_policy: SandboxPolicy, _paths: OciJobPaths): OciSpec {
  throw new Error('NOT_IMPLEMENTED');
}

/** What a job's process may inherit. A test keeps this list to these two, whatever the runner's own has. */
export const SANDBOX_JOB_ENVIRONMENT = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp'] as const;
