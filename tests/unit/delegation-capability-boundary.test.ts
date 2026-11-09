// ADR-028 open question 12, part 1. The delegation capability is deployment evidence, written only by a
// reviewed migration (or, in CI, by the integration suites through the migrator login) and read only by
// the per-birth SQL predicate. No shipped package or worker may name the ledger, its reader or the test
// helper that appends fixture rows, so no runtime path can read or turn the capability on.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const SKIP = new Set(['node_modules', 'dist', 'generated', '.next', '.turbo', 'coverage']);
function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|mjs|cjs|sql|json)$/.test(name) ? [path] : [];
  });
}
const relativeOf = (path: string) => relative(repoRoot, path).replaceAll('\\', '/');
/**
 * The only shipped mention allowed: the portability inventory names the ledger as operational_excluded,
 * which is what keeps it out of every archive and every import (assertJoinedPortabilitySchema refuses a
 * table the inventory does not name). Its own test checks that line.
 */
const INVENTORY_LINE =
  "inventory('ai.delegation_birth_capabilities', 'agents', 'operational_excluded')";
const INVENTORY_FILES = new Set([
  'packages/domain/src/portability.ts',
  'packages/domain/src/portable-definition.test.ts',
]);

describe('the delegation capability boundary', () => {
  const shipped = [
    ...sources(join(repoRoot, 'packages')).filter(
      (path) => !relativeOf(path).startsWith('packages/database/migrations/'),
    ),
    ...sources(join(repoRoot, 'workers')),
  ];

  it('finds shipped sources to check', () => {
    expect(shipped.length).toBeGreaterThan(100);
  });

  it.each([
    'delegation_birth_capabilities',
    'delegation_birth_capability_on',
    'helpers/delegation-capability',
    'ensemus_delegation_qualification_ci',
  ])('no package or worker names %s', (name) => {
    const naming = shipped
      .filter((path) => readFileSync(path, 'utf8').includes(name))
      .map(relativeOf)
      .filter((path) => !INVENTORY_FILES.has(path));
    expect(naming).toEqual([]);
  });

  it('lets the portability inventory name the ledger only to exclude it', () => {
    const inventory = readFileSync(join(repoRoot, 'packages/domain/src/portability.ts'), 'utf8');
    const mentions = inventory.split('\n').filter((line) => line.includes('delegation_birth'));
    expect(mentions.map((line) => line.trim())).toEqual([`${INVENTORY_LINE},`]);
    const test = readFileSync(
      join(repoRoot, 'packages/domain/src/portable-definition.test.ts'),
      'utf8',
    );
    expect(test).not.toMatch(/delegation_birth_capability_on/);
  });
});
