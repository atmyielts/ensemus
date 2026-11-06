import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SANDBOX_DEFAULT_CEILINGS, type SandboxLimits } from '@ensemus/domain/sandbox';
import { z } from 'zod';

export const commercialModes = ['cloud', 'byom', 'sovereign'] as const;
export type CommercialMode = (typeof commercialModes)[number];

/** A config error names the setting, never its value. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Reads a secret from NAME_FILE (a mounted secret) or NAME. Secrets are read at runtime only, so
 * images never contain them. Files win over plain variables.
 */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = env[`${name}_FILE`];
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (!value) throw new ConfigError(`${name}_FILE points to an empty file`);
    return value;
  }
  const value = env[name];
  if (!value) throw new ConfigError(`Missing required secret ${name} or ${name}_FILE`);
  return value;
}

const publicUrl = z.url().refine((u) => !u.endsWith('/'), 'must not end with a slash');

const webSchema = z.object({
  ENSEMUS_MODE: z.enum(commercialModes),
  ENSEMUS_PUBLIC_URL: publicUrl,
  ENSEMUS_ALLOW_SIGNUP: z.enum(['true', 'false']).default('false'),
  // Off unless the connector worker is running. Off means no connection can be made, and the webhook
  // address answers as if it does not exist, so nothing waits for a worker that is not there (ADR-027).
  ENSEMUS_CONNECTORS_ENABLED: z.enum(['true', 'false']).default('false'),
});

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = webSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid web configuration: ${fields}`);
  }
  return {
    mode: parsed.data.ENSEMUS_MODE,
    publicUrl: parsed.data.ENSEMUS_PUBLIC_URL,
    allowSignup: parsed.data.ENSEMUS_ALLOW_SIGNUP === 'true',
    connectorsEnabled: parsed.data.ENSEMUS_CONNECTORS_ENABLED === 'true',
  };
}

// --- M11B (ADR-034). Each feature is off until an operator turns it on, and turning on the sandbox here
// does not provision a runner: with none reachable, every run ends runner_unavailable.

const onOff = z.enum(['true', 'false']).default('false');

const skillFeaturesSchema = z.object({
  ENSEMUS_SKILL_CATALOG_ENABLED: onOff,
  ENSEMUS_SANDBOX_ENABLED: onOff,
  ENSEMUS_MARKETPLACE_ENABLED: onOff,
});

/** Which of these a deployment offers. Used with M8's entitlements once those exist, not instead of them. */
export function loadSkillFeatures(env: NodeJS.ProcessEnv = process.env) {
  const parsed = skillFeaturesSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid feature configuration: ${fields}`);
  }
  return {
    skill_catalog: parsed.data.ENSEMUS_SKILL_CATALOG_ENABLED === 'true',
    sandbox: parsed.data.ENSEMUS_SANDBOX_ENABLED === 'true',
    marketplace: parsed.data.ENSEMUS_MARKETPLACE_ENABLED === 'true',
  };
}

const ceilingFields: ReadonlyArray<readonly [keyof SandboxLimits, string]> = [
  ['wallMs', 'ENSEMUS_SANDBOX_MAX_WALL_MS'],
  ['cpuMs', 'ENSEMUS_SANDBOX_MAX_CPU_MS'],
  ['memoryMb', 'ENSEMUS_SANDBOX_MAX_MEMORY_MB'],
  ['tmpfsMb', 'ENSEMUS_SANDBOX_MAX_TMPFS_MB'],
  ['outputKb', 'ENSEMUS_SANDBOX_MAX_OUTPUT_KB'],
  ['pids', 'ENSEMUS_SANDBOX_MAX_PIDS'],
];

/** The most any one job may ask for here. A package asking for more is refused, not narrowed. */
export function loadSandboxCeilings(env: NodeJS.ProcessEnv = process.env): SandboxLimits {
  const ceilings = { ...SANDBOX_DEFAULT_CEILINGS };
  for (const [field, name] of ceilingFields) {
    const value = env[name];
    if (value === undefined) continue;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
      throw new ConfigError(`${name} must be a positive whole number`);
    }
    ceilings[field] = number;
  }
  return ceilings;
}

/**
 * The public keys whose signatures make a listing installable, as a comma-separated list of raw 32-byte
 * Ed25519 keys in base64. None by default, which means nothing can be installed. Public keys, so this is
 * not a secret, but it is the root of trust, so it lives where only an operator can change it.
 */
export function loadReviewKeys(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const item of (env.ENSEMUS_MARKETPLACE_REVIEW_KEYS ?? '').split(',')) {
    const encoded = item.trim();
    if (!encoded) continue;
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new ConfigError('ENSEMUS_MARKETPLACE_REVIEW_KEYS holds something that is not a key');
    }
    keys.set(createHash('sha256').update(key).digest('hex'), key);
  }
  return keys;
}

export function loadSkillWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  return { ceilings: loadSandboxCeilings(env), reviewKeys: loadReviewKeys(env) };
}

const sandboxWorkerSchema = z.object({
  ENSEMUS_SANDBOX_RUNNER_URL: z.url().default('http://sandbox-runner:8080'),
  ENSEMUS_SANDBOX_MAX_CONCURRENT_PER_TENANT: z.coerce.number().int().min(1).default(2),
  ENSEMUS_SANDBOX_PROBE_MAX_AGE_MS: z.coerce.number().int().min(1000).default(300_000),
});

export function loadSandboxWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = sandboxWorkerSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid sandbox worker configuration: ${fields}`);
  }
  return {
    runnerUrl: parsed.data.ENSEMUS_SANDBOX_RUNNER_URL,
    maxConcurrentPerTenant: parsed.data.ENSEMUS_SANDBOX_MAX_CONCURRENT_PER_TENANT,
    probeMaxAgeMs: parsed.data.ENSEMUS_SANDBOX_PROBE_MAX_AGE_MS,
  };
}

const sandboxRunnerSchema = z.object({
  // No default, on purpose: with none set, the runner refuses every job.
  ENSEMUS_SANDBOX_RUNTIME_BINARY: z.string().min(1).optional(),
  ENSEMUS_SANDBOX_STATE_DIR: z.string().min(1).default('/run/sandbox-state'),
  ENSEMUS_SANDBOX_ROOTFS: z.string().min(1).default('/opt/sandbox/rootfs'),
  ENSEMUS_SANDBOX_WORK_ROOT: z.string().min(1).default('/run/sandbox-jobs'),
  ENSEMUS_SANDBOX_RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ENSEMUS_SANDBOX_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).default(2),
});

export function loadSandboxRunnerConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = sandboxRunnerSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid sandbox runner configuration: ${fields}`);
  }
  return {
    runtimeBinary: parsed.data.ENSEMUS_SANDBOX_RUNTIME_BINARY ?? null,
    stateDir: parsed.data.ENSEMUS_SANDBOX_STATE_DIR,
    rootfs: parsed.data.ENSEMUS_SANDBOX_ROOTFS,
    workRoot: parsed.data.ENSEMUS_SANDBOX_WORK_ROOT,
    port: parsed.data.ENSEMUS_SANDBOX_RUNNER_PORT,
    maxConcurrentJobs: parsed.data.ENSEMUS_SANDBOX_MAX_CONCURRENT_JOBS,
    ceilings: loadSandboxCeilings(env),
  };
}
