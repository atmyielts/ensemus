// ADR-028 open question 12 (project owner decision, 2026-11-09). Text checks on the reviewed _deleg
// migrations, which run with no database: the review headers, what the per-birth predicate may read, what
// the migration must never do, and that every qualification tag the capability ledger requires is the
// title of a real, unskipped integration case.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const migrations = join(repoRoot, 'packages/database/migrations');
const delegFiles = readdirSync(migrations)
  .filter((name) => /^\d{4}_.*_deleg\.sql$/.test(name))
  .sort();
const readiness = delegFiles.find((name) => name.endsWith('_delegation_birth_readiness_deleg.sql'));
const text = readiness ? readFileSync(join(migrations, readiness), 'utf8') : '';
/** SQL with `--` comments removed, so a rule is about what runs, not what a comment says. */
const code = text
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
/** The CREATE OR REPLACE of the per-birth predicate, up to the end of its body. */
const predicate = (() => {
  const start = code.indexOf('CREATE OR REPLACE FUNCTION ai.delegation_influence_ready(');
  if (start < 0) return '';
  const bodyStart = code.indexOf('AS $$', start);
  const bodyEnd = code.indexOf('$$;', bodyStart + 5);
  return code.slice(start, bodyEnd + 3);
})();

describe('the reviewed _deleg migrations (ADR-024 D4, ADR-028)', () => {
  it('include the readiness migration', () => {
    expect(readiness).toBeDefined();
  });

  it.each(delegFiles)('%s carries both review header lines, in order', (name) => {
    const [first, second] = readFileSync(join(migrations, name), 'utf8').split(/\r?\n/);
    expect(first).toBe(
      '-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-028). Changes here need human review, never agent approval.',
    );
    expect(second).toBe('-- FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person');
  });

  it('replaces the predicate in place with invoker rights and the same argument names', () => {
    expect(predicate).not.toBe('');
    expect(predicate).toMatch(
      /^CREATE OR REPLACE FUNCTION ai\.delegation_influence_ready\(p_parent uuid,p_child uuid\) RETURNS boolean/,
    );
    expect(predicate).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(predicate).toMatch(/LANGUAGE sql STABLE SET search_path=pg_catalog/);
  });

  it('reads only run, checkpoint and unproven-inventory metadata and the capability, never a body', () => {
    const body = predicate.slice(predicate.indexOf('AS $$'));
    const objects = new Set(body.match(/\bai\.[a-z_]+/g));
    expect([...objects].sort()).toEqual(
      [
        'ai.agent_runs',
        'ai.delegation_birth_capability_on',
        'ai.run_input_checkpoints',
        'ai.unproven_child_work_inputs',
      ].sort(),
    );
    for (const schema of ['work.', 'knowledge.', 'platform.', 'objects.', 'org.'])
      expect(body).not.toContain(schema);
    for (const column of [
      'title',
      'objective',
      'description',
      'body',
      'payload',
      'content',
      'prompt',
      'args',
      'value',
    ])
      expect(body, column).not.toMatch(new RegExp(`\\b${column}\\b`, 'i'));
  });

  it('records no capability, grants nothing to the app role or PUBLIC, and weakens no guard', () => {
    expect(code).not.toMatch(/INSERT\s+INTO\s+ai\.delegation_birth_capabilities/i);
    expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\b(ensemus_app|PUBLIC)\b/i);
    for (const guarded of [
      'validate_delegation_birth',
      'guard_delegation_input_birth',
      'inherited_work_inputs_readable',
      'guard_unproven_child_purge',
      'keep_unproven_child_inputs',
    ])
      expect(code).not.toMatch(
        new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+[a-z_]+\\.${guarded}\\b`, 'i'),
      );
    expect(code).not.toMatch(/\bDROP\s+POLICY\b/i);
    expect(code).not.toMatch(/\bALTER\s+POLICY\b/i);
    expect(code).not.toMatch(/\bDISABLE\s+TRIGGER\b/i);
    expect(code).not.toMatch(/\bDROP\s+TRIGGER\b/i);
    expect(code).not.toMatch(/\bDROP\s+FUNCTION\b/i);
  });

  it('opens the capability only to the agent role and keeps the ledger append-only', () => {
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION ai\.delegation_birth_capability_on\(\) TO ensemus_agent;/,
    );
    expect(code).toMatch(/ALTER TABLE ai\.delegation_birth_capabilities FORCE ROW LEVEL SECURITY;/);
    expect(code).toMatch(
      /RAISE EXCEPTION 'DELEGATION_CAPABILITY_APPEND_ONLY' USING ERRCODE='EN119'/,
    );
    expect(code).not.toMatch(/ON ai\.delegation_birth_capabilities FOR (UPDATE|DELETE|ALL)\b/i);
  });

  it('lets a fixture row count, or be appended, only where the CI marker role exists', () => {
    const reader = (() => {
      const start = code.indexOf('CREATE FUNCTION ai.delegation_birth_capability_on()');
      return code.slice(start, code.indexOf('$$;', code.indexOf('AS $$', start) + 5));
    })();
    expect(reader).toMatch(/WHERE latest\.evidence_kind='deployment_migration'/);
    expect(reader).toMatch(
      /latest\.evidence_kind='qualification_fixture' AND EXISTS\(SELECT 1 FROM pg_roles marker\s+WHERE marker\.rolname='ensemus_delegation_qualification_ci' AND NOT marker\.rolcanlogin/,
    );
    const writer = (() => {
      const start = code.indexOf('CREATE FUNCTION ai.keep_delegation_birth_capabilities()');
      return code.slice(start, code.indexOf('END $$;', start));
    })();
    expect(writer).toMatch(
      /IF NEW\.evidence_kind='qualification_fixture' AND NOT EXISTS\(SELECT 1 FROM pg_roles marker\s+WHERE marker\.rolname='ensemus_delegation_qualification_ci'/,
    );
    expect(writer).toMatch(
      /'DELEGATION_CAPABILITY_FIXTURE_OUTSIDE_QUALIFICATION' USING ERRCODE='42501'/,
    );
    // A deployment row may not cite the all-zero placeholder commit a fixture row may use.
    expect(code).toMatch(/evidence_kind<>'deployment_migration' OR source_commit !~ '\^0\{40\}\$'/);
    // The premises refuse any Ensemus role that could create the marker role.
    expect(code).toMatch(/AND\(r\.rolsuper OR r\.rolcreaterole OR r\.rolbypassrls\)\)/);
  });

  it('no migration, install script, package or worker creates or names the CI marker role', () => {
    const scan = (folder: string): string[] =>
      readdirSync(folder).flatMap((name) => {
        if (['node_modules', 'dist', '.next', '.turbo', 'coverage'].includes(name)) return [];
        const path = join(folder, name);
        if (statSync(path).isDirectory()) return scan(path);
        return /\.(ts|tsx|js|mjs|cjs|sql|sh|ya?ml|json|env|conf)$/.test(name) ? [path] : [];
      });
    const naming = ['infrastructure', 'packages', 'workers', 'apps']
      .flatMap((folder) => {
        try {
          return scan(join(repoRoot, folder));
        } catch {
          return [];
        }
      })
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        // 0590 itself names the marker to check for it; it must never create it.
        if (path === join(migrations, readiness ?? '')) return /CREATE\s+ROLE/i.test(code);
        return source.includes('ensemus_delegation_qualification_ci');
      });
    expect(naming).toEqual([]);
  });

  it('checks every column and helper the predicate reads is visible to the agent', () => {
    for (const [relation, column] of [
      ['ai.unproven_child_work_inputs', 'organization_id'],
      ['ai.unproven_child_work_inputs', 'work_unit_id'],
      ['ai.run_input_checkpoints', 'organization_id'],
      ['ai.run_input_checkpoints', 'run_id'],
      ['ai.run_input_checkpoints', 'history_complete'],
      ['ai.run_input_checkpoints', 'protocol_version'],
      ['ai.run_input_checkpoints', 'fenced_at'],
      ['ai.agent_runs', 'id'],
      ['ai.agent_runs', 'organization_id'],
      ['ai.agent_runs', 'initiator_membership_id'],
      ['ai.agent_runs', 'status'],
      ['ai.agent_runs', 'work_unit_id'],
    ])
      expect(code, `${relation}.${column}`).toContain(`('${relation}','${column}')`);
    for (const helper of [
      'app.current_actor_type()',
      'app.current_organization_id()',
      'app.current_membership_id()',
    ])
      expect(code).toContain(`has_function_privilege('ensemus_agent','${helper}','EXECUTE')`);
    // The inventory clause is a NOT EXISTS, so RLS visibility of its rows is itself a premise.
    expect(code).toMatch(/p\.polname='child_input_read'\s+AND p\.polpermissive AND p\.polcmd='r'/);
    expect(code).toMatch(/NOT p\.polpermissive AND p\.polcmd IN\('r','\*'\)/);
  });
});

describe('journal state is stated honestly (ADR-028 open question 12)', () => {
  const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const journaled = journal.entries.some((entry) =>
    entry.tag.endsWith('_delegation_birth_readiness_deleg'),
  );
  const adr = readFileSync(join(repoRoot, 'docs/00-foundation/adr/ADR-028-governed-ai.md'), 'utf8');
  const join_ = readFileSync(
    join(repoRoot, 'docs/06-delivery/evidence/m5/delegated-material-join.md'),
    'utf8',
  );
  const NOTE = 'Not runnable until the merge journals 0590.';

  it('the ADR and the join evidence carry the not-runnable note exactly while 0590 is unjournaled', () => {
    expect(adr.includes(NOTE)).toBe(!journaled);
    expect(join_.includes(NOTE)).toBe(!journaled);
  });
});

/** Every `*.test.ts` under a folder, recursively. */
function testFiles(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return testFiles(path);
    return name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('qualification tag parity (owner decision b)', () => {
  const tags = [
    ...new Set(
      (/ARRAY\['ADR028-Q12-L1'[^\]]*\]/.exec(code)?.[0] ?? '').match(/ADR028-Q12-[A-Za-z0-9]+/g),
    ),
  ];
  const integration = testFiles(join(repoRoot, 'tests/integration')).map((path) =>
    readFileSync(path, 'utf8'),
  );

  it('the ledger requires the full tag set', () => {
    expect(tags.sort()).toEqual(
      [
        'ADR028-Q12-L1',
        'ADR028-Q12-L2',
        'ADR028-Q12-L3',
        'ADR028-Q12-L4',
        'ADR028-Q12-L5',
        'ADR028-Q12-L6',
        'ADR028-Q12-L7',
        'ADR028-Q12-L8a',
        'ADR028-Q12-L8b',
        'ADR028-Q12-P2',
      ].sort(),
    );
  });

  it.each([
    'ADR028-Q12-L1',
    'ADR028-Q12-L2',
    'ADR028-Q12-L3',
    'ADR028-Q12-L4',
    'ADR028-Q12-L5',
    'ADR028-Q12-L6',
    'ADR028-Q12-L7',
    'ADR028-Q12-L8a',
    'ADR028-Q12-L8b',
    'ADR028-Q12-P2',
  ])('%s titles at least one plain it() in tests/integration', (tag) => {
    const titled = new RegExp(`\\bit\\(\\s*['\`"][^'\`"]*\\[${tag}\\][^'\`"]*['\`"]`);
    expect(integration.some((source) => titled.test(source))).toBe(true);
  });

  it('no tagged case is skipped, focused or left as a todo', () => {
    const shortcut =
      /\b(it|test|describe)\.(skip|only|todo|skipIf|runIf)\s*\(\s*['`"][^'`"]*ADR028-Q12-/;
    for (const source of integration) expect(source).not.toMatch(shortcut);
  });
});
