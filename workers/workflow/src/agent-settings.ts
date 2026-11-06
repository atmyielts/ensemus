import { readFileSync, statSync } from 'node:fs';

const CONTEXT_CHAR_CAP = 1_048_576;
const ARTIFACT_BYTE_CAP = 1_048_576;
const CANARY_FILE_BYTE_CAP = 1_048_576;

function positiveLimit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('INVALID_AGENT_CONTEXT_LIMIT');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error('INVALID_AGENT_CONTEXT_LIMIT');
  return value;
}

/** Engineering memory caps, applied in addition to every published agent's own token limits. */
export function loadAgentContextLimits(env: NodeJS.ProcessEnv = process.env) {
  return {
    maxInputChars: positiveLimit(env, 'ENSEMUS_AGENT_CONTEXT_MAX_CHARS', CONTEXT_CHAR_CAP),
    maxArtifactBytes: positiveLimit(env, 'ENSEMUS_AGENT_ARTIFACT_MAX_BYTES', ARTIFACT_BYTE_CAP),
  };
}

/** Optional deployment canary markers supplement key-pattern scanning; they contain no tenant policy. */
export function loadAgentCanaries(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const path = env.ENSEMUS_SECRET_CANARIES_FILE;
  if (!path) return [];
  if (statSync(path).size > CANARY_FILE_BYTE_CAP) throw new Error('INVALID_AGENT_CANARIES');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    !value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096)
  ) {
    throw new Error('INVALID_AGENT_CANARIES');
  }
  return value;
}
