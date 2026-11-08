// ADR-030 D3: the issuing tool and the test keys have no path into any image. Lint refuses the import by
// name, and this is the same promise checked from the other end: it follows every import from everything we
// build, reading source files, and fails if `issuer`, its command line or `testing` can be reached by any
// route, relative imports and other packages included. So a private key has no way in, however it is spelt.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs'];
const VENDOR_ONLY = [
  'packages/sovereign/src/issuer.ts',
  'packages/sovereign/src/issuer-cli.ts',
  'packages/sovereign/src/testing.ts',
];

function asFile(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const extension of SOURCE_EXTENSIONS) {
    if (existsSync(base + extension)) return base + extension;
    const index = join(base, `index${extension}`);
    if (existsSync(index)) return index;
  }
  // A `.js` import that means the `.ts` beside it.
  if (base.endsWith('.js')) return asFile(base.slice(0, -3));
  return null;
}

/** Where an import leads in this repository, or null for a third-party package. */
function resolveImport(specifier: string, from: string): string | null {
  if (specifier.startsWith('.')) return asFile(resolve(dirname(from), specifier));
  if (specifier.startsWith('@/')) {
    return asFile(join(repoRoot, 'apps/web/src', specifier.slice(2)));
  }
  if (!specifier.startsWith('@ensemus/')) return null;
  // Follow actual Node package exports, including subpath patterns. A literal-only map silently
  // disagrees with valid wildcard exports; a missing real export must still fail this boundary check.
  try {
    return createRequire(from).resolve(specifier);
  } catch (cause) {
    throw new Error(`Nothing exports ${specifier}, imported by ${from}`, { cause });
  }
}

/** Every file reachable from these, with the route to each, so a failure says how it got there. */
function walk(entries: readonly string[]) {
  const routes = new Map<string, string[]>();
  const queue = entries.map((entry) => [entry, [entry]] as const);
  while (queue.length > 0) {
    const [file, route] = queue.pop() as (typeof queue)[number];
    if (routes.has(file)) continue;
    routes.set(file, route);
    // TypeScript's own scanner, so comments are not imports and `export ... from` and `import()` are.
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName } of importedFiles) {
      const target = resolveImport(fileName, file);
      if (target && !routes.has(target)) queue.push([target, [...route, target]]);
    }
  }
  return routes;
}

const pathFromRoot = (file: string) => relative(repoRoot, file).replaceAll('\\', '/');

function reachedVendorCode(routes: ReadonlyMap<string, readonly string[]>) {
  return [...routes.entries()]
    .filter(([file]) => VENDOR_ONLY.includes(pathFromRoot(file)))
    .map(([, route]) => route.map(pathFromRoot).join(' -> '));
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

const isTest = (file: string) => /\.(test|spec)\.[cm]?tsx?$/.test(file);

/** The build script itself, read as text, so a new entry point is checked the moment it is added. */
function entriesOfWorkerBuild() {
  const root = join(repoRoot, 'workers/workflow');
  const script = readFileSync(join(root, 'scripts/build.mjs'), 'utf8');
  const named = [...script.matchAll(/'(src\/[^']+\.ts)'/g)].map((match) =>
    join(root, match[1] as string),
  );
  const elsewhere = [...script.matchAll(/'(\.\.\/\.\.\/packages\/[^']+\.ts)'/g)].map((match) =>
    resolve(root, match[1] as string),
  );
  return [...named, ...elsewhere];
}

describe('the vendor side stays out of every image', () => {
  it('finds the worker build entries it is meant to check', () => {
    const entries = entriesOfWorkerBuild().map(pathFromRoot);
    for (const expected of [
      'workers/workflow/src/main.ts',
      'workers/workflow/src/dispatcher.ts',
      'workers/workflow/src/diagnostics-export.ts',
      'workers/workflow/src/sovereign-license.ts',
      'packages/workflows/src/failure-converter.ts',
      'packages/workflows/src/workflows.ts',
    ]) {
      expect(entries).toContain(expected);
    }
    for (const entry of entriesOfWorkerBuild()) expect(existsSync(entry)).toBe(true);
  });

  it('cannot be reached from any worker build entry', () => {
    const routes = walk(entriesOfWorkerBuild());
    // Enough of the tree was walked to mean something, so a broken walk cannot pass by finding nothing.
    expect(routes.size).toBeGreaterThan(50);
    expect(reachedVendorCode(routes)).toEqual([]);
  });

  it('cannot be reached from the web tier', () => {
    const entries = filesUnder(join(repoRoot, 'apps/web/src')).filter((file) => !isTest(file));
    expect(entries.length).toBeGreaterThan(20);
    expect(reachedVendorCode(walk(entries))).toEqual([]);
  });

  it('cannot be reached from the tools a customer runs', () => {
    const entries = filesUnder(join(repoRoot, 'workers/workflow/src/tools'));
    expect(entries.map(pathFromRoot)).toEqual(
      expect.arrayContaining([
        'workers/workflow/src/tools/recipient-key.ts',
        'workers/workflow/src/tools/open-archive.ts',
      ]),
    );
    expect(reachedVendorCode(walk(entries))).toEqual([]);
  });

  it('would notice if it could be: the walk does reach it from its own command line', () => {
    const routes = walk([join(repoRoot, 'packages/sovereign/src/issuer-cli.ts')]);
    expect(reachedVendorCode(routes).join('\n')).toContain('packages/sovereign/src/issuer.ts');
  });

  it('would notice a route through another package', () => {
    // verify.ts is what the web tier may use, and the walk has to follow a package name to find it.
    const routes = walk([join(repoRoot, 'packages/sovereign/src/issuer.ts')]);
    expect(routes.has(resolve(repoRoot, 'packages/domain/src/license.ts'))).toBe(true);
  });

  it('is not built by anything that makes an image', () => {
    const dockerfiles = readdirSync(join(repoRoot, 'infrastructure/containers')).map((name) =>
      readFileSync(join(repoRoot, 'infrastructure/containers', name), 'utf8'),
    );
    for (const text of dockerfiles) expect(text).not.toMatch(/build-issuer|issuer-cli|issuer\.mjs/);
    const build = readFileSync(join(repoRoot, 'workers/workflow/scripts/build.mjs'), 'utf8');
    expect(build).not.toMatch(/issuer/);
  });

  it('builds to a folder no image takes and git ignores', () => {
    const script = readFileSync(
      join(repoRoot, 'workers/workflow/scripts/build-issuer.mjs'),
      'utf8',
    );
    expect(script).toContain("'.local'");
    expect(readFileSync(join(repoRoot, '.dockerignore'), 'utf8').split('\n')).toContain('.local');
    expect(readFileSync(join(repoRoot, '.gitignore'), 'utf8').split('\n')).toContain('.local/');
  });
});
