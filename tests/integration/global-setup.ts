import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { runMigrations } from '@ensemus/database/migrate';
import { compose, repoRoot, urls } from '../helpers/stack';

/**
 * ADR-028 open question 12, part 1. Marks this test cluster as a qualification database, so the
 * suites may append 'qualification_fixture' capability rows (0590_deleg refuses them, and ignores any
 * left behind, without this role). A cluster-level NOLOGIN role is an installation-time fact: only a
 * superuser or a CREATEROLE identity can create it, and no Ensemus role has either. Created here, by the
 * test superuser, and by no install script or migration.
 */
async function markQualificationDatabase() {
  const su = new pg.Client({ connectionString: urls.superuser() });
  await su.connect();
  try {
    await su.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='ensemus_delegation_qualification_ci') then
        create role ensemus_delegation_qualification_ci nologin nosuperuser nocreaterole nobypassrls noinherit;
      end if;
    end $$`);
  } finally {
    await su.end();
  }
}

export default async function setup() {
  execFileSync('node', [join(repoRoot, 'infrastructure/scripts/generate-test-secrets.mjs')], {
    stdio: 'ignore',
  });
  compose('up', '-d', '--wait', 'postgres');
  compose('run', '--rm', 'provision-roles');
  await markQualificationDatabase();
  await runMigrations(urls.migrator());
}
