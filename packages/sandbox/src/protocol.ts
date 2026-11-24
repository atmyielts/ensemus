// What passes between the sandbox worker and the runner, on an internal network with nothing else on it. The
// runner learns no tenant, person or skill name. Fixed by the foundation (ADR-034 D3): both sides import this.
import {
  ISOLATION_CHECKS,
  SANDBOX_JOB_ENDINGS,
  SANDBOX_RUNTIMES,
  type IsolationProbeReport,
  type SandboxPolicy,
} from '@ensemus/domain/sandbox';
import { z } from 'zod';
import { SANDBOX_JOB_ID } from './oci';

export const RUNNER_JOBS_PATH = '/v1/jobs';
export const RUNNER_PROBE_PATH = '/v1/probe';
export const RUNNER_HEALTH_PATH = '/healthz';
/** The runner refuses anything larger before parsing it. A bundle, its base64 and a bounded input. */
export const RUNNER_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

const limitsSchema = z.strictObject({
  wallMs: z.int().min(100).max(600_000),
  cpuMs: z.int().min(100).max(600_000),
  memoryMb: z.int().min(32).max(4096),
  tmpfsMb: z.int().min(1).max(1024),
  outputKb: z.int().min(1).max(1024),
  pids: z.int().min(1).max(256),
});

export const sandboxPolicySchema = z.strictObject({
  policyVersion: z.literal(1),
  runtime: z.enum(SANDBOX_RUNTIMES),
  entry: z.string().min(1).max(200),
  network: z.strictObject({ mode: z.literal('none') }),
  credentials: z.literal('none'),
  environment: z.literal('fixed_empty'),
  filesystem: z.strictObject({
    root: z.literal('read_only'),
    skill: z.literal('read_only'),
    scratch: z.literal('tmpfs_only'),
  }),
  limits: limitsSchema,
}) satisfies z.ZodType<SandboxPolicy>;

export const runnerJobRequestSchema = z.strictObject({
  jobId: z.string().regex(SANDBOX_JOB_ID),
  policy: sandboxPolicySchema,
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  files: z
    .array(z.strictObject({ path: z.string().min(1).max(200), contentBase64: base64 }))
    .max(500),
  stdinBase64: base64,
});
export type RunnerJobRequest = z.infer<typeof runnerJobRequestSchema>;

export const runnerJobResponseSchema = z.strictObject({
  ending: z.enum(SANDBOX_JOB_ENDINGS),
  exitCode: z.int().nullable(),
  wallMs: z.int().min(0),
  cpuMs: z.int().min(0),
  peakMemoryKb: z.int().min(0),
  stdoutBase64: base64,
  stdoutBytes: z.int().min(0),
  stderrBytes: z.int().min(0),
  runtime: z.strictObject({ name: z.string().max(64), version: z.string().max(64) }),
});
export type RunnerJobResponse = z.infer<typeof runnerJobResponseSchema>;

export const runnerProbeResponseSchema = z.strictObject({
  runtime: z.string().max(64),
  runtimeVersion: z.string().max(64),
  probedAt: z.iso.datetime(),
  checks: z.array(z.strictObject({ check: z.enum(ISOLATION_CHECKS), passed: z.boolean() })).max(64),
}) satisfies z.ZodType<IsolationProbeReport>;
