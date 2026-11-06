// ADR-034: each state machine exists in code and in reviewed SQL, since the web and the worker share a role, and
// the contracts and OpenAPI repeat their names. These keep every copy the same.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installationStateSchema,
  isolationEvidenceSchema,
  listingStateSchema,
  sandboxRunStatusSchema,
  skillBundleSchema,
  skillManifestSchema,
  skillPathSchema,
  skillVersionStateSchema,
  submissionStateSchema,
} from '@ensemus/contracts/skills';
import {
  INSTALLATION_STATES,
  INSTALLATION_TRANSITIONS,
  LISTING_STATES,
  REVIEW_CHECKS,
  SUBMISSION_STATES,
  SUBMISSION_TRANSITIONS,
} from '@ensemus/domain/marketplace';
import {
  ISOLATION_EVIDENCE,
  SANDBOX_RUN_STATUSES,
  SANDBOX_RUN_TRANSITIONS,
} from '@ensemus/domain/sandbox';
import { SKILL_VERSION_STATES, SKILL_VERSION_TRANSITIONS } from '@ensemus/domain/skill';
import { spec } from '../helpers/openapi';
import { repoRoot } from '../helpers/stack';

const security = readFileSync(
  join(repoRoot, 'packages/database/migrations/0651_skills_sandbox_marketplace_security.sql'),
  'utf8',
);
const tables = readFileSync(
  join(repoRoot, 'packages/database/migrations/0650_skills_sandbox_marketplace.sql'),
  'utf8',
);

/** Finds one trigger function's state table, by the column it reads, and turns it back into data. */
function transitionsIn(functionName: string, column: string) {
  const start = security.indexOf(`CREATE FUNCTION ${functionName}()`);
  expect(start, functionName).toBeGreaterThan(-1);
  const body = security.slice(start, security.indexOf('END $$;', start));
  return Object.fromEntries(
    [...body.matchAll(new RegExp(`WHEN '([a-z_]+)' THEN NEW\\.${column} IN \\(([^)]+)\\)`, 'g'))].map(
      ([, from, to]) => [from, (to ?? '').split(',').map((state) => state.trim().replaceAll("'", ''))],
    ),
  );
}

const moving = (table: Record<string, readonly string[]>) =>
  Object.fromEntries(Object.entries(table).filter(([, to]) => to.length > 0));

describe('the state machines', () => {
  it.each([
    ['skill versions', 'skills.check_version_change', 'state', SKILL_VERSION_TRANSITIONS],
    ['sandbox runs', 'sandbox.check_run_change', 'status', SANDBOX_RUN_TRANSITIONS],
    ['submissions', 'marketplace.check_submission_change', 'state', SUBMISSION_TRANSITIONS],
    ['installations', 'marketplace.check_installation_change', 'state', INSTALLATION_TRANSITIONS],
  ] as const)('%s are the same table in the domain and in the trigger', (_, fn, column, table) => {
    const inSql = transitionsIn(fn, column);
    expect(moving(table as Record<string, readonly string[]>)).toEqual(inSql);
  });

  it('let nothing go back from an end', () => {
    expect(SKILL_VERSION_TRANSITIONS.published).toEqual(['yanked']);
    expect(SKILL_VERSION_TRANSITIONS.yanked).toEqual([]);
    expect(SKILL_VERSION_TRANSITIONS.rejected).toEqual([]);
    expect(SUBMISSION_TRANSITIONS.rejected).toEqual([]);
    expect(INSTALLATION_TRANSITIONS.removed).toEqual([]);
  });
});

describe('the names', () => {
  const schemas = spec.components.schemas as unknown as Record<string, { enum: string[] }>;
  const enumInTable = (constraint: string, column: string) =>
    new RegExp(`"${column}" in \\('([^)]+)'\\)`)
      .exec(tables.slice(tables.indexOf(constraint)))?.[1]
      ?.split("','");

  it('are the same in the domain, the table, the contract and the API', () => {
    expect(enumInTable('skill_versions_state', 'state')).toEqual([...SKILL_VERSION_STATES]);
    expect(skillVersionStateSchema.options).toEqual([...SKILL_VERSION_STATES]);
    expect(schemas.SkillVersionState?.enum).toEqual([...SKILL_VERSION_STATES]);

    expect(enumInTable('sandbox_runs_status', 'status')).toEqual([...SANDBOX_RUN_STATUSES]);
    expect(sandboxRunStatusSchema.options).toEqual([...SANDBOX_RUN_STATUSES]);
    expect(schemas.SandboxRunStatus?.enum).toEqual([...SANDBOX_RUN_STATUSES]);

    expect(enumInTable('marketplace_submissions_state', 'state')).toEqual([...SUBMISSION_STATES]);
    expect(submissionStateSchema.options).toEqual([...SUBMISSION_STATES]);

    expect(enumInTable('marketplace_listings_state', 'state')).toEqual([...LISTING_STATES]);
    expect(listingStateSchema.options).toEqual([...LISTING_STATES]);

    expect(enumInTable('marketplace_installations_state', 'state')).toEqual([
      ...INSTALLATION_STATES,
    ]);
    expect(installationStateSchema.options).toEqual([...INSTALLATION_STATES]);
  });

  it('have no word for isolated anywhere a person or an API could read it', () => {
    expect(isolationEvidenceSchema.options).toEqual([...ISOLATION_EVIDENCE]);
    expect(schemas.IsolationEvidence?.enum).toEqual([...ISOLATION_EVIDENCE]);
    for (const value of ISOLATION_EVIDENCE) expect(value).not.toMatch(/isolat|secure|safe/i);
  });

  it('counts the review checks the trigger counts', () => {
    expect(security).toContain(`jsonb_object_keys(NEW.checks)) < ${REVIEW_CHECKS.length}`);
  });
});

