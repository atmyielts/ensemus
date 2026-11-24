import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
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
  // Off unless the mail worker is running (the `mail` profile). Off means nobody is promised an email:
  // password reset by email is not offered, and an invitation is a link to copy (0571).
  ENSEMUS_MAIL_ENABLED: z.enum(['true', 'false']).default('false'),
});

const uuidValue = z.uuid();
const whole = z.coerce.number().int().positive();

const saasSchema = z
  .object({
    ENSEMUS_MODE: z.enum(commercialModes).optional(),
    // Off unless named. Sovereign can never turn it on: nothing there phones home or bills (ADR-032 D1).
    ENSEMUS_BILLING_ENABLED: z.enum(['true', 'false']).default('false'),
    ENSEMUS_BILLING_ORGANIZATION_ID: uuidValue.optional(),
    ENSEMUS_BILLING_CONNECTION_ID: uuidValue.optional(),
    ENSEMUS_PAYMENT_PROCESSOR: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,63}$/)
      .optional(),
    // Off unless named, and then a limit is required, since there is no default length (ADR-032 D8).
    ENSEMUS_BREAK_GLASS_ENABLED: z.enum(['true', 'false']).default('false'),
    ENSEMUS_BREAK_GLASS_MAX_MINUTES: whole.optional(),
  })
  .refine((c) => !(c.ENSEMUS_BILLING_ENABLED === 'true' && c.ENSEMUS_MODE === 'sovereign'), {
    path: ['ENSEMUS_BILLING_ENABLED'],
  })
  .refine(
    (c) =>
      c.ENSEMUS_BREAK_GLASS_ENABLED !== 'true' || c.ENSEMUS_BREAK_GLASS_MAX_MINUTES !== undefined,
    { path: ['ENSEMUS_BREAK_GLASS_MAX_MINUTES'] },
  );

