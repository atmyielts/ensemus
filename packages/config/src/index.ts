import { readFileSync } from 'node:fs';
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

export type TracingConfig =
  { enabled: false } | { enabled: true; endpoint: string; sampleRatio: number };

const DEFAULT_SAMPLE_RATIO = 1;

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
  const sampleRatio = ratio ? Number(ratio) : DEFAULT_SAMPLE_RATIO;
  if (!(sampleRatio >= 0 && sampleRatio <= 1)) {
    throw new ConfigError('ENSEMUS_OTEL_SAMPLE_RATIO must be between 0 and 1');
  }
  return { enabled: true, endpoint, sampleRatio };
}
