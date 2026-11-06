import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { runMigrations } from '@ensemus/database/migrate';
import { compose, repoRoot, urls } from '../helpers/stack';

export default async function setup() {
  execFileSync('node', [join(repoRoot, 'infrastructure/scripts/generate-test-secrets.mjs')], {
    stdio: 'ignore',
  });
  compose('up', '-d', '--wait', 'postgres');
  compose('run', '--rm', 'provision-roles');
  await runMigrations(urls.migrator());
}