const validManifest = {
  schema_version: 1,
  name: 'a-skill',
  version: '1.0.0',
  display_name: 'A skill',
  summary: 'A summary.',
  license: 'MIT',
  instructions: 'instructions.md',
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  tool_boundaries: [],
  max_classification: 'internal',
  dependencies: [],
  execution: {
    kind: 'sandbox',
    runtime: 'node24',
    entry: 'main.mjs',
    network: { mode: 'none' },
    limits: { wall_ms: 1000, cpu_ms: 1000, memory_mb: 64, tmpfs_mb: 1, output_kb: 16, pids: 4 },
  },
  tests: [{ name: 'one', input: 'in.json', expected_output: 'out.json' }],
  files: [{ path: 'instructions.md', sha256: 'a'.repeat(64), size_bytes: 1 }],
};

describe('what cannot be said in this milestone', () => {
  it('has no price, plan or payment in the tables or the API', () => {
    const paths = JSON.stringify(
      Object.entries(spec.paths).filter(([path]) => /marketplace|skill|sandbox/.test(path)),
    );
    for (const text of [tables, paths]) {
      expect(text).not.toMatch(/\b(price|amount|currency|payment|invoice|billing|subscription)\b/i);
    }
  });

  it('has no way to ask for a network', () => {
    expect(skillManifestSchema.safeParse(validManifest).success).toBe(true);
    const asking = {
      ...validManifest,
      execution: { ...validManifest.execution, network: { mode: 'open' } },
    };
    expect(skillManifestSchema.safeParse(asking).success).toBe(false);
  });

  it('has no way to ask for restricted data', () => {
    const asking = { ...validManifest, max_classification: 'restricted' };
    expect(skillManifestSchema.safeParse(asking).success).toBe(false);
  });
});

describe('what a manifest can name', () => {
  it.each([
    ['a parent directory', '../evil'],
    ['a parent in the middle', 'a/../../evil'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash', 'a\\b'],
    ['a drive', 'C:/x'],
    ['a hidden file', '.env'],
    ['a hidden directory', 'a/.ssh/key'],
    ['a null byte', 'a\0b'],
    ['an empty part', 'a//b'],
    ['a trailing slash', 'a/'],
  ])('refuses a file at %s', (_, path) => {
    expect(skillPathSchema.safeParse(path).success, path).toBe(false);
  });

  it.each([
    ['a pattern, which would compile what a stranger wrote', { pattern: '(a+)+$' }],
    ['a reference, which could reach anywhere', { $ref: 'https://example.invalid/x' }],
    ['a format', { format: 'email' }],
    ['anything it has not heard of', { allOf: [] }],
    ['any of those further in', { properties: { a: { pattern: 'x' } } }],
    ['any of those inside items', { items: { $ref: 'x' } }],
  ])('refuses a schema with %s', (_, schema) => {
    expect(skillManifestSchema.safeParse({ ...validManifest, input_schema: schema }).success).toBe(
      false,
    );
  });

  it('refuses the same file twice', () => {
    const file = { path: 'a.md', sha256: 'a'.repeat(64), size_bytes: 1 };
    expect(skillManifestSchema.safeParse({ ...validManifest, files: [file, file] }).success).toBe(
      false,
    );
  });

  it('refuses a schema deep enough to be a problem', () => {
    let deep: Record<string, unknown> = { type: 'object' };
    for (let i = 0; i < 20; i++) deep = { type: 'object', properties: { a: deep } };
    expect(skillManifestSchema.safeParse({ ...validManifest, input_schema: deep }).success).toBe(
      false,
    );
  });

  it('refuses extra fields on the bundle, so a signature covers all there is', () => {
    const bundle = {
      format: 'ensemus.skill.bundle.v1',
      manifest: validManifest,
      files: [],
      signature: { algorithm: 'ed25519', key_id: 'a'.repeat(64), value_base64: 'AAAA' },
    };
    expect(skillBundleSchema.safeParse(bundle).success).toBe(true);
    expect(skillBundleSchema.safeParse({ ...bundle, extra: true }).success).toBe(false);
  });
});
