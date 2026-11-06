import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const composeFiles = [
  'infrastructure/compose/compose.yaml',
  'infrastructure/compose/compose.test.yaml',
];

export function secret(name: string): string {
  return readFileSync(join(repoRoot, '.local', 'secrets', name), 'utf8').trim();
}

/** A connection URL for a role, reaching Postgres through the test-only published port. */
export function dbUrl(role: string, passwordFile: string, database = 'ensemus'): string {
  // Parallel runs each set their own port and COMPOSE_PROJECT_NAME, so they share no database.
  const port = process.env.ENSEMUS_TEST_PG_PORT ?? '55432';
  return `postgres://${role}:${secret(passwordFile)}@127.0.0.1:${port}/${database}`;
}

export const urls = {
  migrator: () => dbUrl('ensemus_migrator', 'db_migrator_password'),
  app: () => dbUrl('ensemus_app', 'db_app_password'),
  auth: () => dbUrl('ensemus_auth', 'db_auth_password'),
  dispatcher: () => dbUrl('ensemus_dispatcher', 'db_dispatcher_password'),
  secrets: () => dbUrl('ensemus_secrets', 'db_secrets_password'),
  // Needs the provisioning step recorded in ADR-028 under "Role provisioning".
  agent: () => dbUrl('ensemus_agent', 'db_agent_password'),
  superuser: () => dbUrl('postgres', 'db_superuser_password'),
};

export function compose(...args: string[]): string {
  return composeWith({}, ...args);
}

/** The same, with settings the compose files read from the environment. */
export function composeWith(env: Record<string, string>, ...args: string[]): string {
  const all = process.env.ENSEMUS_COMPOSE_AIRGAP
    ? [...composeFiles, 'infrastructure/compose/compose.airgap.yaml']
    : composeFiles;
  const files = all.flatMap((f) => ['-f', f]);
  return execFileSync('docker', ['compose', ...files, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // A database dump is scanned whole, and the default limit of 1 MB would stop short of the end.
    maxBuffer: 512 * 1024 * 1024,
  });
}