/** The hosted service's settings, for the web tier and the workers alike (ADR-032). */
export function loadSaasConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = saasSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid hosted service configuration: ${fields}`);
  }
  const c = parsed.data;
  return {
    billingEnabled: c.ENSEMUS_BILLING_ENABLED === 'true',
    billingOrganizationId: c.ENSEMUS_BILLING_ORGANIZATION_ID ?? null,
    billingConnectionId: c.ENSEMUS_BILLING_CONNECTION_ID ?? null,
    paymentProcessor: c.ENSEMUS_PAYMENT_PROCESSOR ?? null,
    breakGlass:
      c.ENSEMUS_BREAK_GLASS_ENABLED === 'true' && c.ENSEMUS_BREAK_GLASS_MAX_MINUTES !== undefined
        ? { enabled: true as const, maxMinutes: c.ENSEMUS_BREAK_GLASS_MAX_MINUTES }
        : { enabled: false as const },
  };
}
export {
  deploymentProfileHash,
  loadExplicitTenancyConfig,
  loadResidencyPolicy,
  loadTenancyConfig,
  type TenancyConfig,
} from './tenancy';

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
    mailEnabled: parsed.data.ENSEMUS_MAIL_ENABLED === 'true',
  };
}

/**
 * The operator's settings for where a model may be reached (ADR-028 FD-10, FD-21). Tenants can set neither.
 * The review reference is what lets a key for a hosted provider be stored at all, and with none, it cannot.
 */
export function loadModelEgressSettings(env: NodeJS.ProcessEnv = process.env) {
  const privateEndpoints = (env.ENSEMUS_PRIVATE_MODEL_ENDPOINTS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const reviewed = env.ENSEMUS_MODEL_CREDENTIALS_REVIEWED?.trim();
  return { privateEndpoints, credentialsReviewed: reviewed ? reviewed : null };
}

const EVALUATION_KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EVALUATION_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
/**
 * A week. A policy change already voids a report, so this bounds the rest: how long a report outlives a
 * change to the harness or the platform under it, and how long a retired key's reports still count.
 */
const DEFAULT_EVALUATION_MAX_AGE_HOURS = 168;
const MAX_EVALUATION_MAX_AGE_HOURS = 24 * 366;

/**
 * The web tier's side of signed evaluation reports (AGENT-16): the public keys an evaluator signs with,
 * as `key-id:<32-byte Ed25519 public key, base64url>` separated by commas, and how old a report may be.
 * Two keys at once is how a key is rotated. None at all means no report is accepted, so nothing publishes.
 * They are public, but may come from a mounted file (`_FILE`, which wins) like a secret, for the same reason:
 * the image never holds them.
 */
export function loadEvaluationTrustSettings(env: NodeJS.ProcessEnv = process.env) {
  const file = env.ENSEMUS_EVALUATION_PUBLIC_KEYS_FILE;
  const listed = file ? readFileSync(file, 'utf8') : (env.ENSEMUS_EVALUATION_PUBLIC_KEYS ?? '');
  const entries = listed
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const publicKeys = entries.map((entry) => {
    const [keyId, publicKey, ...rest] = entry.split(':');
    if (
      rest.length > 0 ||
      !keyId ||
      !publicKey ||
      !EVALUATION_KEY_ID.test(keyId) ||
      !EVALUATION_PUBLIC_KEY.test(publicKey)
    ) {
      throw new ConfigError('Invalid ENSEMUS_EVALUATION_PUBLIC_KEYS');
    }
    return { keyId, publicKey };
  });
  if (new Set(publicKeys.map((key) => key.keyId)).size !== publicKeys.length) {
    throw new ConfigError('Invalid ENSEMUS_EVALUATION_PUBLIC_KEYS');
  }
  const age = env.ENSEMUS_EVALUATION_REPORT_MAX_AGE_HOURS?.trim();
  const maxAgeHours = age ? Number(age) : DEFAULT_EVALUATION_MAX_AGE_HOURS;
  if (
    !/^\d+$/.test(String(maxAgeHours)) ||
    maxAgeHours < 1 ||
    maxAgeHours > MAX_EVALUATION_MAX_AGE_HOURS
  ) {
    throw new ConfigError('Invalid ENSEMUS_EVALUATION_REPORT_MAX_AGE_HOURS');
  }
  return { publicKeys, maxAgeHours };
}

/**
 * The signing side, held by CI and the agent worker and never by web: a key id, and an Ed25519 private key
 * in PKCS#8 PEM, read like every other secret from a mounted file or the environment. Null when no key id
 * is set, which means this process does not sign; a key id without its key is a configuration error.
 */
export function loadEvaluationSigningSettings(env: NodeJS.ProcessEnv = process.env) {
  const keyId = env.ENSEMUS_EVALUATION_SIGNING_KEY_ID?.trim();
  if (!keyId) return null;
  if (!EVALUATION_KEY_ID.test(keyId)) {
    throw new ConfigError('Invalid ENSEMUS_EVALUATION_SIGNING_KEY_ID');
  }
  return { keyId, privateKeyPem: readSecret('ENSEMUS_EVALUATION_SIGNING_KEY', env) };
}

export type TelemetryConfig =
  | { enabled: false }
  | { enabled: true; endpoint: string; sampleRatio: number; metricIntervalMs: number };

const DEFAULT_SAMPLE_RATIO = 1;
const DEFAULT_METRIC_INTERVAL_SECONDS = 60;

/**
 * Traces and metrics go nowhere unless an operator names their own OpenTelemetry collector (ADR-037 D3),
 * so an install that says nothing loads no exporter and makes no outbound attempt. The endpoint is the
 * collector's OTLP/HTTP base, such as `http://otel-collector:4318`; the signal paths are added to it, and
 * nothing else in the environment can redirect them. A collector address is not a place for a credential,
 * and there is no setting for headers, because the only thing to put there is a secret. A bad value stops
 * the process, because telemetry that looks on and is not would be a false reading. Errors name the
 * setting, never its value.
 */
