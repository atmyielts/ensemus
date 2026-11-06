// An ID from a form or a request is put in the database's spelling as it comes in (see
// packages/application/src/ids.ts). These read the code, so that a new field cannot quietly skip it.
// tests/stack/product-flows.test.ts sends one in capitals through a real form and a real route.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

function sourcesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const webSources = sourcesUnder(join(repoRoot, 'apps/web/src'));
const applicationSources = sourcesUnder(join(repoRoot, 'packages/application/src'));

describe('where IDs come in', () => {
  it('reads every ID field of a form through the helper that spells it one way', () => {
    const raw = webSources.flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/\b(?:text|field)\(form, '(id|\w*Id)'\)/g)].map(
        (match) => `${relative(repoRoot, path)}: ${match[0]}`,
      ),
    );
    expect(raw).toEqual([]);
  });

  it('checks every ID against the schema that spells it one way', () => {
    const raw = [...webSources, ...applicationSources]
      .filter((path) => !path.endsWith('ids.ts'))
      .filter((path) => /\bz\.uuid\(\)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(repoRoot, path));
    expect(raw).toEqual([]);
  });

  it('uses that helper on the forms, so the check above has something to find', () => {
    const actions = readFileSync(join(repoRoot, 'apps/web/src/server/work-actions.ts'), 'utf8');
    expect(actions).toContain("idOf(form, 'approverMembershipId')");
    expect(actions).toContain("idOf(form, 'reviewerMembershipId')");
  });
});
