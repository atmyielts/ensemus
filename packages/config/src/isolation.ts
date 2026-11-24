import { isIP } from 'node:net';
import { z } from 'zod';
import { ConfigError } from './index';

const name = z.string().trim().min(1).max(128);
const endpoint = z.strictObject({
  host: z.string().refine((host) => isIP(host) !== 0),
  port: z.int().min(1).max(65535),
});
const names = z.array(name).max(32);
const endpoints = z.array(endpoint).max(32);
const peerEndpoints = z.strictObject({
  database: endpoints.default([]),
  temporal: endpoints.default([]),
  objects: endpoints.default([]),
});
const declarations = z.strictObject({
  backups: z.string().trim().min(1).max(200).optional(),
  embeddings: z.string().trim().min(1).max(200).optional(),
  telemetry: z.string().trim().min(1).max(200).optional(),
  key_encryption_key: z.string().trim().min(1).max(200).optional(),
});

function readSetting<T>(env: NodeJS.ProcessEnv, key: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(env[key] ? JSON.parse(env[key]) : undefined);
  } catch {
    throw new ConfigError(`Invalid isolation setting: ${key}`);
  }
}

export function loadIsolationConfig(env: NodeJS.ProcessEnv = process.env) {
  const releaseVersion = name.safeParse(env.ENSEMUS_RELEASE_VERSION ?? env.ENSEMUS_RELEASE);
  if (!releaseVersion.success)
    throw new ConfigError('Set ENSEMUS_RELEASE_VERSION for the isolation report');
  return {
    releaseVersion: releaseVersion.data,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    bucket: env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    peers: readSetting(env, 'ENSEMUS_ISOLATION_FOREIGN_ENDPOINTS', peerEndpoints.prefault({})),
    namespaces: readSetting(env, 'ENSEMUS_ISOLATION_FOREIGN_NAMESPACES', names.default([])),
    buckets: readSetting(env, 'ENSEMUS_ISOLATION_FOREIGN_BUCKETS', names.default([])),
    declarations: readSetting(env, 'ENSEMUS_ISOLATION_DECLARATIONS', declarations.default({})),
  };
}
export type IsolationConfig = ReturnType<typeof loadIsolationConfig>;