export function loadTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const endpoint = env.ENSEMUS_OTEL_ENDPOINT;
  if (!endpoint) {
    for (const name of ['ENSEMUS_OTEL_SAMPLE_RATIO', 'ENSEMUS_OTEL_METRIC_INTERVAL_SECONDS'])
      if (env[name]) throw new ConfigError(`${name} is set without ENSEMUS_OTEL_ENDPOINT`);
    return { enabled: false };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigError('ENSEMUS_OTEL_ENDPOINT is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ConfigError('ENSEMUS_OTEL_ENDPOINT must be http or https');
  if (url.username || url.password || url.search || url.hash)
    throw new ConfigError(
      'ENSEMUS_OTEL_ENDPOINT must not carry credentials, a query or a fragment',
    );
  if (url.pathname !== '/')
    throw new ConfigError('ENSEMUS_OTEL_ENDPOINT must be the collector base, with no path');
  const ratio = env.ENSEMUS_OTEL_SAMPLE_RATIO;
  const sampleRatio = ratio ? Number(ratio) : DEFAULT_SAMPLE_RATIO;
  if (!(sampleRatio >= 0 && sampleRatio <= 1))
    throw new ConfigError('ENSEMUS_OTEL_SAMPLE_RATIO must be between 0 and 1');
  const interval = env.ENSEMUS_OTEL_METRIC_INTERVAL_SECONDS;
  const seconds = interval ? Number(interval) : DEFAULT_METRIC_INTERVAL_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600)
    throw new ConfigError(
      'ENSEMUS_OTEL_METRIC_INTERVAL_SECONDS must be a whole number from 5 to 3600',
    );
  return { enabled: true, endpoint: url.origin, sampleRatio, metricIntervalMs: seconds * 1000 };
}

// --- M11B (ADR-034). Each feature is off until an operator turns it on, and turning on the sandbox here
// does not provision a runner: with none reachable, every run ends runner_unavailable.

const onOff = z.enum(['true', 'false']).default('false');

const skillFeaturesSchema = z.object({
  ENSEMUS_SKILL_CATALOG_ENABLED: onOff,
  ENSEMUS_SANDBOX_ENABLED: onOff,
  ENSEMUS_MARKETPLACE_ENABLED: onOff,
});

/** Operator switches only. New work also requires the current company entitlement. */
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

function isSandboxPrivateHost(host: string): boolean {
  if (host === '127.0.0.1') return true;
  if (!isIPv4(host)) return false;
  const [first = 0, second = 0] = host.split('.').map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

const sandboxRunnerUrl = z.string().refine((text) => {
  const host = /^https?:\/\/((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?::[0-9]+)?\/?$/.exec(text)?.[1];
  const url = URL.parse(text);
  return host !== undefined && isSandboxPrivateHost(host) && url?.hostname === host;
});

const sandboxWorkerSchema = z.object({
  ENSEMUS_SANDBOX_RUNNER_URL: sandboxRunnerUrl.default('http://127.0.0.1:8080'),
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
  ENSEMUS_SANDBOX_RUNNER_BIND_HOST: z.string().refine(isSandboxPrivateHost).default('127.0.0.1'),
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
    host: parsed.data.ENSEMUS_SANDBOX_RUNNER_BIND_HOST,
    port: parsed.data.ENSEMUS_SANDBOX_RUNNER_PORT,
    maxConcurrentJobs: parsed.data.ENSEMUS_SANDBOX_MAX_CONCURRENT_JOBS,
    ceilings: loadSandboxCeilings(env),
  };
}

export type TracingConfig =
  { enabled: false } | { enabled: true; endpoint: string; sampleRatio: number };

const DEFAULT_TRACING_SAMPLE_RATIO = 1;

/**
 * Traces go nowhere unless an operator names their own collector (ADR-037 D3), so an install that says
 * nothing makes no outbound attempt. A collector address is not a place for a credential, and a bad
 * value stops the process, because tracing that looks on and is not would be a false reading. The error
 * names the setting, never its value.
 */
export function loadTracingConfig(env: NodeJS.ProcessEnv = process.env): TracingConfig {
  const endpoint = env.ENSEMUS_OTEL_ENDPOINT;
  if (!endpoint) {
    if (env.ENSEMUS_OTEL_SAMPLE_RATIO) {
      throw new ConfigError('ENSEMUS_OTEL_SAMPLE_RATIO is set without ENSEMUS_OTEL_ENDPOINT');
    }
    return { enabled: false };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigError('ENSEMUS_OTEL_ENDPOINT is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('ENSEMUS_OTEL_ENDPOINT must be http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      'ENSEMUS_OTEL_ENDPOINT must not carry credentials, a query or a fragment',
    );
  }
  const ratio = env.ENSEMUS_OTEL_SAMPLE_RATIO;
  const sampleRatio = ratio ? Number(ratio) : DEFAULT_TRACING_SAMPLE_RATIO;
  if (!(sampleRatio >= 0 && sampleRatio <= 1)) {
    throw new ConfigError('ENSEMUS_OTEL_SAMPLE_RATIO must be between 0 and 1');
  }
  return { enabled: true, endpoint, sampleRatio };
}
