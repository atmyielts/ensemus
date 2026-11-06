// ADR-030 D4, SEC-05: the tools a customer runs cannot phone home. This reads their source, follows every import
// through the workspace, and fails on anything that can reach a network, so it needs no running system. It then
// builds them and runs one alone in an empty folder. The packet capture in SEC-05 is what proves the running
// product does not reach out, and this does not stand in for it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLE_MANIFEST_FILE, KNOWN_ROLLBACK_CONSTRAINTS } from '@ensemus/sovereign/bundle';
import {
  generateTestSigningKey,
  signForTest,
  testTrustRootText,
} from '@ensemus/sovereign/testing';
import {
  buildSovereignTools,
  NETWORK_BUILTINS,
  shippingProblems,
} from '../../workers/workflow/scripts/build-sovereign-tools.mjs';
import { repoRoot } from '../helpers/stack';

const TOOLS = join(repoRoot, 'workers/workflow/src/tools');
const SOVEREIGN = join(repoRoot, 'packages/sovereign/src');

/** Node's own modules a tool may use. A list of what is fine, so something new has to be looked at. */
const ALLOWED_BUILTINS = new Set([
  'assert',
  'buffer',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'module',
  'os',
  'path',
  'process',
  'readline',
  'stream',
  'stream/promises',
  'string_decoder',
  'timers',
  'url',
  'util',
  'zlib',
]);
const ALLOWED_PACKAGES = new Set(['zod']);
const WORKSPACE_ALLOWED = new Set(['sovereign', 'domain']);
const NETWORK_GLOBALS = new Set(['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

/** The install tool starts Docker, and nothing else may start anything. Its arguments are tested elsewhere. */
const MAY_START_PROCESSES = /workers[\\/]workflow[\\/]src[\\/]tools[\\/]install-bundle\.ts$/;

type Reach = { imports: string[]; problems: string[] };

/** What one file's code can reach. Written against the syntax tree, so a comment or a string cannot fool it. */
function reachOf(fileName: string, text: string): Reach {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2023, true);
  const imports: string[] = [];
  const problems: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly
        : node.isTypeOnly;
      if (!typeOnly) imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require');
      if (loads) {
        const [argument] = node.arguments;
        if (argument && ts.isStringLiteralLike(argument)) imports.push(argument.text);
        else problems.push('loads a module by a name it works out at run time');
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && NETWORK_GLOBALS.has(callee.text)) {
        problems.push(`calls ${callee.text}`);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      NETWORK_GLOBALS.has(node.name.text)
    ) {
      problems.push(`reaches ${node.expression.text}.${node.name.text}`);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      (node.name.text === 'binding' || node.name.text === 'dlopen')
    ) {
      problems.push(`reaches process.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, problems };
}

const isNodeModule = (specifier: string) =>
  specifier.startsWith('node:') ||
  ALLOWED_BUILTINS.has(specifier) ||
  NETWORK_BUILTINS.includes(specifier) ||
  specifier === 'child_process';

/** Whether one import is allowed from this file, and if it is ours, where to go next. */
function judgeImport(
  fileName: string,
  specifier: string,
): { problem?: string; follow?: string } {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fileName), specifier);
    const found = [`${base}.ts`, join(base, 'index.ts'), base].find((file) => existsSync(file));
    return found ? { follow: found } : { problem: `cannot find ${specifier}` };
  }
  if (specifier.startsWith('@ensemus/')) {
    const [, name, ...rest] = specifier.split('/');
    if (!WORKSPACE_ALLOWED.has(name as string)) {
      return { problem: `reaches ${specifier}, which a standalone tool may not` };
    }
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'packages', name as string, 'package.json'), 'utf8'),
    ) as { exports: Record<string, string> };
    const target = manifest.exports[rest.length ? `./${rest.join('/')}` : '.'];
    return target
      ? { follow: join(repoRoot, 'packages', name as string, target) }
      : { problem: `cannot find ${specifier}` };
  }
  if (isNodeModule(specifier)) {
    const bare = specifier.replace(/^node:/, '');
    if (bare === 'child_process') {
      return MAY_START_PROCESSES.test(fileName)
        ? {}
        : { problem: `imports ${specifier}, and only the install tool starts anything` };
    }
    return ALLOWED_BUILTINS.has(bare) ? {} : { problem: `imports ${specifier}` };
  }
  return ALLOWED_PACKAGES.has(specifier.split('/')[0] as string)
    ? {}
    : { problem: `imports the package ${specifier}` };
}

/** Everything the entry files can reach, following our own imports all the way down. */
function scan(entries: readonly string[]) {
  const seen = new Set<string>();
  const problems: string[] = [];
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const reach = reachOf(file, readFileSync(file, 'utf8'));
    const where = file.slice(repoRoot.length + 1);
    problems.push(...reach.problems.map((problem) => `${where} ${problem}`));
    for (const specifier of reach.imports) {
      const { problem, follow } = judgeImport(file, specifier);
      if (problem) problems.push(`${where} ${problem}`);
      if (follow) pending.push(follow);
    }
  }
  return { seen, problems };
}

const sourcesIn = (folder: string) =>
  readdirSync(folder)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(folder, name));

/** The same judgement on code handed in, so the controls below test what the scan really does. */
const problemsIn = (text: string, fileName = join(TOOLS, 'example.ts')) => {
  const reach = reachOf(fileName, text);
  return [
    ...reach.problems,
    ...reach.imports.flatMap((specifier) => judgeImport(fileName, specifier).problem ?? []),
  ];
};

describe('the tools and the sovereign package', () => {
  it('reach nothing that can use a network, following every import', () => {
    const { seen, problems } = scan([...sourcesIn(TOOLS), ...sourcesIn(SOVEREIGN)]);
    expect(problems).toEqual([]);
    // The walk really crossed into the domain package, and did not stop at the first folder.
    expect([...seen].some((file) => file.replaceAll('\\', '/').includes('packages/domain/'))).toBe(
      true,
    );
  });

  it('include the two this slice owns', () => {
    expect(sourcesIn(TOOLS).map((file) => file.slice(TOOLS.length + 1))).toEqual(
      expect.arrayContaining(['install-bundle.ts', 'verify-bundle.ts']),
    );
  });
});

describe('the check itself can fail', () => {
  it.each([
    ['node:net', "import net from 'node:net';"],
    ['net with no prefix', "import { connect } from 'net';"],
    ['tls', "import 'node:tls';"],
    ['http', "import http from 'node:http';"],
    ['https', "export { request } from 'node:https';"],
    ['http2', "import * as h from 'node:http2';"],
    ['dns', "import dns from 'node:dns/promises';"],
    ['dgram', "import 'dgram';"],
    ['a builtin nobody has looked at', "import 'node:worker_threads';"],
    ['the database package', "import { x } from '@ensemus/database';"],
    ['the storage package', "import { x } from '@ensemus/storage';"],
    ['Temporal', "import { x } from '@temporalio/client';"],
    ['a third-party client', "import axios from 'axios';"],
    ['pg', "import pg from 'pg';"],
    ['fetch', "await fetch('https://example.invalid');"],
    ['globalThis.fetch', "await globalThis.fetch('https://example.invalid');"],
    ['a WebSocket', "new WebSocket('wss://example.invalid');"],
    ['a dynamic import', "await import('node:http');"],
    ['a require', "require('https');"],
    ['an import worked out at run time', "const m = 'net'; await import('node:' + m);"],
    ['a require worked out at run time', 'require(name);'],
    ['process.binding', "process.binding('tcp_wrap');"],
    ['starting a process outside the install tool', "import { spawn } from 'node:child_process';"],
  ])('flags %s', (_label, code) => {
    expect(problemsIn(code).length).toBeGreaterThan(0);
  });

  it.each([
    ['a comment', "// import net from 'node:net'; fetch('x')\nexport const a = 1;"],
    ['a string', "export const a = 'fetch(1) from node:http';"],
    ['a type-only import', "import type { Socket } from 'node:net';\nexport const a = 1;"],
    ['crypto and files', "import 'node:crypto'; import 'node:fs/promises'; import 'zod';"],
  ])('leaves %s alone', (_label, code) => {
    expect(problemsIn(code)).toEqual([]);
  });

  it('lets only the install tool start a process', () => {
    const code = "import { spawn } from 'node:child_process';";
    expect(problemsIn(code, join(TOOLS, 'install-bundle.ts'))).toEqual([]);
    expect(problemsIn(code, join(TOOLS, 'verify-bundle.ts')).length).toBeGreaterThan(0);
  });

  it('gives the install tool only Docker to start', () => {
    const text = readFileSync(join(TOOLS, 'install-bundle.ts'), 'utf8');
    const spawned = [...text.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*'?([^',\s]+)/g)];
    expect(spawned.map((match) => match[1])).toEqual(['docker']);
    expect(text).not.toMatch(/shell:\s*true/);
  });
});

describe('the build refuses what must not ship', () => {
  const meta = (inputs: string[], imports: { path: string; external: boolean }[], output = 'x.mjs') => ({
    inputs: Object.fromEntries(inputs.map((input) => [input, {}])),
    outputs: { [`dist/tools/${output}`]: { imports } },
  });

  it.each([
    ['the issuer', meta(['../../packages/sovereign/src/issuer.ts'], [])],
    ['test keys', meta(['../../packages/sovereign/src/testing.ts'], [])],
    ['the database', meta(['../../packages/database/src/index.ts'], [])],
    ['a network module', meta([], [{ path: 'node:https', external: true }])],
    ['dns by subpath', meta([], [{ path: 'node:dns/promises', external: true }])],
    ['a package left to find at run time', meta([], [{ path: 'left-out', external: true }])],
    ['a process from the wrong tool', meta([], [{ path: 'node:child_process', external: true }])],
  ])('refuses %s', (_label, metafile) => {
    expect(shippingProblems(metafile).length).toBeGreaterThan(0);
  });

  it('accepts what a tool is meant to use', () => {
    expect(
      shippingProblems(
        meta(
          ['../../packages/sovereign/src/bundle.ts', '../../packages/domain/src/license.ts'],
          [
            { path: 'node:fs', external: true },
            { path: 'node:child_process', external: true },
          ],
          'install-bundle.mjs',
        ),
      ),
    ).toEqual([]);
  });
});

describe('a built tool, alone in an empty folder', () => {
  const key = generateTestSigningKey('bundle-key');
  let out: string;
  let bundle: string;
  let trustRoot: string;
  let built: string[];

  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'ensemus-tools-'));
    built = await buildSovereignTools({ outdir: out });
    bundle = mkdtempSync(join(tmpdir(), 'ensemus-tools-bundle-'));
    trustRoot = join(tmpdir(), `ensemus-tools-root-${sha256(bundle).slice(0, 12)}.json`);
    writeFileSync(trustRoot, testTrustRootText([key]));
    writeFileSync(join(bundle, 'web.tar'), 'archive');
    writeFileSync(join(bundle, 'compose.yaml'), 'services: {}\n');
    writeFileSync(
      join(bundle, BUNDLE_MANIFEST_FILE),
      signForTest(
        'bundle',
        {
          format: 'ensemus.bundle',
          format_version: 1,
          bundle_id: '6f1c2c6e-3333-4333-8333-333333333333',
          issued_at: '2027-01-01T00:00:00.000Z',
          release: {
            version: '2.0.1',
            line: '2.0',
            kind: 'patch',
            security: false,
            published_on: '2027-01-01',
            git_commit: 'b'.repeat(40),
          },
          files: [
            { path: 'web.tar', sha256: sha256('archive'), bytes: 7, role: 'image' },
            {
              path: 'compose.yaml',
              sha256: sha256('services: {}\n'),
              bytes: 13,
              role: 'compose',
            },
          ],
          images: [{ name: 'web', digest: `sha256:${'a'.repeat(64)}`, file: 'web.tar' }],
          compatibility: {
            upgrade_from: [],
            rollback_to: [],
            rollback_constraints: [],
            database_schema_version: '0301_sovereign_security.sql',
            workflow_compatibility: 'replay corpus of this release',
            node_version: '24',
          },
          models: [],
        },
        [key],
      ),
    );
  }, 60_000);

  afterAll(() => {
    for (const path of [out, bundle, trustRoot]) rmSync(path, { recursive: true, force: true });
  });

  const run = (tool: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(out, tool), ...args], { cwd: out, encoding: 'utf8' });

  it('builds both, as one file each', () => {
    expect(built).toEqual(expect.arrayContaining(['install-bundle.mjs', 'verify-bundle.mjs']));
  });

  it('accepts a good bundle with no node_modules anywhere near it', () => {
    const result = run('verify-bundle.mjs', bundle, '--trust-root', trustRoot);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('accepted');
  });

  it('runs once, so a tool built from shared code cannot run another by accident', () => {
    const result = run('verify-bundle.mjs', bundle, '--trust-root', trustRoot);
    expect(result.stdout.match(/accepted/g)).toHaveLength(1);
  });

  it('refuses with a code and a non-zero exit', () => {
    const planted = join(bundle, 'planted.txt');
    writeFileSync(planted, 'x');
    const result = run('verify-bundle.mjs', bundle, '--trust-root', trustRoot);
    rmSync(planted);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FILE_NOT_LISTED');
  });

  it('prints its usage for a bad argument, with exit 2', () => {
    const result = run('verify-bundle.mjs');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--trust-root');
  });

  it('holds no vendor key material, and no address to call', () => {
    for (const tool of built) {
      const text = readFileSync(join(out, tool), 'utf8');
      expect(text).not.toContain('PRIVATE KEY-----');
      expect(text).not.toMatch(/generateTestSigningKey|createRehearsalFileSigner/);
    }
  });

  it('dry-runs the install tool without Docker, whatever is on this machine', () => {
    // No compose files in this small bundle, so it refuses before planning. That is enough to show the
    // tool starts, verifies and answers with no Docker involved: the plan itself is tested with a double.
    const result = run(
      'install-bundle.mjs',
      bundle,
      '--trust-root',
      trustRoot,
      '--state-dir',
      join(out, 'state'),
      '--dry-run',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('COMPOSE_FILES_NOT_LISTED');
    expect(existsSync(join(out, 'state'))).toBe(false);
  });
});

describe('the words around them', () => {
  const DOCS = [
    'docs/05-operations/sovereign/offline-bundle.md',
    'docs/05-operations/sovereign/upgrade-and-rollback.md',
    'infrastructure/compose/sovereign/README.md',
  ];
  const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');
  const guide = () => read('docs/05-operations/sovereign/upgrade-and-rollback.md');

  it.each(DOCS)('%s makes no claim of being ready for an air gap', (file) => {
    expect(read(file)).not.toMatch(
      /air[- ]?gap(ped)?[- ](ready|readiness|certified|compliant|capable|proven|tested|safe)/i,
    );
  });

  it('explains every rollback code the tools know', () => {
    for (const code of Object.keys(KNOWN_ROLLBACK_CONSTRAINTS)) {
      expect(guide()).toContain(`\`${code}\``);
    }
  });

  it('says the four things an operator must not find out late', () => {
    const text = guide();
    expect(text).toMatch(/back up first/i);
    expect(text).toMatch(/migrations are not undone/i);
    expect(text).toMatch(/rollback means restoring/i);
    expect(text).toMatch(/does not unhappen/i);
  });

  it('carries the runbook’s drain rule', () => {
    expect(guide()).toMatch(/plan runs must drain/i);
    expect(guide()).toContain('0004');
  });
});
