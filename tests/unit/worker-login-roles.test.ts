// ADR-039 D1 to D3 without a database: the two migrations read as text, the journal, the provisioning
// files and the Compose wiring. What they do to a real server is tests/integration/worker-login-roles.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const migrations = join(repoRoot, 'packages/database/migrations');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const WORKERS = ['ensemus_worker', 'ensemus_connector', 'ensemus_knowledge'] as const;

/** A comparison of the caller's role with the web tier's role, written the way 0700 rewrites away. */
const RAW_TIER_CHECK =
  /\b(?:session_user|current_user)\s*(?:=|<>|!=|(?:NOT\s+)?IN\s*\()\s*'ensemus_app'|\b(?:session_user|current_user)\s+(?:NOT\s+)?IN\s*\([^)]*'ensemus_app'/i;

describe('migrations 0700 and 0701', () => {
  for (const name of ['0700_worker_login_roles', '0701_worker_role_narrowing']) {
    it(`${name} is flagged for human security review on its first line, and journalled`, () => {
      const sql = readFileSync(join(migrations, `${name}.sql`), 'utf8');
      expect(sql.split(/\r?\n/)[0]).toBe('-- FLAGGED FOR HUMAN SECURITY REVIEW');
      const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8')) as {
        entries: { idx: number; tag: string; when: number }[];
      };
      const entry = journal.entries.find((e) => e.tag === name);
      expect(entry).toBeDefined();
      // Each joined migration must be newer than its predecessors. Other RC features can follow it.
      const others = journal.entries.filter((e) => e.idx < entry!.idx);
      expect(entry!.when).toBeGreaterThan(Math.max(...others.map((e) => e.when)));
    });
  }

  const sql0700 = readFileSync(join(migrations, '0700_worker_login_roles.sql'), 'utf8');
  const sql0701 = readFileSync(join(migrations, '0701_worker_role_narrowing.sql'), 'utf8');

  it('0700 refuses to run until every worker login exists, belongs to ensemus_app alone and is ordinary', () => {
    for (const role of WORKERS) expect(sql0700).toContain(`'${role}'`);
    expect(sql0700).toContain('WORKER_ROLE_MISSING');
    expect(sql0700).toMatch(
      /rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication/,
    );
    expect(sql0700).toContain("p.rolname<>'ensemus_app'");
  });

  it('0700 maps the worker logins, and only them, onto ensemus_app', () => {
    const mapped = [...sql0700.matchAll(/CASE WHEN (session_user|current_user) IN \(([^)]*)\)/g)];
    expect(mapped.map((m) => m[1])).toEqual(['session_user', 'current_user']);
    for (const m of mapped)
      expect(m[2]!.split(',').map((x) => x.trim().replace(/'/g, ''))).toEqual([...WORKERS]);
  });

  it('0700 rewrites functions and policies, and checks nothing raw is left anywhere', () => {
    expect(sql0700).toContain('pg_get_functiondef');
    expect(sql0700).toContain('ALTER POLICY');
    expect(sql0700).toContain('TIER_REWRITE_INCOMPLETE');
    for (const place of ['pg_views', 'pg_trigger', 'pg_constraint', 'pg_attrdef', 'pg_policy'])
      expect(sql0700).toContain(place);
  });

  it('0701 takes every suite read grant from ensemus_app and gives the connector worker its own', () => {
    expect(sql0701).toContain('REVOKE ALL ON integrations.suite_reads FROM ensemus_app;');
    expect(sql0701).toMatch(/GRANT DELETE ON integrations\.suite_reads TO ensemus_connector;/);
    expect(sql0701).not.toMatch(/GRANT [^;]*suite_reads TO [^;]*ensemus_app/);
    // The output stays the agent role's alone, from 0563.
    expect(sql0701).not.toMatch(/GRANT SELECT \([^)]*\boutput\b[^_]/);
  });

  it('0701 asks for the connector login, not the actor type alone, wherever only it should pass', () => {
    const connectorChecks = sql0701.match(
      /current_user\s*=\s*'ensemus_connector'\s+AND\s+session_user\s*=\s*'ensemus_connector'/g,
    );
    // The two policies (one twice), the suite read guard, the exchange and the scope narrowing.
    expect(connectorChecks?.length).toBe(6);
    expect(sql0701).toMatch(
      /current_user='ensemus_worker' AND session_user='ensemus_worker' AND knowledge\.is_service_actor\(\)/,
    );
  });

  it('no migration after 0700 compares the caller with ensemus_app by its raw name', () => {
    const later = readdirSync(migrations)
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .filter((file) => Number(file.slice(0, 4)) >= 701 && Number(file.slice(0, 4)) < 999);
    expect(later).toContain('0701_worker_role_narrowing.sql');
    for (const file of later) {
      const text = readFileSync(join(migrations, file), 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      expect(RAW_TIER_CHECK.test(text), file).toBe(false);
    }
  });

  it('the raw-check pattern finds the forms the older migrations use', () => {
    for (const form of [
      "session_user='ensemus_app'",
      "current_user<>'ensemus_app'",
      "current_user NOT IN('ensemus_app','ensemus_agent')",
      "session_user IN ('ensemus_app','ensemus_agent')",
    ])
      expect(RAW_TIER_CHECK.test(form), form).toBe(true);
    expect(RAW_TIER_CHECK.test("app.tier_session_user()='ensemus_app'")).toBe(false);
  });
});

describe('provisioning the worker logins', () => {
  it('creates each one for a new server and an existing one, from a mounted password', () => {
    const provision = read('infrastructure/compose/postgres/provision.sql');
    const upgrade = read('infrastructure/compose/postgres/upgrade-roles-workers.sql');
    const firstBoot = read('infrastructure/compose/postgres/10-provision.sh');
    const job = read('infrastructure/compose/postgres/upgrade-roles.sh');
    for (const role of WORKERS) {
      const short = role.replace('ensemus_', '');
      expect(provision).toMatch(
        new RegExp(
          `CREATE ROLE ${role} LOGIN PASSWORD :'${short}_password'[^;]*IN ROLE ensemus_app;`,
        ),
      );
      expect(upgrade).toContain(`ALTER ROLE ${role} WITH LOGIN PASSWORD :'${short}_password';`);
      for (const script of [firstBoot, job])
        expect(script).toContain(`${short}_password="$(cat /run/secrets/db_${short}_password)"`);
    }
    expect(job).toContain('/provision/upgrade-roles-workers.sql');
  });

  it('writes a password and a URL for each in the test secrets', () => {
    const script = read('infrastructure/scripts/generate-test-secrets.mjs');
    for (const role of WORKERS) {
      const short = role.replace('ensemus_', '');
      expect(script).toContain(`'${short}',`);
      expect(script).toContain(`['db_${short}_url', '${role}', 'db_${short}_password']`);
    }
  });
});

describe('the Compose wiring', () => {
  type Service = {
    environment?: Record<string, string>;
    secrets?: (string | { source: string })[];
    volumes?: string[];
  };
  const compose = parse(read('infrastructure/compose/compose.yaml')) as {
    services: Record<string, Service>;
    secrets: Record<string, unknown>;
  };
  const secretsOf = (service: Service) =>
    (service.secrets ?? []).map((s) => (typeof s === 'string' ? s : s.source));

  it.each([
    ['web', 'db_app_url'],
    ['worker', 'db_worker_url'],
    ['knowledge-worker', 'db_knowledge_url'],
    ['connector-worker', 'db_connector_url'],
    ['restore-reconcile', 'db_worker_url'],
  ])('gives %s %s and no other application login', (name, url) => {
    const service = compose.services[name]!;
    expect(service.environment?.DATABASE_URL_APP_FILE).toBe(`/run/secrets/${url}`);
    const logins = secretsOf(service).filter((s) =>
      ['db_app_url', 'db_worker_url', 'db_knowledge_url', 'db_connector_url'].includes(s),
    );
    expect(logins).toEqual([url]);
  });

  it('mounts the worker passwords where roles are made, and defines every new secret', () => {
    for (const short of ['worker', 'connector', 'knowledge']) {
      expect(secretsOf(compose.services['provision-roles']!)).toContain(`db_${short}_password`);
      expect(secretsOf(compose.services.postgres!)).toContain(`db_${short}_password`);
      expect(compose.secrets).toHaveProperty(`db_${short}_password`);
      expect(compose.secrets).toHaveProperty(`db_${short}_url`);
    }
    expect(compose.services['provision-roles']!.volumes).toContain(
      './postgres/upgrade-roles-workers.sql:/provision/upgrade-roles-workers.sql:ro',
    );
    const sovereign = read('infrastructure/compose/sovereign/compose.sovereign.yaml');
    for (const short of ['worker', 'connector', 'knowledge']) {
      expect(sovereign).toContain(`db_${short}_password:`);
      expect(sovereign).toContain(`db_${short}_url:`);
    }
  });
});
