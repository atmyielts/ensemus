// A lapse, a wrong clock or a bad file changes what an administrator reads, and can never refuse a request
// (ADR-030 D2, SOV-02). The types already have no field that says "stop". This holds the other half: what
// answers about a license is reachable only from the pages that show it, so nothing can start branching on
// it by accident. M8 adds itself here for readVerifiedLicenseFacts at the final merge, and for nothing else.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STATUS_READERS = [
  'getLicenseStatus',
  'listAdvisories',
  'licenseNotices',
  'maintenanceStatus',
  'readVerifiedLicenseFacts',
  'licenseStatusFromDocuments',
  'advisoriesFromDocuments',
] as const;

const ALLOWED: readonly RegExp[] = [
  /^packages\/application\/src\/licensing\.ts$/,
  /^packages\/domain\/src\/license\.ts$/,
  // The web tier's own routes and pages for showing it, and nothing else in the app folder.
  /^apps\/web\/src\/app\/(.+\/)?(license|advisories|data)\//,
  /^apps\/web\/src\/server\/sovereign-[^/]+\.ts$/,
  /^workers\/workflow\/src\/sovereign-license-command\.ts$/,
];

type Source = { path: string; text: string };

const NAMED = new RegExp(`\\b(${STATUS_READERS.join('|')})\\b`);

/** Which files name a status reader without being on the list. Comments count: they are easy to fix. */
function violationsIn(sources: readonly Source[]): string[] {
  return sources
    .filter(({ path, text }) => NAMED.test(text) && !ALLOWED.some((rule) => rule.test(path)))
    .map(({ path }) => path);
}

const SKIP_FOLDERS = new Set(['node_modules', '.next', 'dist', 'generated', 'migrations']);

function sourcesUnder(folder: string): Source[] {
  const found: Source[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        if (!SKIP_FOLDERS.has(name)) walk(path);
      } else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        found.push({
          path: relative(root, path).split(sep).join('/'),
          text: readFileSync(path, 'utf8'),
        });
      }
    }
  };
  walk(join(root, folder));
  return found;
}

describe('nothing can use a license as a gate', () => {
  const shipped = ['apps', 'packages', 'workers'].flatMap(sourcesUnder);

  it('reads the source it means to read', () => {
    const paths = shipped.map(({ path }) => path);
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toContain('packages/application/src/licensing.ts');
    expect(paths).toContain('apps/web/src/server/tenant.ts');
    expect(paths).toContain('packages/workflows/src/workflows.ts');
  });

  it('names what answers about a license only on the allowlist', () => {
    expect(violationsIn(shipped)).toEqual([]);
  });

  it.each([
    ['the check on every page', 'apps/web/src/server/tenant.ts'],
    ['the check on every API route', 'apps/web/src/server/api.ts'],
    ['the workflow worker', 'workers/workflow/src/main.ts'],
    ['the dispatcher', 'workers/workflow/src/dispatcher.ts'],
    ['the connector worker', 'workers/workflow/src/connector-worker.ts'],
    ['the workflows', 'packages/workflows/src/workflows.ts'],
    ['the activities', 'packages/workflows/src/activities.ts'],
  ])('keeps %s free of the license domain altogether', (_name, path) => {
    const text = readFileSync(join(root, path), 'utf8');
    expect(text).not.toMatch(NAMED);
    expect(text).not.toContain('@ensemus/domain/license');
    expect(text).not.toMatch(/\bLicenseStanding\b|\bLicenseNotice\b/);
  });

  it('keeps every workflow file free of the license domain', () => {
    const workflows = sourcesUnder('packages/workflows/src');
    expect(workflows.length).toBeGreaterThan(3);
    for (const { path, text } of workflows) {
      expect(text, path).not.toMatch(NAMED);
      expect(text, path).not.toContain('@ensemus/domain/license');
    }
  });

  it('keeps any request middleware free of it, if one is ever added', () => {
    for (const name of ['middleware.ts', 'proxy.ts']) {
      for (const folder of ['apps/web', 'apps/web/src']) {
        const path = join(root, folder, name);
        if (existsSync(path)) {
          expect(readFileSync(path, 'utf8'), path).not.toMatch(NAMED);
        }
      }
    }
  });

  it('would catch one, so the check above means something', () => {
    const planted = (path: string): Source => ({
      path,
      text: "if ((await getLicenseStatus(db, ctx, deps)).standing !== 'licensed') throw new Error();",
    });
    expect(
      violationsIn([
        planted('apps/web/src/server/tenant.ts'),
        planted('apps/web/src/server/api.ts'),
        planted('apps/web/src/app/o/[organizationId]/work/page.tsx'),
        planted('apps/web/src/components/license-banner.tsx'),
        planted('apps/web/src/middleware.ts'),
        planted('packages/workflows/src/workflows.ts'),
        planted('workers/workflow/src/sovereign-license.ts'),
      ]),
    ).toHaveLength(7);
    expect(
      violationsIn([
        planted('packages/application/src/licensing.ts'),
        planted('apps/web/src/app/o/[organizationId]/license/page.tsx'),
        planted('apps/web/src/app/o/[organizationId]/data/page.tsx'),
        planted('apps/web/src/app/api/v1/organizations/[organizationId]/license/route.ts'),
        planted('apps/web/src/app/api/v1/organizations/[organizationId]/advisories/route.ts'),
        planted('apps/web/src/server/sovereign-runtime.ts'),
        planted('workers/workflow/src/sovereign-license-command.ts'),
      ]),
    ).toEqual([]);
  });
});
