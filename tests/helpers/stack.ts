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
  return `postgres://${role}:${secret(passwordFile)}@127.0.0.1:55432/${database}`;
}

export const urls = {
  migrator: () => dbUrl('ensemus_migrator', 'db_migrator_password'),
  app: () => dbUrl('ensemus_app', 'db_app_password'),
  auth: () => dbUrl('ensemus_auth', 'db_auth_password'),
  dispatcher: () => dbUrl('ensemus_dispatcher', 'db_dispatcher_password'),
  secrets: () => dbUrl('ensemus_secrets', 'db_secrets_password'),
  superuser: () => dbUrl('postgres', 'db_superuser_password'),
};

export function compose(...args: string[]): string {
  const files = composeFiles.flatMap((f) => ['-f', f]);
  return execFileSync('docker', ['compose', ...files, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
